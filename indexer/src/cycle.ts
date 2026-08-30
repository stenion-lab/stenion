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

import {
  DEFAULT_RATE_LIMIT_POLICY,
  METHODOLOGY_VERSIONS,
  RateLimitBudget,
  isRateLimitExhausted,
  runWithRateLimitBudget,
} from '@stenion/core';
import type {
  Adapter,
  FactorMap,
  OperationalState,
  ProtocolCategory,
  ProtocolMetadata,
  RateLimitPolicy,
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
   * Rate-limit retries made INSIDE the winning attempt, absent when there were
   * none.
   *
   * This is the field that separates the second of three outcomes from the
   * first: a clean success has no `rateLimitRetries`, a retry-success has a
   * positive one and is still `status: 'ok'`. A target that succeeded after
   * waiting out two 429s is not a failure and must not reach the alert path —
   * `decideAlert` only ever reads `failed` rows, so it cannot — but it is also
   * not the same as one that sailed through, and a summary that could not tell
   * them apart would hide the endpoint pressure entirely until it became an
   * outage.
   */
  rateLimitRetries?: number;
  /**
   * True when this target FAILED because the rate-limit budget ran out, i.e.
   * the third outcome.
   *
   * Redundant with `error`, which already names the 429s, and deliberately so:
   * the message is for a human reading an alert, this is for anything counting.
   * Absent on every other kind of failure, so a timeout, a decode break and a
   * changed contract interface stay distinguishable from the shared endpoint
   * being busy.
   */
  rateLimited?: boolean;
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
   * How much of an attempt may be spent waiting out `429`s. Defaults to
   * `DEFAULT_RATE_LIMIT_POLICY`, whose numbers are derived from the measured
   * deployed attempt durations against `attemptTimeoutMs` — see that constant.
   *
   * Injectable for tests only. It is deliberately NOT env-configurable: the
   * schedule is valid only in relation to the attempt timeout, and an env var
   * that let the two be set independently would let someone configure a backoff
   * that cannot fit, turning honest 429s into misleading attempt timeouts.
   */
  rateLimit?: RateLimitPolicy;
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
 * Durations are deployed-function measurements, never local ones. The current
 * list is the 2026-08-30 reading (three cycles `curl`ed from the cron route,
 * concurrency 1, all five targets), taken AFTER the ledger-entry batching
 * landed:
 *
 *   kinetic 5.2-5.5s · yieldblox 2.9-3.2s · etherfuse 2.2-2.6s ·
 *   blend 1.9-2.2s · aquarius-xlm-usdc 1.5-1.6s
 *
 * EVERY REGISTERED TARGET IS NOW MEASURED, which is new: etherfuse and
 * aquarius-xlm-usdc were both absent from this list, and `orderByLatency`
 * therefore ran them first as assumed-slowest. That default did its job and is
 * kept for the next unmeasured pool, but holding it for a target we now have
 * numbers for would state the opposite of what was measured — aquarius-xlm-usdc
 * is the FASTEST target in the registry, at roughly a quarter of the 5.5-8.7s
 * its request count was estimated to cost, because batching collapsed its
 * ledger reads and `depthSafety` was deferred so it never simulates a swap.
 *
 * The estimate being off by ~4x is the same lesson as the concurrency incident,
 * pointing the other way: a request count is machine-independent and a duration
 * is not, so neither one is a substitute for the deployed reading.
 *
 * At concurrency 1 this ordering cannot change a cycle's makespan — the sum is
 * the sum. It is kept correct because it decides the makespan the moment
 * concurrency rises, and because a list whose comment cites numbers that no
 * longer hold is a list nobody can check.
 *
 * It lives here rather than beside `buildTargets` for one blunt reason: index.ts
 * is a CommonJS CLI entry point and cannot be imported by a test, so an ordering
 * decision made there is an ordering decision nothing can check.
 */
const SLOWEST_FIRST: readonly string[] = [
  'kinetic',
  'yieldblox',
  'etherfuse',
  'blend',
  'aquarius-xlm-usdc',
];

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

// ---------------------------------------------------------------------------
// Sharding — which slice of the registry one invocation scores
// ---------------------------------------------------------------------------

/**
 * Which slice of the registry a single invocation is responsible for.
 *
 * `{ shard: 0, totalShards: 1 }` is "all of it", and is what every caller that
 * says nothing gets — so the unsharded cron job that exists today keeps working
 * with no change to it at all.
 */
export interface ShardSpec {
  /** 0-based index of this shard. Always `< totalShards`. */
  shard: number;
  /** How many shards the registry is split across. 1 disables sharding. */
  totalShards: number;
}

/** The whole registry in one invocation — the default, and the old behaviour. */
export const SINGLE_SHARD: ShardSpec = { shard: 0, totalShards: 1 };

/**
 * FNV-1a, 32-bit, over a target id.
 *
 * A hash rather than a position because the deal order below must not depend on
 * the order targets happen to be registered or sorted in — see `selectShard`.
 * FNV-1a specifically because it is four lines, has no dependency, and is
 * identical in every runtime: the split has to come out the same in a test, in
 * `next dev`, and in a minified serverless bundle, and anything reaching for a
 * runtime identifier or a platform hash would not.
 *
 * `Math.imul` and `>>> 0` keep this in 32-bit unsigned arithmetic; without them
 * the multiply overflows into a float and the result stops being a hash.
 *
 * NOT a security primitive and never used as one. The only property required is
 * that it is a fixed, well-mixed function of the string.
 */
export function targetHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Split the registry and return the targets belonging to `spec.shard`.
 *
 * THE RULE: sort every target by `(targetHash(id), id)` — a total order that is
 * a function of the ids alone — then deal that order round-robin across the
 * shards. Position `i` in the deal goes to shard `i % totalShards`.
 *
 * BALANCED BY CONSTRUCTION, WHICH IS THE POINT. Shard sizes differ by at most
 * one, always, so N shards buy exactly N times the registry ceiling. The
 * obvious alternative — `targetHash(id) % totalShards` — is what makes a
 * target's shard depend on nothing but itself, and it was measured against this
 * registry before being rejected: today's five slugs hash to **4 and 1** across
 * two shards, so the second invocation would buy four slots instead of five,
 * and at ten targets a two-way split is more likely than not to put six in one
 * shard and be infeasible outright. Sharding exists to buy capacity; an
 * assignment that throws a third of it away does not do the job.
 *
 * WHAT THAT COSTS, STATED PLAINLY: registering a sixth target can move an
 * existing target to a different shard. That is safe HERE, and the reason is
 * worth being explicit about rather than assumed — **nothing in this system is
 * keyed by shard.** A run record is keyed by protocol; a streak is derived by
 * `decideAlert` from that protocol's own `risk_scores` rows (see alerts.ts,
 * "WHY DERIVE"); staleness is per protocol. A target that changes shard is
 * scored a few minutes earlier or later within the same cadence and nothing
 * else observes the move. The membership tests in cycle.test.ts pin exactly
 * that: one target produces the same run record and the same alert decision
 * from either shard, and from no shard at all. If some future state ever IS
 * keyed by shard, this is the decision to revisit — not the test to relax.
 *
 * INDEPENDENT OF THE INPUT ORDER, deliberately. The deal is sorted by hash, so
 * `selectShard(orderByLatency(t), s)` and `orderByLatency(selectShard(t, s))`
 * choose the same members. Ordering and sharding are orthogonal, and neither
 * has to know the other ran. The RESULT preserves the input order, so a
 * latency-ordered list stays latency-ordered after the split.
 *
 * EXACTLY-ONCE COVERAGE is the load-bearing property: every target lands in
 * exactly one shard, so running shards `0..totalShards-1` scores the registry
 * once and once only. `resolveShardSpec` is what refuses a spec that would
 * break it.
 */
