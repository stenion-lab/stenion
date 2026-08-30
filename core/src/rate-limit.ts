// Rate-limit retry accounting: the budget one scoring attempt may spend waiting
// out a `429`, and the ambient scope that carries it from the indexer into the
// adapters without either one gaining a parameter.
//
// WHY THIS IS A SEPARATE CONCERN FROM `indexer/src/retry.ts`. That module
// retries a whole TARGET: it re-runs `fetchRawData()` from the first request.
// That is the right response to "this protocol's read failed" and the wrong one
// to "request 15 of 20 was rate-limited" — re-running the target reissues the
// fourteen requests that already succeeded, which costs the budget a full extra
// attempt AND raises the request rate that caused the 429 in the first place.
// Measured on the deployed cron route on 2026-08-30: three targets failed with
// `Request failed with status code 429` after `attempts: 3`, i.e. the existing
// target-level retry ran three times and was rate-limited every time. This
// module retries the ONE call that was refused, in place.
//
// WHAT IT DELIBERATELY DOES NOT DO. It is not a general retry wrapper. Only a
// rate-limit response is retried; a malformed response, a contract error, a
// decode failure and a timeout all propagate on the first throw, exactly as
// before. A wrapper that retried everything would turn "this pool's oracle
// changed shape" into three slow identical failures and would blur the one
// signal an alert is for.
//
// THE BUDGET IS PER ATTEMPT, NOT PER CALL, and that is the load-bearing part.
// A target makes 11-27 requests; if each could independently spend its own
// backoff, a handful of rate-limited calls would walk straight through
// `STENION_ATTEMPT_TIMEOUT_MS` and the attempt would be killed by the timeout —
// reporting a generic "exceeded its 10000ms time budget" instead of the 429s
// that actually happened. One budget for the whole attempt is what keeps the
// failure legible.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How much waiting one attempt may do, and how it escalates.
 *
 * Every number here is derived in `DEFAULT_RATE_LIMIT_POLICY` from measured
 * deployed attempt durations against the attempt timeout — none of them is a
 * round number someone liked.
 */
export interface RateLimitPolicy {
  /** Delay before a call's 1st retry; doubles for each retry of that same call. */
  baseDelayMs: number;
  /** Most retries any single call may make. */
  maxRetriesPerCall: number;
  /** Most retries the whole attempt may make, across every call it issues. */
  maxRetriesPerAttempt: number;
  /** Most time the whole attempt may spend sleeping between retries. */
  backoffBudgetMs: number;
  /**
   * Below this much time left before the attempt deadline, a retry is not worth
   * starting — it could only be cut short by the timeout, having first spent the
   * backoff. Sized from the deployed per-request latency (150-235ms).
   */
  minCallMs: number;
}

/**
 * The shipped policy, and the arithmetic that produced it.
 *
 * THE CONSTRAINT is `STENION_ATTEMPT_TIMEOUT_MS` = 10,000ms, which caps one
 * whole `fetchRawData` + score. Retries spend that same budget; they do not
 * extend it.
 *
 * THE MEASUREMENTS are deployed per-target `durationMs` from the cron route
 * (2026-08-29 and 2026-08-30, concurrency 1) — never developer-machine timings,
 * per CLAUDE.md:
 *
 *   blend 2,412-3,290 · etherfuse 3,007-3,290 · yieldblox 3,676-3,934
 *   kinetic 4,991-6,363 · aquarius-xlm-usdc 1,901-3,575
 *
 * So the worst HEALTHY attempt in the registry is Kinetic at 6,363ms, leaving
 * 3,637ms of headroom inside the 10s cap. Per-request latency on that path is
 * 150-235ms.
 *
 * THE SCHEDULE, sized to fit that headroom with margin:
 *
 *   250ms -> 500ms -> 1,000ms, at most 3 retries for any one call
 *   at most 4 retries across the attempt, and at most 2,000ms asleep in total
 *
 *   worst case added = 2,000ms sleeping + 4 retried calls x 235ms = 2,940ms
 *   6,363 + 2,940 = 9,303ms against a 10,000ms cap — 697ms of margin
 *
 * THREE RETRIES, NOT MORE, and the cap is deliberately hard: a persistently
 * rate-limited or genuinely down endpoint has to surface as a real failure
 * inside the attempt window rather than as a cycle that retries into the
 * timeout. A longer schedule would not fit, and a schedule that does not fit
 * does not degrade gracefully — it converts an honest `429` into a misleading
 * `AttemptTimeoutError`.
 *
 * The 250ms first step is short on purpose. It is not trying to outwait a
 * one-second rate-limit window — nothing that fits in this budget could. It is
 * trying to survive the momentary burst that a single target's own request
 * train produces, which is what the deployed 429s actually look like. The real
 * fix for sustained pressure is fewer requests (see the ledger-entry batching in
 * `architecture/`), not longer waits.
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  baseDelayMs: 250,
  maxRetriesPerCall: 3,
  maxRetriesPerAttempt: 4,
  backoffBudgetMs: 2_000,
  minCallMs: 300,
};

/** Why a rate-limited call was not retried again. */
export type RateLimitStop =
  'callRetriesExhausted' | 'attemptRetriesExhausted' | 'backoffBudgetSpent' | 'deadlineTooClose';

