// Minimal indexer
//
// Runs each adapter on a fixed interval, wraps every run in try/catch, and
// writes the outcome to Postgres (via @stenion/db): safetyScore + factors +
// timestamps on success, or a failed marker on error. No backfill, ever.
//
// It retries a failing protocol within a wall-clock budget and notifies a
// webhook when one fails N consecutive cycles (see ./retry and ./alerts). That
// makes failures LOUDER AND RARER — it does not change what a failure is:
// adapters still throw, the indexer still catches, and a run that ultimately
// fails is still recorded as `failed`. A protocol that is genuinely down still
// shows as down.
//
// All configuration comes from validated env (see config.ts) — no silent
// fallbacks for the RPC/Horizon/pool that decide what and where we index, and
// DATABASE_URL is validated up front too. Error model matches the Adapter
// contract: adapters throw, the indexer catches per-run so one protocol
// failing never aborts the cycle or process; a DB write failure is likewise
// caught and logged so it can't kill the loop.

import {
  AQUARIUS_POOLS,
  AquariusAdapter,
  BLEND_POOLS,
  BlendAdapter,
  KineticAdapter,
} from '@stenion/adapters';
import { closePool, createStore, getPool, type Store } from '@stenion/db';

import { webhookNotifier } from './alerts';
import { ConfigError, loadConfig, type IndexerConfig } from './config';
import {
  cycleFeasibility,
  feasibilityWarning,
  orderByLatency,
  runCycle,
  toTarget,
  type CycleOptions,
  type IndexTarget,
} from './cycle';

// The run loop itself lives in ./cycle so it can be tested without this file's
// CLI concerns (the require.main guard below is CommonJS-only). Re-exported here
// because @stenion/indexer's entry point is this module — the package's public
// surface is unchanged.
export {
  cycleFeasibility,
  feasibilityWarning,
  orderByLatency,
  runCycle,
  targetDeadline,
  toTarget,
} from './cycle';
export type {
  CycleFeasibility,
  CycleOptions,
  CycleRunResult,
  CycleSummary,
  IndexTarget,
} from './cycle';
export type { StreakAlert } from './alerts';
import type { CycleSummary } from './cycle';

function buildTargets(config: IndexerConfig): IndexTarget[] {
  // Which pools exist is deliberately NOT environment config — it is the
  // adapter's own BLEND_POOLS registry, reviewed in a PR alongside the pool's
  // identity metadata. Point an instance at a test/testnet pool by passing a
  // BlendPool to the constructor; there is no env var that can silently change
  // what the public registry is scoring.
  //
  // One BlendAdapter instance PER POOL, all running the same engine: the shared
  // scoring code is the class, and what differs is only the pool it was handed.
  // Iterating BLEND_POOLS rather than naming pools here means adding a market
  // touches one list, in adapters, and nothing in the indexer.
  const blend = BLEND_POOLS.map((pool) =>
    toTarget(
      new BlendAdapter({
        rpcUrl: config.rpcUrl,
        horizonUrl: config.horizonUrl,
        pool,
      }),
    ),
  );
  // Kinetic (K2) — the genuinely-independent protocol, not a Blend pool. Same
  // run loop via the toTarget<T> wrapper (its TRawData differs from Blend's, so
  // the list can't be typed Adapter<unknown>[] directly — that's what the
  // wrapper is for).
  const kinetic = new KineticAdapter({
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
  });
  // Aquarius (#104) — the first `dex` target, and the first target of any
  // category other than lending. Same list-driven shape as BLEND_POOLS and for
  // the same reason: every Aquarius market runs one of three wasms the router
  // itself declares, so a second market is an entry in AQUARIUS_POOLS and no
  // code here. One is registered today, and the ceiling is the cycle budget
  // rather than the census — see AQUARIUS_POOLS and the feasibility warning
  // below.
  const aquarius = AQUARIUS_POOLS.map((pool) =>
    toTarget(
      new AquariusAdapter({
        rpcUrl: config.rpcUrl,
        horizonUrl: config.horizonUrl,
        pool,
      }),
    ),
  );
  // Slowest first — see `orderByLatency` in ./cycle for why that is the right
  // way round under a worker pool, and why it used to be the other way.
  return orderByLatency([...blend, toTarget(kinetic), ...aquarius]);
}

