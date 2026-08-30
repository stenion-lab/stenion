// The run loop, separated from the process entry point.
//
// Everything here is a pure function of its arguments: `runCycle` takes the
// targets and the store it should write to, and reaches for no environment, no
// pg pool, and no clock beyond `new Date()`. That is what makes the error model
// testable — the indexer's whole job on failure is to record a failed run and
// keep going, and as of 2026-08-16 `risk_scores` holds 1,683 rows and not one
// failed, so this path has never executed in production. It can only be proven
// against a deliberately throwing adapter.
//
// It lives in its own module rather than in index.ts because index.ts is a CLI
// entry point: it carries a `require.main === module` guard and extensionless
// relative imports, both of which are CommonJS-only and make the module
// impossible to load from a test under Node's native type stripping.
//
// Retry, scheduling and alerting are wired in here but configured OUTSIDE here:
// the policy, the budget, the concurrency and the notifier all arrive as
// arguments (see CycleOptions), so this module still reaches for no env and no
// pool. That is what lets the tests drive a four-cycle failure streak and a
// deliberately throwing adapter without a database, a webhook, or a real clock.
//
// SCHEDULING. Targets run through a bounded worker pool rather than one at a
// time, and the budget is NOT divided between them — see `targetDeadline` for
// the rule that replaced the division and why the division was a bug rather
// than a tradeoff. Two things survive that change unaltered, and both are
// asserted in the tests: per-target error isolation (each target's outcome is
// built and persisted inside its own task, so nothing another target does can
// reach it), and ONE alert POST per cycle (the notifier fires after the pool
// joins, outside any worker, so it cannot become one message per protocol).

import { METHODOLOGY_VERSIONS } from '@stenion/core';
import type {
  Adapter,
  FactorMap,
  OperationalState,
  ProtocolCategory,
  ProtocolMetadata,
} from '@stenion/core';
import type { RunRecord, Store } from '@stenion/db';

// Explicit .ts extensions, unlike index.ts's extensionless ones. This module is
// imported by a test, so Node's type-stripping ESM loader resolves these paths
// directly and an extensionless specifier does not resolve. tsc rewrites them to
// .js on emit via `rewriteRelativeImportExtensions` — see tsconfig.build.json.
import { decideAlert, streakWindow, type Notifier, type StreakAlert } from './alerts.ts';
import { withRetry, type RetryDeps, type RetryPolicy } from './retry.ts';

/**
 * An adapter bound to its run pipeline. Wrapping each adapter this way keeps
 * its TRawData type internal (an `Adapter<BlendRawData>` is not assignable to
 * `Adapter<unknown>` because computeRiskFactors is contravariant in TRawData),
 * so a heterogeneous list of adapters can share one run loop.
 *
 * The adapter reference persisted to `protocols.adapter` rides on `metadata`
 * (as `metadata.adapterRef`) and is deliberately NOT duplicated here. It used
 * to be read off `adapter.constructor.name`, which is correct in dev and in
 * every test but mangled by minification in the bundled serverless build —
 * see ProtocolMetadata.adapterRef. One source, and it's a literal.
 */
export interface IndexTarget {
  metadata: ProtocolMetadata;
  run(): Promise<{
    safetyScore: number;
    /**
     * The factor map the adapter produced, at the category-agnostic `FactorMap`
     * — the shape the persisted `RunRecord.factors` accepts, and not lending's
     * five-key `RiskFactorMap`. This wrapper's whole job is to erase an
     * adapter's specific types so a heterogeneous list shares one run loop, and
     * the factor map is one more of them: `toTarget` below is generic over it,
     * so the precision is kept where it means something (inside the adapter) and
     * dropped exactly where the loop stops caring.
     */
    factors: FactorMap;
    /**
     * The market's live restrictions, read from the SAME raw fetch the score was
     * computed from. That sharing is the point: a state read separately could
     * describe a different moment than the score it is published beside, and the
     * pair would then contradict each other on a fast-moving pool. It is never
     * scored — see @stenion/core's operational-state module.
     */
    operationalState: OperationalState;
    computedAt: Date;
  }>;
}