export function selectShard(targets: IndexTarget[], spec: ShardSpec): IndexTarget[] {
  const { shard, totalShards } = spec;
  if (totalShards <= 1) return [...targets];

  // Sorted by hash, with the id as the tie-break so two ids that collide still
  // have one fixed order rather than whichever the input happened to carry.
  const deal = [...targets].sort((a, b) => {
    const ha = targetHash(a.metadata.id);
    const hb = targetHash(b.metadata.id);
    return ha === hb ? a.metadata.id.localeCompare(b.metadata.id) : ha - hb;
  });

  const mine = new Set<string>();
  deal.forEach((target, i) => {
    if (i % totalShards === shard) mine.add(target.metadata.id);
  });

  // Filtered from the ORIGINAL list, not from `deal`, so whatever order the
  // caller established survives the split.
  return targets.filter((t) => mine.has(t.metadata.id));
}

/** A validated spec, or the reason it was refused. */
export type ShardSpecResult = { ok: true; spec: ShardSpec } | { ok: false; error: string };

/**
 * Turn two optional raw parameters into a spec, refusing anything that would
 * break exactly-once coverage.
 *
 * It takes strings because the only caller that passes anything is the cron
 * route's query string, and it lives here rather than there for the same blunt
 * reason `orderByLatency` does: a route handler is not a thing this repo can
 * load from a test, so a coverage rule enforced in one is a coverage rule
 * nothing checks. The rule, not the transport, is the load-bearing part.
 *
 * BOTH OR NEITHER. `?shard=1` with no `totalShards` is not "shard 1 of the
 * default" — it is a half-configured cron job, and the honest response to it is
 * a 400 rather than a cycle that silently scores the wrong subset. The
 * both-absent case is the unsharded default, which is what keeps the existing
 * job working untouched.
 */