/**
 * Build the targets, connect, and upsert protocol metadata (idempotent). Shared
 * by the standalone loop (main) and the single-cycle entry point (runIndexerCycle).
 * Throws on a bad DATABASE_URL / unreachable DB — callers decide how to report it.
 */
async function prepare(config: IndexerConfig): Promise<{ targets: IndexTarget[]; store: Store }> {
  const targets = buildTargets(config);
  const store = createStore(getPool());
  // Protocol metadata is static, so upsert once here; the run loop only appends
  // scores.
  for (const target of targets) {
    await store.upsertProtocol(target.metadata);
  }
  return { targets, store };
}

/**
 * Turn validated env into the run loop's injected behaviour. This is the only
 * place config and the run loop meet — cycle.ts reaches for no env of its own,
 * which is what keeps its retry and alerting logic testable.
 *
 * With STENION_ALERT_WEBHOOK_URL unset (the default) there is no notifier, so
 * alerting is off while retries and failed-run recording carry on exactly as
 * before. Alerting is the optional half.
 */
function cycleOptions(config: IndexerConfig): CycleOptions {
  return {
    retry: {
      attempts: config.retryAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      attemptTimeoutMs: config.attemptTimeoutMs,
    },
    budgetMs: config.cycleBudgetMs,
    concurrency: config.cycleConcurrency,
    alertThreshold: config.alertThreshold,
    notifier: config.alertWebhookUrl ? webhookNotifier(config.alertWebhookUrl) : undefined,
  };
}

/**
 * Run exactly one scoring cycle and return a summary. This is the entry point the
 * dashboard's cron route (app/api/cron/run-indexer) calls: external scheduling
 * (a cron-job.org job, every 5 min) triggers the route, the route calls this, one
 * cycle writes to Postgres. Deliberately does NOT close the pool — under
 * serverless the pg Pool is reused across warm invocations; the Neon pooler owns
 * connection lifecycle. Config comes from validated env (loadConfig); a bad env
 * or unreachable DB throws (the route turns that into a 500).
 */
export async function runIndexerCycle(): Promise<CycleSummary> {
  const config = loadConfig();
  const { targets, store } = await prepare(config);
  return runCycle(targets, store, cycleOptions(config));
}

async function main(): Promise<void> {
  let config: IndexerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(
        `Invalid indexer configuration:\n${err.problems
          .map((p) => `  - ${p}`)
          .join('\n')}\n\nCopy .env.example to .env and fill it in, then retry.`,
      );
      process.exit(1);
    }
    throw err;
  }

  // A failure here (bad DATABASE_URL, unreachable DB) should stop us before the
  // first cycle rather than silently drop every write.
  let prepared: { targets: IndexTarget[]; store: Store };
  try {
    prepared = await prepare(config);
  } catch (err) {
    console.error(
      `Cannot reach the database — check DATABASE_URL and that migrations have run ` +
        `(pnpm --filter @stenion/db migrate):\n  ${err instanceof Error ? err.message : String(err)}`,
    );
    await closePool();
    process.exit(1);
  }
  const { targets, store } = prepared;

  console.log(
    `stenion indexer: ${targets.length} target(s), ${config.cycleConcurrency} at a time, ` +
      `interval ${config.intervalMs}ms → Postgres` +
      ` (up to ${config.retryAttempts} attempt(s)/protocol within a ${config.cycleBudgetMs}ms budget; ` +
      `alerting ${config.alertWebhookUrl ? `on after ${config.alertThreshold} consecutive failures` : 'off'})`,
  );
  // The target-count ceiling, stated at startup rather than discovered by
  // registering a pool and watching the last protocol fail. runCycle checks the
  // same condition every cycle; this is the one a human reads first.
  const warning = feasibilityWarning(
    cycleFeasibility({
      targetCount: targets.length,
      concurrency: config.cycleConcurrency,
      attemptTimeoutMs: config.attemptTimeoutMs,
      budgetMs: config.cycleBudgetMs,
    }),
    targets.length,
  );
  if (warning) console.warn(warning);
  const options = cycleOptions(config);
  await runCycle(targets, store, options);
  if (config.runOnce) {
    await closePool();
    return;
  }
  setInterval(() => {
    void runCycle(targets, store, options);
  }, config.intervalMs);
}

// Only run the standalone loop when executed directly (`node dist/index.js`).
// Importing this module for `runIndexerCycle` (the cron route) must NOT start the
// interval loop or call process.exit — same guard pattern as the API server.
if (require.main === module) {
  void main();
}