/**
 * Bind one adapter to the run pipeline, whatever category it scores.
 *
 * GENERIC OVER THE CATEGORY TOO. It used to be `toTarget<T>(adapter:
 * Adapter<T>)`, and `Adapter<T>` defaults `TCategory` to the whole
 * `ProtocolCategory` union — which was fine while lending was the only category
 * with an adapter, and stopped being fine the moment the factor map became a
 * function of that parameter. Inferring `C` from the argument is what lets each
 * adapter be checked against ITS OWN category's factor map, rather than against
 * the union of every category's.
 *
 * NOT SPELLED `Adapter<T, ProtocolCategory>`, which is shorter and does compile
 * today. It compiles only because `computeRiskFactors`/`score` are declared as
 * METHODS, and TypeScript checks method parameters bivariantly — a deliberate
 * unsoundness. That spelling would accept a concrete adapter by accident rather
 * than by rule, and would start rejecting every adapter the day either member is
 * written as a property with a function type.
 *
 * `C` is inferred and then immediately ERASED into `IndexTarget`, whose `run`
 * returns the category-agnostic `FactorMap`. That is the point: the run loop is
 * heterogeneous by design and must not acquire a per-category variant, any more
 * than `scoreFactors` may.
 */
export function toTarget<T, C extends ProtocolCategory>(adapter: Adapter<T, C>): IndexTarget {
  return {
    metadata: adapter.metadata,
    run: async () => {
      const raw = await adapter.fetchRawData();
      const factors = await adapter.computeRiskFactors(raw);
      const result = adapter.score(factors);
      return {
        safetyScore: result.score,
        factors: result.factors,
        // One `raw`, read once, feeding both. See IndexTarget.run.
        operationalState: adapter.operationalState(raw),
        computedAt: result.computedAt,
      };
    },
  };
}

/** One protocol's outcome in a cycle summary. */
export interface CycleRunResult {
  id: string;
  status: 'ok' | 'failed';
  safetyScore?: number;
  error?: string;
  /** Attempts actually made (1 = succeeded, or failed, first time). */
  attempts?: number;
  /**
   * Wall-clock ms this target's scoring took, retries and backoff included, from
   * the moment a worker picked it up to the moment its outcome was decided. The
   * DB write is deliberately outside it: this measures the adapter, not Neon.
   *
   * Published so the one measurement that matters can be taken FROM THE DEPLOYED
   * FUNCTION. The cron route spreads this summary into its JSON response, so
   * `curl`ing it returns real per-target durations on Vercel's path to the RPC —
   * which is not a developer machine's path, and is the only reason any of the
   * budget arithmetic here can be checked rather than assumed.
   */
  durationMs?: number;
}

/** What one cycle did — returned so the cron route can respond with a summary. */
export interface CycleSummary {
  ran: number;
  ok: number;
  failed: number;
  results: CycleRunResult[];
  /** Alerts raised this cycle, whether or not the notifier delivered them. */
  alerts?: StreakAlert[];
  /**
   * Wall-clock ms for the whole run loop — every target, its DB write, its
   * streak query and the alert POST. This is the number to compare against
   * `maxDuration = 60`; the per-target `durationMs` values will not sum to it,
   * because targets overlap.
   */
  totalMs?: number;
}

/**
 * Retry, budget and alerting behaviour, injected rather than read from env so
 * this module stays a pure function of its arguments (index.ts owns config).
 *
 * Every field is optional and the defaults are the *old* behaviour: one attempt,
 * no time limit, no alerting. A caller that passes nothing gets exactly the
 * loop that ran before any of this existed, which is what keeps the base
 * error-model tests testing the error model.
 */