export function resolveShardSpec(
  rawShard: string | null | undefined,
  rawTotalShards: string | null | undefined,
): ShardSpecResult {
  const shardText = rawShard?.trim() ?? '';
  const totalText = rawTotalShards?.trim() ?? '';

  if (shardText === '' && totalText === '') return { ok: true, spec: SINGLE_SHARD };
  if (shardText === '' || totalText === '') {
    return { ok: false, error: 'shard and totalShards must be given together, or both omitted' };
  }

  // A plain-integer test rather than Number(), which would accept '1e0', '0x1'
  // and ' 1 ' — a cron job's URL should carry an integer or be told it doesn't.
  const isInt = (t: string): boolean => /^[0-9]+$/.test(t);
  if (!isInt(shardText) || !isInt(totalText)) {
    return {
      ok: false,
      error: `shard and totalShards must be non-negative integers, got "${shardText}" and "${totalText}"`,
    };
  }

  const shard = Number(shardText);
  const totalShards = Number(totalText);
  if (totalShards < 1) {
    return { ok: false, error: `totalShards must be at least 1, got ${totalShards}` };
  }
  if (shard >= totalShards) {
    // The spec that silently scores nothing. Refused loudly, because a job
    // configured `shard=2&totalShards=2` would otherwise return a cheerful
    // `ran: 0` forever while a third of the registry quietly went stale.
    return {
      ok: false,
      error: `shard must be less than totalShards, got shard=${shard} of ${totalShards}`,
    };
  }
  return { ok: true, spec: { shard, totalShards } };
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
  const rateLimitPolicy = options.rateLimit ?? DEFAULT_RATE_LIMIT_POLICY;
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

    // ONE RATE-LIMIT BUDGET PER ATTEMPT, established here because this is the
    // only place that knows when the attempt must end. `withRetry` calls this
    // once per attempt, so a second attempt starts with a full allowance rather
    // than inheriting what the first one spent — a fresh attempt is a fresh
    // 10s, and the budget only ever governs the attempt it belongs to.
    //
    // The deadline handed to the budget is the EARLIER of this attempt's own
    // timeout and the target's deadline, so a retry is never started that the
    // outer timeout would cut short. That is what makes a persistently-429ing
    // endpoint surface as `RateLimitExhaustedError` rather than as a generic
    // `AttemptTimeoutError` — the budget gives up first, on purpose, and says
    // why.
    let budget: RateLimitBudget | null = null;
    const runAttempt = (): Promise<Awaited<ReturnType<IndexTarget['run']>>> => {
      const attemptEndsAt = Math.min(now() + retry.attemptTimeoutMs, deadlineAt);
      budget = new RateLimitBudget(rateLimitPolicy, attemptEndsAt);
      // Ambient rather than a parameter: `Adapter.fetchRawData()` takes none,
      // and adding one would be an interface change across every adapter. See
      // core's rate-limit module for why AsyncLocalStorage and not a module
      // global (concurrency would make two targets share one allowance).
      return runWithRateLimitBudget(budget, () => target.run());
    };

    // Build the run outcome first (adapter errors caught here), then persist it
    // separately so a DB write failure is logged without aborting the cycle.
    let record: RunRecord;
    let result: CycleRunResult;
    try {
      const { value, attempts } = await withRetry(runAttempt, retry, deadlineAt, deps);
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
      const rateLimitRetries = (budget as RateLimitBudget | null)?.retriesUsed ?? 0;
      result = {
        id: target.metadata.id,
        status: 'ok',
        safetyScore,
        attempts,
        // Present only when it happened, so a clean success stays a bare row.
        ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
      };
      const retried = attempts > 1 ? ` (after ${attempts} attempts)` : '';
      // Outcome two of three, logged as itself: `ok`, but with the endpoint
      // pressure named. Still `console.log` and not `console.error` — this
      // target succeeded, and logging it as an error is how a real failure stops
      // being noticed.
      const rateLimited =
        rateLimitRetries > 0 ? ` (waited out ${rateLimitRetries} rate-limit response(s))` : '';
      console.log(
        `[${runAt}] ${target.metadata.id}: safetyScore=${safetyScore}${retried}${rateLimited} ` +
          `in ${now() - startedTargetAt}ms`,
      );
    } catch (err) {
      // Retries reduce false failures; they never hide real ones. Exhausting
      // them records exactly the failure that would have been recorded without
      // any retry at all — a protocol that is genuinely down still shows as down.
      const error = err instanceof Error ? err.message : String(err);
      record = { protocolId: target.metadata.id, status: 'failed', error, runAt };
      // Outcome three of three. The message already names the 429s (see
      // RateLimitExhaustedError); the flag is for anything counting rather than
      // reading, and keeps "the shared endpoint refused us" distinguishable from
      // a timeout or a changed contract interface without parsing prose.
      const exhausted = isRateLimitExhausted(err);
      result = {
        id: target.metadata.id,
        status: 'failed',
        error,
        attempts: retry.attempts,
        ...(exhausted ? { rateLimited: true } : {}),
      };
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