/** What `RateLimitBudget.planRetry` decided. */
export type RetryPlan = { retry: true; delayMs: number } | { retry: false; stop: RateLimitStop };

/**
 * One attempt's allowance for waiting out rate limits.
 *
 * Mutable and single-threaded by construction: it belongs to exactly one
 * attempt, lives only as long as that attempt, and every call that attempt makes
 * draws from it. Two concurrent targets hold two budgets and cannot see each
 * other's — see `runWithRateLimitBudget`.
 */
export class RateLimitBudget {
  readonly policy: RateLimitPolicy;
  /**
   * Absolute epoch ms this attempt must be finished by, or Infinity when
   * nothing has told us. The indexer passes the real one; an adapter called
   * directly (a script, a test) gets Infinity and is governed by the policy caps
   * alone.
   */
  readonly endsAt: number;

  private retries = 0;
  private sleptMs = 0;
  private lastDetail: string | null = null;

  constructor(
    policy: RateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
    endsAt = Number.POSITIVE_INFINITY,
  ) {
    this.policy = policy;
    this.endsAt = endsAt;
  }

  /** Retries this attempt has made across every call. 0 = never rate-limited. */
  get retriesUsed(): number {
    return this.retries;
  }

  /** Total ms this attempt has spent asleep waiting out rate limits. */
  get backoffUsedMs(): number {
    return this.sleptMs;
  }

  /** Was this attempt rate-limited at all? Drives the retry-success reporting. */
  get wasRateLimited(): boolean {
    return this.retries > 0 || this.lastDetail !== null;
  }

  /**
   * May a call that was just rate-limited try again, and after how long?
   *
   * `callRetries` is how many times THIS call has already been retried, so the
   * delay escalates per call rather than per attempt — two calls rate-limited
   * once each both wait 250ms, which is the right shape: each is its own burst.
   *
   * `retryAfterMs` is the server's own `Retry-After`, honoured when it is longer
   * than our schedule. A server that says "wait 3 seconds" is not asking to be
   * negotiated with, so if that does not fit the budget we stop rather than
   * retry early — retrying inside the window the server named would just spend
   * an attempt to be refused again.
   */
  planRetry(callRetries: number, retryAfterMs: number | null, now: number): RetryPlan {
    if (callRetries >= this.policy.maxRetriesPerCall) {
      return { retry: false, stop: 'callRetriesExhausted' };
    }
    if (this.retries >= this.policy.maxRetriesPerAttempt) {
      return { retry: false, stop: 'attemptRetriesExhausted' };
    }

    const scheduled = this.policy.baseDelayMs * 2 ** callRetries;
    const delayMs = Math.max(scheduled, retryAfterMs ?? 0);

    if (this.sleptMs + delayMs > this.policy.backoffBudgetMs) {
      return { retry: false, stop: 'backoffBudgetSpent' };
    }
    // The structural guarantee, not merely arithmetic that happens to add up:
    // a retry is started only when the sleep AND a call worth making both fit
    // before the attempt's own deadline. This is what stops a retry schedule
    // from ever converting a 429 into an attempt timeout.
    if (now + delayMs + this.policy.minCallMs > this.endsAt) {
      return { retry: false, stop: 'deadlineTooClose' };
    }
    return { retry: true, delayMs };
  }

  /** Record a retry that is about to happen. */
  recordRetry(delayMs: number, detail: string): void {
    this.retries += 1;
    this.sleptMs += delayMs;
    this.lastDetail = detail;
  }