export interface CycleOptions {
  retry?: RetryPolicy;
  /**
   * Wall-clock budget for the whole run loop. The hard constraint behind it is
   * Vercel Hobby's `maxDuration = 60`, which cannot be raised: a cycle killed
   * mid-flight can leave one protocol scored and another neither scored nor
   * recorded as failed, which is strictly worse than a protocol that ran out of
   * retries and failed cleanly.
   *
   * NOT divided per target — see `targetDeadline`. It used to be, and that made
   * every target's deadline a function of how many targets existed.
   */
  budgetMs?: number;
  /**
   * How many targets may be in flight at once. Default `DEFAULT_CONCURRENCY` (1).
   *
   * Both adapters are strictly sequential internally (every RPC and Horizon call
   * is a bare `await`), so one target is exactly one in-flight request, and this
   * number IS the peak simultaneous load Stenion puts on a shared,
   * rate-limited public RPC — which is itself a source of the failures the
   * retries exist for.
   *
   * IT IS 1 BECAUSE 2 WAS MEASURED AND FAILED. This shipped at 2 and was reverted
   * the same day: `mainnet.sorobanrpc.com` began returning `429` to whichever
   * target ran behind the concurrent burst, at a rate of roughly 3 failures in 7
   * cycles, against a clean baseline of 0 in 105 target-runs. The mechanism is
   * request RATE, not peak — see ARCHITECTURE.md's incident note, which is
   * required reading before raising this.
   *
   * Raising it does NOT change any deadline: `targetDeadline` is independent of
   * the target count and of this value except through the wave arithmetic. So
   * this is a throughput-vs-RPC-pressure dial, not a correctness one, in both
   * directions.
   */
  concurrency?: number;
  /** Consecutive failures before a `failing` alert fires. */
  alertThreshold?: number;
  notifier?: Notifier;
  /** Injectable clock/sleep, for tests. */
  deps?: RetryDeps;
}

const NO_RETRY: RetryPolicy = {
  attempts: 1,
  baseDelayMs: 0,
  attemptTimeoutMs: Number.POSITIVE_INFINITY,
};

/**
 * Targets in flight at once when the caller says nothing.
 *
 * ONE, and it is 1 because of a measured production incident rather than
 * caution — see CycleOptions.concurrency and ARCHITECTURE.md. The worker pool is
 * still a worker pool at 1; what changed is how many of its workers exist.
 */
export const DEFAULT_CONCURRENCY = 1;

/**
 * How many sequential "waves" `queued` targets take at this concurrency.
 *
 * The unit the whole budget rule is expressed in. With a worker pool the queue
 * does not actually drain in lockstep waves — a fast target frees its worker
 * early — so this is an upper bound, which is the direction a reservation has
 * to err in.
 */
export function cycleWaves(queued: number, concurrency: number): number {
  return Math.ceil(Math.max(0, queued) / Math.max(1, concurrency));
}

/**
 * Slowest target first, measured rather than guessed.
 *
 * WHY THIS FLIPPED. It used to be fastest-first, in `buildTargets`, and that was
 * right under the old rule: the budget was divided by the number of targets
 * LEFT, so the first target got the tightest share and each later one inherited
 * whatever slack was unspent — leading with the fastest adapter maximised the
 * slack handed on. That rule is gone (see `targetDeadline`), and under a worker
 * pool the ordering heuristic is the opposite one: longest-processing-time-first
 * minimises the makespan, because a slow target started last is a slow target
 * nothing can overlap with. Keeping the old order after removing the rule that
 * justified it would have been the quiet regression.
 *
 * Durations are the deployed-function measurements in ARCHITECTURE.md
 * (2026-08-25, five cycles): Kinetic 4.8-6.1s, YieldBlox 3.8-4.3s, Blend Fixed
 * 2.3-2.6s. Kinetic and YieldBlox swapped places when the measurement moved off
 * a developer machine and onto Vercel, which is the whole argument for measuring
 * there. At the three targets and concurrency 2 of that measurement the swap
 * changed nothing — those two shared wave 1 either way, and what matters is that
 * the fastest target is last — but a list whose comment cites numbers that no
 * longer hold is a list nobody can check, so it tracks the measurement.
 *
 * DELIBERATELY NOT UPDATED FOR ETHERFUSE. It has no deployed measurement,
 * so it is not on this list and `orderByLatency` therefore treats it as the
 * slowest and runs it first — the conservative default this list is built to
 * allow. Add it here only once the cron route's per-target `durationMs` says
 * where it belongs; guessing its rank from a local timing is the exact mistake
 * the concurrency incident was.
 *
 * It lives here rather than beside `buildTargets` for one blunt reason: index.ts
 * is a CommonJS CLI entry point and cannot be imported by a test, so an ordering
 * decision made there is an ordering decision nothing can check.
 */
const SLOWEST_FIRST: readonly string[] = ['kinetic', 'yieldblox', 'blend'];

