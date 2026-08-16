// Minimal indexer
//
// Runs each adapter on a fixed interval, wraps every run in try/catch, and
// writes the outcome to Postgres (via @stenion/db): safetyScore + factors +
// timestamps on success, or a failed marker on error. Deliberately dumb —
// one interval, no retries, no alerting, no backfill. Step 4 wrote these same
// records to a JSONL file; step 5 swaps only the sink (writeRecord → the DB
// store), the run loop and RunRecord shape are unchanged.
//
// All configuration comes from validated env (see config.ts) — no silent
// fallbacks for the RPC/Horizon/pool that decide what and where we index, and
// DATABASE_URL is validated up front too. Error model matches the Adapter
// contract: adapters throw, the indexer catches per-run so one protocol
// failing never aborts the cycle or process; a DB write failure is likewise
// caught and logged so it can't kill the loop.

import { BlendAdapter, KineticAdapter } from '@stenion/adapters';
import { closePool, createStore, getPool, type Store } from '@stenion/db';

import { ConfigError, loadConfig, type IndexerConfig } from './config';
import { runCycle, toTarget, type IndexTarget } from './cycle';

// The run loop itself lives in ./cycle so it can be tested without this file's
// CLI concerns (the require.main guard below is CommonJS-only). Re-exported here
// because @stenion/indexer's entry point is this module — the package's public
// surface is unchanged.
export { runCycle, toTarget } from './cycle';
export type { CycleRunResult, CycleSummary, IndexTarget } from './cycle';
import type { CycleSummary } from './cycle';

function buildTargets(config: IndexerConfig): IndexTarget[] {
  // poolId is deliberately not configured here — it's a Blend constant the
  // adapter owns (FIXED_POOL_V2), not environment config. Override via the
  // BlendAdapter constructor if a test/testnet pool is ever needed.
  const blend = new BlendAdapter({
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
  });
  // Kinetic (K2) — second, genuinely-independent protocol. Same run loop via
  // the toTarget<T> wrapper (its TRawData differs from Blend's, so the list
  // can't be typed Adapter<unknown>[] directly — that's what the wrapper is for).
  const kinetic = new KineticAdapter({
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
  });
  return [toTarget(blend), toTarget(kinetic)];
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
    await store.upsertProtocol(target.metadata, target.adapterRef);
  }
  return { targets, store };
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
  return runCycle(targets, store);
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
    `stenion indexer: ${targets.length} target(s), interval ${config.intervalMs}ms → Postgres`,
  );
  await runCycle(targets, store);
  if (config.runOnce) {
    await closePool();
    return;
  }
  setInterval(() => {
    void runCycle(targets, store);
  }, config.intervalMs);
}

// Only run the standalone loop when executed directly (`node dist/index.js`).
// Importing this module for `runIndexerCycle` (the cron route) must NOT start the
// interval loop or call process.exit — same guard pattern as the API server.
if (require.main === module) {
  void main();
}