  /** Record a rate-limit response we did NOT retry, so the attempt still knows it happened. */
  recordRefusal(detail: string): void {
    this.lastDetail = detail;
  }
}

/**
 * Thrown when a call was rate-limited and the attempt had nothing left to spend
 * on it.
 *
 * A DISTINCT ERROR WITH THE 429s NAMED IN ITS MESSAGE, because that message is
 * what lands in `risk_scores.error` and in the alert body. "Rate limited by the
 * RPC, gave up after 4 retries" and "attempt exceeded its 10000ms time budget"
 * call for completely different responses from whoever reads them, and the
 * whole point of capping the retries below the timeout is that this one, not
 * the timeout, is what a persistently-429ing endpoint produces.
 *
 * `name` is a string literal, never `constructor.name` — the workspace packages
 * are minified into the dashboard's serverless bundle, where a class name is
 * renamed. See ProtocolMetadata.adapterRef for the bug that rule comes from.
 */
export class RateLimitExhaustedError extends Error {
  readonly retries: number;
  readonly backoffMs: number;
  readonly stop: RateLimitStop;

  constructor(what: string, budget: RateLimitBudget, stop: RateLimitStop) {
    super(
      `rate limited (HTTP 429) on ${what} — gave up after ${budget.retriesUsed} ` +
        `retr${budget.retriesUsed === 1 ? 'y' : 'ies'} and ${budget.backoffUsedMs}ms of backoff ` +
        `(${RATE_LIMIT_STOP_REASONS[stop]}). This is the shared endpoint refusing us, not the ` +
        `protocol being unreadable.`,
    );
    this.name = 'RateLimitExhaustedError';
    this.retries = budget.retriesUsed;
    this.backoffMs = budget.backoffUsedMs;
    this.stop = stop;
  }
}

/** Human-readable half of each stop reason, for the error message. */
const RATE_LIMIT_STOP_REASONS: Record<RateLimitStop, string> = {
  callRetriesExhausted: 'this call hit the per-call retry cap',
  attemptRetriesExhausted: 'the attempt hit its retry cap',
  backoffBudgetSpent: 'the attempt spent its backoff budget',
  deadlineTooClose: 'too little of the attempt timeout was left to retry inside it',
};

/**
 * Is this the retry-exhausted rate-limit failure, as opposed to anything else?
 *
 * Checked on a stamped property rather than `instanceof`, for the same reason
 * `name` is a literal: `@stenion/core` is bundled separately into the dashboard's
 * serverless functions and into the indexer, so an error can cross a module
 * boundary where `instanceof` compares two different copies of the class.
 */
export function isRateLimitExhausted(error: unknown): error is RateLimitExhaustedError {
  return error instanceof Error && error.name === 'RateLimitExhaustedError';
}

/**
 * The attempt-scoped budget, carried without a parameter.
 *
 * WHY AsyncLocalStorage AND NOT AN ARGUMENT. The budget has to be created by the
 * INDEXER (only it knows the attempt deadline) and consumed by the ADAPTERS
 * (only they make the calls) — and threading it between them means a parameter
 * on `Adapter.fetchRawData()`, which is an interface change across core and
 * every adapter, and an explicit non-goal here. A module-level mutable would be
 * the other obvious shortcut and is wrong: `STENION_CYCLE_CONCURRENCY` may be
 * raised, and two targets sharing one budget would have each one's retries
 * silently spend the other's allowance. `AsyncLocalStorage` gives per-attempt
 * isolation that survives every `await` in the adapter's call graph and is
 * correct at any concurrency.
 */
const budgetScope = new AsyncLocalStorage<RateLimitBudget>();

/** Run `fn` with `budget` as the ambient attempt budget. */
export function runWithRateLimitBudget<T>(
  budget: RateLimitBudget,
  fn: () => Promise<T>,
): Promise<T> {
  return budgetScope.run(budget, fn);
}

/**
 * The ambient budget, or null when nothing established one.
 *
 * Null is a supported state, not an error: `fetchRawData()` is called directly
 * by scripts, by `scripts/capture-fixture.mjs` and by anyone poking at an
 * adapter in a REPL. Those get a fresh per-call budget from the transport
 * wrappers instead, so retries still happen — they just answer to the policy
 * caps rather than to an attempt deadline nobody set.
 */
export function currentRateLimitBudget(): RateLimitBudget | null {
  return budgetScope.getStore() ?? null;
}