/**
 * Order targets slowest-first. Pure, and total on ids it has never heard of.
 *
 * AN UNMEASURED TARGET SORTS FIRST, i.e. is assumed to be the slowest. That is
 * the conservative reading of "nobody has timed this one", and it means a newly
 * registered pool gets the most generous slot until someone measures it and puts
 * it in its place above. It also keeps `BLEND_POOLS` the single list to edit when
 * adding a market — an unmeasured pool is ordered sensibly by default instead of
 * needing a second list kept in step, which is how such lists come apart.
 */
export function orderByLatency(targets: IndexTarget[]): IndexTarget[] {
  const rank = (id: string): number => {
    const i = SLOWEST_FIRST.indexOf(id);
    return i === -1 ? -1 : i;
  };
  // Array.prototype.sort is stable, so equally-ranked targets keep registration
  // order — two unmeasured pools stay in BLEND_POOLS order.
  return [...targets].sort((a, b) => rank(a.metadata.id) - rank(b.metadata.id));
}

/**
 * When may this target run until?
 *
 * THE RULE THAT CHANGED, and the point of this module's rewrite. It used to be
 * `now + remaining / targetsLeft` — an even share of what was left. That made
 * every target's deadline a function of HOW MANY TARGETS EXISTED, so registering
 * a pool silently shortened every other pool's deadline. At three targets the
 * first share was already 14s against a 15s attempt timeout, and at four it
 * would have been 10.5s — below the *healthy* fetch duration of two protocols
 * that work today. "Adding a pool can fail protocols that already work" is not a
 * tradeoff, it is a bug.
 *
 * The rule now is: run until the end of the budget, MINUS one full attempt
 * reserved for each wave of targets still queued behind you. So
 *
 *   - a target's deadline does not shrink because a target was added, as long
 *     as the cycle is feasible at all (see `cycleFeasibility`);
 *   - a target still cannot eat the queue's last chance to be looked at, which
 *     is the guarantee the old even division was really buying;
 *   - a target that finishes early hands its slack on for free, because
 *     `queuedAfter` is read at pick time rather than planned up front — the one
 *     property of the old rule worth keeping.
 *
 * `atLeastOneAttempt` is the floor, and it is what makes this degrade rather
 * than cliff. Past the feasibility ceiling the reservation would drop a target
 * below a single full attempt — an attempt that can only time out, having
 * proved nothing about the protocol. The honest degradation there is whole
 * attempts on a first-come basis with the tail failing cleanly and visibly
 * (`DeadlineExceededError`, plus a stale row on `/api/v1/health`), NOT everyone
 * squeezed equally into a length at which nobody can succeed.
 *
 * An infinite attempt timeout (the no-retry default) reserves nothing, so a
 * caller that passes no retry policy gets the whole budget, exactly as before.
 */
export function targetDeadline(opts: {
  /** Absolute epoch ms the cycle's budget runs out at. */
  budgetEndsAt: number;
  /** Now, from the injected clock. */
  now: number;
  /** Targets not yet picked up by any worker. */
  queuedAfter: number;
  concurrency: number;
  attemptTimeoutMs: number;
}): number {
  const { budgetEndsAt, now, queuedAfter, concurrency, attemptTimeoutMs } = opts;
  const attempt = Number.isFinite(attemptTimeoutMs) ? attemptTimeoutMs : 0;
  const reserved = cycleWaves(queuedAfter, concurrency) * attempt;
  const atLeastOneAttempt = now + Math.min(attempt, budgetEndsAt - now);
  return Math.max(budgetEndsAt - reserved, atLeastOneAttempt);
}

/** Whether every target in a cycle can get one full attempt inside the budget. */
export interface CycleFeasibility {
  feasible: boolean;
  /** Waves the registry takes at this concurrency. */
  waves: number;
  /** Budget one full attempt per wave needs. */
  requiredMs: number;
  budgetMs: number;
}

