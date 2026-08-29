// Indexer configuration: load .env, validate everything up front, and fail
// loudly with a full list of what's wrong before the run loop starts. No
// silent fallbacks for the values that decide *what* and *where* we index —
// a wrong endpoint should surface at startup, not as confusing runtime output.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface IndexerConfig {
  /** Soroban RPC endpoint adapters read pool/reserve/oracle state from. */
  rpcUrl: string;
  /** Horizon endpoint used for admin-account signer/activity data. */
  horizonUrl: string;
  /** Scoring-cycle interval in milliseconds. */
  intervalMs: number;
  /** Postgres connection string each run outcome is written to. */
  databaseUrl: string;
  /** Run a single cycle then exit instead of looping. */
  runOnce: boolean;
  /** Total attempts per protocol per cycle, including the first. 1 disables retry. */
  retryAttempts: number;
  /** Delay before the 2nd attempt, doubling for each one after. */
  retryBaseDelayMs: number;
  /** Soft cap on a single attempt — see RetryPolicy.attemptTimeoutMs. */
  attemptTimeoutMs: number;
  /**
   * Wall-clock budget for one cycle's run loop.
   *
   * NOT split between protocols — each target's deadline is the end of this
   * budget less a reservation for whatever is still queued, so it does not
   * shrink as targets are added. See cycle.ts `targetDeadline`.
   *
   * The ceiling is Vercel Hobby's `maxDuration = 60`, which cannot be raised, so
   * this must leave room for cold start, pool connect, the protocol upserts, the
   * streak queries and the alert POST on top. Conservative by choice: a cycle
   * killed mid-flight can leave one protocol scored and another neither scored
   * nor recorded as failed, which is worse than a retry that never happened.
   */
  cycleBudgetMs: number;
  /**
   * How many protocols the run loop scores at once.
   *
   * This is the peak simultaneous load Stenion puts on the shared public RPC,
   * exactly: both adapters are strictly sequential internally, so one target in
   * flight is one request in flight. Raising it buys headroom for more targets
   * and costs proportionally more concurrent pressure on the endpoint that is
   * itself a common source of the failures being retried.
   */
  cycleConcurrency: number;
  /** Consecutive failed cycles before a protocol raises an alert. */
  alertThreshold: number;
  /** Webhook alerts are POSTed to, or null when alerting is disabled. */
  alertWebhookUrl: string | null;
}

/** Thrown when env validation fails; carries every problem so all are shown at once. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid indexer configuration (${problems.length} problem(s))`);
    this.name = 'ConfigError';
  }
}

/**
 * Load KEY=VALUE pairs from the nearest .env walking up from `startDir`, without
 * overriding values already present in the environment (shell/CI wins over .env).
 * A missing .env is fine — the vars may come from the real environment instead.
 */
function loadDotEnv(startDir: string): void {
  let dir = startDir;
  let envPath: string | null = null;
  for (;;) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      envPath = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!envPath) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && !(key in process.env)) process.env[key] = value;
  }
}

const problems: string[] = [];

function requiredUrl(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) {
    problems.push(`${name} is required but is missing or empty`);
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be a valid URL, got "${raw}"`);
    return raw;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${name} must be an http(s) URL, got "${raw}"`);
  }
  return raw;
}

function requiredPostgresUrl(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) {
    problems.push(`${name} is required but is missing or empty`);
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be a valid URL, got "${raw}"`);
    return raw;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    problems.push(`${name} must be a postgres:// URL, got "${raw}"`);
  }
  return raw;
}

function optionalPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} must be a positive integer, got "${raw}"`);
    return fallback;
  }
  return n;
}

/**
 * An http(s) URL if set, null if not. Unlike requiredUrl, absence is a valid
 * answer — an unset alert webhook means "alerting is off", which is the default
 * and must not stop the indexer. A malformed one is still a problem, though:
 * silently not alerting because of a typo is the failure this whole change
 * exists to prevent.
 */
function optionalUrl(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be a valid URL, got "${raw}"`);
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${name} must be an http(s) URL, got "${raw}"`);
  }
  return raw;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  problems.push(`${name} must be a boolean (true/false/1/0), got "${process.env[name]}"`);
  return fallback;
}

/**
 * Load and validate configuration. Throws ConfigError listing every problem if
 * anything is invalid — call once at startup so misconfiguration is caught before
 * the first run rather than mid-cycle.
 */
export function loadConfig(cwd: string = process.cwd()): IndexerConfig {
  loadDotEnv(cwd);
  problems.length = 0;

  const config: IndexerConfig = {
    rpcUrl: requiredUrl('STENION_RPC_URL'),
    horizonUrl: requiredUrl('STENION_HORIZON_URL'),
    intervalMs: optionalPositiveInt('STENION_INTERVAL_MS', 5 * 60 * 1000),
    databaseUrl: requiredPostgresUrl('DATABASE_URL'),
    runOnce: process.argv.includes('--once') || optionalBool('STENION_RUN_ONCE', false),
    retryAttempts: optionalPositiveInt('STENION_RETRY_ATTEMPTS', 3),
    retryBaseDelayMs: optionalPositiveInt('STENION_RETRY_BASE_DELAY_MS', 1000),
    // 10s, lowered from 15s once the deployed function was actually measured:
    // nothing healthy exceeds 6.1s there (architecture/), so 15s was sized
    // against a developer machine's much slower path to the RPC. The shorter cap
    // is what makes a SEQUENTIAL cycle feasible at all, which is how the 429
    // incident was resolved without giving back the deadline guarantee #68
    // bought.
    //
    // UNCHANGED BY THE FIRST DEX TARGET (#104), and that is a decision. Lowering
    // it to 8.4s would have bought the fifth target inside the old 42s budget
    // without touching anything else — and it was rejected, because an Aquarius
    // attempt is the longest one in the registry. Its request count is 22 RPC +
    // 15 Horizon (measured in #101, machine-independent) against Kinetic's 27
    // RPC, and the deployed function's observed rate is 150-235ms per request,
    // which puts an Aquarius attempt somewhere in 5.5-8.7s. A cap inside that
    // range would time out a healthy target on a slow day. The budget moved
    // instead; see below.
    //
    // LOCAL DEV CAVEAT: a developer machine has been seen taking 12.5s on
    // YieldBlox, which exceeds this cap — a local `pnpm indexer` may now time out
    // and retry where it used to succeed first time. Raise it in .env if that
    // bites; production is the case this default is sized for.
    attemptTimeoutMs: optionalPositiveInt('STENION_ATTEMPT_TIMEOUT_MS', 10_000),
    // 50s, raised from 42s in #104 — AGAINST OBSERVED DEPLOYED DURATIONS, which
    // is the only condition under which CLAUDE.md permits raising it, and the
    // condition the previous comment here set ("raise it once the Vercel logs
    // show real headroom"). Three cycles curl'ed from the deployed cron route on
    // 2026-08-29, concurrency 1, four lending targets:
    //
    //   totalMs 15,482 / 15,627 / 16,759   HTTP wall 17.3s / 17.7s
    //   per target: blend 2,412-3,049 · etherfuse 3,007-3,249 ·
    //               yieldblox 3,676-3,934 · kinetic 4,991-6,363
    //
    // So the real cycle uses ~16s of the budget and the function's own overhead
    // beyond the cycle (route entry, DB connect and upserts, response) is
    // 1.0-1.7s. A cycle can never run PAST the budget — `targetDeadline` caps
    // every target at `budgetEndsAt` — so the worst-case function wall is
    // budget + overhead, i.e. ~52s against Vercel Hobby's 60s `maxDuration`.
    // The ceiling is still load-bearing and still respected, with ~8s of margin.
    //
    // WHY IT HAD TO MOVE AT ALL. `cycleFeasibility()` requires
    // `ceil(targets / concurrency) * attemptTimeoutMs <= budgetMs`. At
    // concurrency 1 and a 10s attempt, 42s allowed exactly FOUR targets — the
    // four already registered — so registering any dex market at all made the
    // cycle infeasible, independently of which market it was. 50s allows five,
    // exactly, and 5 x 10,000 = 50,000 <= 50,000 passes rather than warning.
    //
    // THIS IS THE LAST TARGET THE BUDGET CAN BUY. A sixth needs 60s, which is
    // the hard ceiling, so it cannot come from here — it has to come from a
    // lower attempt timeout justified by a deployed Aquarius `durationMs`, or
    // from concurrency, which needs its own measured RPC-tolerance test (see
    // cycleConcurrency below and the 429 incident in architecture/).
    cycleBudgetMs: optionalPositiveInt('STENION_CYCLE_BUDGET_MS', 50_000),
    // 1. This shipped as 2 and was reverted to 1 the same day, on measurement:
    // concurrency 2 drew sustained `429`s from mainnet.sorobanrpc.com, the free
    // shared public endpoint (blend failed 3 of 7 clean cycles against 0 of 105
    // target-runs before the change). The full incident is in ARCHITECTURE.md and
    // must be read before raising this again.
    //
    // The root cause is RATE, not peak. Peak in-flight only went 1 -> 2, but the
    // deployed function is 2-3x faster than the developer machine the original
    // estimate was computed from, so two concurrent targets issue ~45 requests in
    // ~4s — about 11/second — and the target running behind that burst is the one
    // that gets refused.
    //
    // Dropping to 1 costs nothing structural: each target's deadline no longer
    // depends on the target count either way (see cycle.ts `targetDeadline`), so
    // this is a throughput-vs-RPC-pressure dial and not a correctness one. The
    // budget-division bug #68 fixed does NOT come back at 1.
    cycleConcurrency: optionalPositiveInt('STENION_CYCLE_CONCURRENCY', 1),
    // 4 cycles ≈ 20 minutes at the 5-minute cadence. One blip must not page
    // anyone, and a score 20 minutes stale is not an emergency — false pages are
    // how people learn to ignore alerts.
    alertThreshold: optionalPositiveInt('STENION_ALERT_THRESHOLD', 4),
    alertWebhookUrl: optionalUrl('STENION_ALERT_WEBHOOK_URL'),
  };

  if (problems.length > 0) throw new ConfigError([...problems]);
  return config;
}