/**
 * The ceiling on target count, as an arithmetic condition rather than a thing
 * someone discovers by registering a pool and finding out.
 *
 * `ceil(targets / concurrency) * attemptTimeoutMs <= budgetMs` — can every
 * target get one attempt of full length? At the shipped defaults (50s budget,
 * 10s attempt timeout, concurrency 1) that holds up to **five targets** and
 * fails at six, and the answer at six is a higher concurrency, a lower attempt
 * timeout, or sharding — all of which this makes a decision at the moment it
 * stops being true. NOT a bigger budget: six targets need 60s of attempts, which
 * is Vercel Hobby's `maxDuration` itself.
 *
 * Reported, never thrown. Refusing to run because someone registered a fifth
 * pool would take the whole registry down over a config question, which is
 * strictly worse than running four protocols well and saying so loudly.
 */
export function cycleFeasibility(opts: {
  targetCount: number;
  concurrency: number;
  attemptTimeoutMs: number;
  budgetMs: number;
}): CycleFeasibility {
  const { targetCount, concurrency, attemptTimeoutMs, budgetMs } = opts;
  const waves = cycleWaves(targetCount, concurrency);
  const requiredMs = waves * attemptTimeoutMs;
  // An unbounded attempt or an unbounded budget makes the question meaningless
  // rather than answerable — there is nothing to check, so nothing to warn about.
  const checkable = Number.isFinite(attemptTimeoutMs) && Number.isFinite(budgetMs);
  return { feasible: !checkable || requiredMs <= budgetMs, waves, requiredMs, budgetMs };
}

/** The warning for an infeasible cycle, or null when there is nothing to say. */
export function feasibilityWarning(f: CycleFeasibility, targetCount: number): string | null {
  if (f.feasible) return null;
  return (
    `[budget] ${targetCount} targets take ${f.waves} wave(s) at this concurrency, needing ` +
    `${f.requiredMs}ms for one full attempt each against a ${f.budgetMs}ms budget. Targets late ` +
    `in the cycle will be cut short or recorded as failed for want of time. Raise ` +
    `STENION_CYCLE_CONCURRENCY, lower STENION_ATTEMPT_TIMEOUT_MS, or reduce the registry.`
  );
}

export async function runCycle(
  targets: IndexTarget[],
  store: Store,
  options: CycleOptions = {},
): Promise<CycleSummary> {
  const retry = options.retry ?? NO_RETRY;
  const deps = options.deps ?? {};
  const now = deps.now ?? Date.now;
  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const startedAt = now();
  const budgetEndsAt = startedAt + budgetMs;
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));

  const warning = feasibilityWarning(
    cycleFeasibility({
      targetCount: targets.length,
      concurrency,
      attemptTimeoutMs: retry.attemptTimeoutMs,
      budgetMs,
    }),
    targets.length,
  );
  if (warning) console.warn(warning);

  // Indexed slots, not `push`. Workers finish in whatever order the RPC hands
  // them back, so a summary assembled in completion order would reorder itself
  // between cycles for no reason anyone could act on — and the alert body, which
  // is rendered from the same array, would too. Slots are filled by target index
  // and flattened at the end, so both read in registration order however the
  // cycle actually ran. The DB writes genuinely do interleave; that is fine,
  // because every read of them is ordered by `run_at`, per protocol.
  const slots: (CycleRunResult | undefined)[] = new Array(targets.length);
  const alertSlots: (StreakAlert | undefined)[] = new Array(targets.length);

  /**
   * One target, start to finish: score it, persist the outcome, then read its
   * streak. Never throws — per-target error isolation is the contract, and it is
   * what lets the workers below be a plain `Promise.all`.
   */
  async function runOne(target: IndexTarget, index: number, queuedAfter: number): Promise<void> {
    const runAt = new Date().toISOString();
    const startedTargetAt = now();
    const deadlineAt = targetDeadline({
      budgetEndsAt,
      now: startedTargetAt,
      queuedAfter,
      concurrency,
      attemptTimeoutMs: retry.attemptTimeoutMs,
    });

    // Build the run outcome first (adapter errors caught here), then persist it
    // separately so a DB write failure is logged without aborting the cycle.
    let record: RunRecord;
    let result: CycleRunResult;
    try {
      const { value, attempts } = await withRetry(() => target.run(), retry, deadlineAt, deps);
      const { safetyScore, factors, operationalState, computedAt } = value;
      record = {
        protocolId: target.metadata.id,
        status: 'ok',
        safetyScore,
        factors,
        operationalState,
        // Stamped here, not by the adapter: one rulebook applies to every
        // protocol IN A CATEGORY, so the version is a property of the run, not
        // of the adapter — but WHICH rulebook is a property of the target, so it
        // is resolved from the target's own declared category rather than from a
        // single global constant. Both are stored: every category's counter
        // starts at 1, so the version alone stops identifying a rulebook the
        // moment a second category exists (migration 0008).
        category: target.metadata.category,
        methodologyVersion: METHODOLOGY_VERSIONS[target.metadata.category],
        computedAt: computedAt.toISOString(),
        runAt,
      };
      result = { id: target.metadata.id, status: 'ok', safetyScore, attempts };
      const retried = attempts > 1 ? ` (after ${attempts} attempts)` : '';
      console.log(
        `[${runAt}] ${target.metadata.id}: safetyScore=${safetyScore}${retried} ` +
          `in ${now() - startedTargetAt}ms`,
      );
    } catch (err) {
      // Retries reduce false failures; they never hide real ones. Exhausting
      // them records exactly the failure that would have been recorded without
      // any retry at all — a protocol that is genuinely down still shows as down.
      const error = err instanceof Error ? err.message : String(err);
      record = { protocolId: target.metadata.id, status: 'failed', error, runAt };
      result = { id: target.metadata.id, status: 'failed', error, attempts: retry.attempts };
      console.error(
        `[${runAt}] ${target.metadata.id}: FAILED — ${error} (after ${now() - startedTargetAt}ms)`,
      );
    }
    result.durationMs = now() - startedTargetAt;

    let wrote = true;
    try {
      await store.insertRunRecord(record);
    } catch (err) {
      wrote = false;
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[${runAt}] ${target.metadata.id}: DB write failed — ${error}`);
    }

    slots[index] = result;

    // The streak is read AFTER the write, so what an alert describes is literally
    // the rows in the table. If the write didn't land there is nothing new to
    // read and this cycle is skipped — a streak we could not record is not one
    // we should page anyone about.
    //
    // Concurrency changes nothing here: `listRecentRuns` is filtered to one
    // protocol and ordered by `run_at`, and this call sits inside the same task
    // as that protocol's own write, so the read-after-write it depends on holds
    // whatever another target is doing at the same moment.
    if (wrote && options.notifier && options.alertThreshold) {
      const alert = await checkStreak(store, target.metadata, options.alertThreshold);
      if (alert) alertSlots[index] = alert;
    }
  }

  // A worker pool over a shared cursor, rather than fixed batches of K: a batch
  // runs at the speed of its slowest member and leaves workers idle waiting on
  // it, which at these durations is a large fraction of the budget.
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= targets.length) return;
      // Read AFTER the increment, so it counts targets no worker has taken yet.
      await runOne(targets[index], index, targets.length - nextIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));

  const results = slots.filter((r): r is CycleRunResult => r !== undefined);
  const alerts = alertSlots.filter((a): a is StreakAlert => a !== undefined);

  // One POST per cycle: an RPC-wide outage taking out every protocol at once
  // should read as one incident, not as a message per protocol. Outside the
  // worker pool by construction — it cannot fire per target even accidentally.
  if (alerts.length > 0 && options.notifier) {
    try {
      await options.notifier(alerts);
    } catch (err) {
      // Alerting must never be able to fail a cycle. Scoring already happened
      // and is already persisted; a webhook that is down is its own problem.
      console.error(
        `[alerts] delivery failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ran: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    ...(alerts.length > 0 ? { alerts } : {}),
    totalMs: now() - startedAt,
  };
}

/**
 * Read this protocol's recent runs and decide whether they warrant a
 * notification. Never throws: a failure here is an alerting problem, and the
 * cycle's actual job (score, record) is already done by the time it runs.
 */
async function checkStreak(
  store: Store,
  metadata: ProtocolMetadata,
  threshold: number,
): Promise<StreakAlert | null> {
  try {
    const window = streakWindow(threshold);
    const runs = await store.listRecentRuns(metadata.id, window);
    return decideAlert(runs, {
      threshold,
      window,
      protocolId: metadata.id,
      protocolName: metadata.name,
    });
  } catch (err) {
    console.error(
      `[alerts] ${metadata.id}: could not read run history — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
