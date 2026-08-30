// Tests for the rate-limit budget: the accounting that decides whether a
// rate-limited call may wait and try again.
//
// THE ONE THAT MATTERS is "the worst case fits inside the attempt timeout".
// Everything else this module does is bookkeeping; that assertion is the reason
// the bookkeeping exists. A backoff schedule that does not fit converts an
// honest `429` into a misleading `AttemptTimeoutError`, which is exactly the
// signal-erosion this whole change is against — so it is tested against the
// pathological case (every call rate-limited, maximum delays, nothing succeeding)
// rather than against a plausible one.
//
// No clock and no sleeping: `planRetry` takes `now` as an argument, so the
// schedule is proved arithmetically rather than waited out.
//
// Run with: pnpm --filter @stenion/core test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_RATE_LIMIT_POLICY,
  RateLimitBudget,
  RateLimitExhaustedError,
  currentRateLimitBudget,
  isRateLimitExhausted,
  runWithRateLimitBudget,
} from './rate-limit.ts';

/** The shipped attempt cap this whole policy is sized against (config.ts). */
const ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * The slowest HEALTHY attempt measured on the deployed cron route — Kinetic,
 * 2026-08-29/30. The budget has to leave room on top of this, not on top of an
 * average.
 */
const SLOWEST_HEALTHY_ATTEMPT_MS = 6_363;

/** Deployed per-request latency, top of the observed 150-235ms range. */
const REQUEST_LATENCY_MS = 235;

// ---------------------------------------------------------------------------
// The budget fits the attempt timeout
// ---------------------------------------------------------------------------

describe('the retry schedule fits inside STENION_ATTEMPT_TIMEOUT_MS', () => {
  it('cannot spend more than the policy caps, whatever the call pattern', () => {
    // Drive the budget the worst possible way: every call rate-limited, always
    // asking for another retry, until it refuses. Then check what it let us
    // spend. This is not the expected pattern — it is the ceiling, which is what
    // the timeout arithmetic has to be safe against.
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    let retries = 0;
    // Fresh "call" every retry: `callRetries: 0` always, so per-call escalation
    // never kicks in and each retry costs the minimum delay — which maximises
    // how MANY retries fit, the direction that stresses the attempt cap.
    for (let i = 0; i < 50; i++) {
      const plan = budget.planRetry(0, null, 0);
      if (!plan.retry) break;
      budget.recordRetry(plan.delayMs, 'call');
      retries += 1;
    }

    assert.equal(retries, DEFAULT_RATE_LIMIT_POLICY.maxRetriesPerAttempt);
    assert.ok(
      budget.backoffUsedMs <= DEFAULT_RATE_LIMIT_POLICY.backoffBudgetMs,
      `slept ${budget.backoffUsedMs}ms, budget is ${DEFAULT_RATE_LIMIT_POLICY.backoffBudgetMs}ms`,
    );
  });

  it('leaves the slowest healthy attempt real margin under the 10s cap', () => {
    // The arithmetic recorded in DEFAULT_RATE_LIMIT_POLICY, asserted rather than
    // left in a comment where it can rot: worst-case added time is the whole
    // backoff budget plus one request's latency for each retry made.
    const policy = DEFAULT_RATE_LIMIT_POLICY;
    const worstAdded = policy.backoffBudgetMs + policy.maxRetriesPerAttempt * REQUEST_LATENCY_MS;
    const worstAttempt = SLOWEST_HEALTHY_ATTEMPT_MS + worstAdded;

    assert.ok(
      worstAttempt < ATTEMPT_TIMEOUT_MS,
      `worst case ${worstAttempt}ms must stay under the ${ATTEMPT_TIMEOUT_MS}ms attempt cap`,
    );
    // Margin, not a photo finish. If a future policy change leaves under half a
    // second of slack, that is a decision someone should have to make on purpose.
    assert.ok(
      ATTEMPT_TIMEOUT_MS - worstAttempt >= 500,
      `only ${ATTEMPT_TIMEOUT_MS - worstAttempt}ms of margin — too tight to absorb a slow day`,
    );
  });

  it('refuses a retry that would run past the attempt deadline', () => {
    // The structural guarantee, independent of the arithmetic above: even with
    // every policy cap untouched, a budget that knows when the attempt ends will
    // not start a retry that cannot finish inside it.
    const endsAt = 10_000;
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY, endsAt);

    // Plenty of time left: allowed.
    assert.deepEqual(budget.planRetry(0, null, 5_000), { retry: true, delayMs: 250 });

    // 9,900ms in: a 250ms sleep plus a call worth making does not fit before
    // 10,000ms, so it stops rather than burning the tail of the attempt.
    assert.deepEqual(budget.planRetry(0, null, 9_900), {
      retry: false,
      stop: 'deadlineTooClose',
    });
  });

  it('never lets a per-call escalation outlive the whole-attempt budget', () => {
    // One call retried as hard as it can be: 250 + 500 + 1000 = 1,750ms, three
    // retries, and then the per-call cap stops it — under both the 4-retry and
    // the 2,000ms attempt caps.
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    const delays: number[] = [];
    for (let callRetries = 0; ; callRetries++) {
      const plan = budget.planRetry(callRetries, null, 0);
      if (!plan.retry) {
        assert.equal(plan.stop, 'callRetriesExhausted');
        break;
      }
      delays.push(plan.delayMs);
      budget.recordRetry(plan.delayMs, 'call');
    }

    assert.deepEqual(delays, [250, 500, 1000]);
    assert.equal(budget.backoffUsedMs, 1_750);
    assert.ok(budget.backoffUsedMs < DEFAULT_RATE_LIMIT_POLICY.backoffBudgetMs);
  });
});

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

describe('a budget that stops says which limit it hit', () => {
  it('reports the per-call cap separately from the per-attempt cap', () => {
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    assert.deepEqual(budget.planRetry(3, null, 0), {
      retry: false,
      stop: 'callRetriesExhausted',
    });

    // Spend the attempt's retry allowance on other calls, then ask again as a
    // fresh call: the per-call counter is 0 but the attempt is out.
    for (let i = 0; i < DEFAULT_RATE_LIMIT_POLICY.maxRetriesPerAttempt; i++) {
      budget.recordRetry(0, 'other call');
    }
    assert.deepEqual(budget.planRetry(0, null, 0), {
      retry: false,
      stop: 'attemptRetriesExhausted',
    });
  });

  it('reports a spent backoff budget as its own reason', () => {
    const budget = new RateLimitBudget({
      ...DEFAULT_RATE_LIMIT_POLICY,
      maxRetriesPerAttempt: 99,
      backoffBudgetMs: 300,
    });
    budget.recordRetry(250, 'first');
    // A second 250ms sleep would take the total to 500ms against a 300ms budget.
    assert.deepEqual(budget.planRetry(0, null, 0), {
      retry: false,
      stop: 'backoffBudgetSpent',
    });
  });

  it('honours a Retry-After longer than our schedule, and stops when it will not fit', () => {
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    // Server says 1s; our first step is 250ms. The server wins.
    assert.deepEqual(budget.planRetry(0, 1_000, 0), { retry: true, delayMs: 1_000 });

    // Server says 3s, which exceeds the whole 2,000ms backoff budget. We do not
    // retry early inside the window it named — that would spend an attempt to be
    // refused again — so we stop and say so.
    const fresh = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    assert.deepEqual(fresh.planRetry(0, 3_000, 0), {
      retry: false,
      stop: 'backoffBudgetSpent',
    });
  });
});

// ---------------------------------------------------------------------------
// The failure a persistent 429 produces
// ---------------------------------------------------------------------------

describe('RateLimitExhaustedError names the 429s', () => {
  it('says it was rate limited, how much it spent, and why it stopped', () => {
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    budget.recordRetry(250, 'x');
    budget.recordRetry(500, 'x');
    const error = new RateLimitExhaustedError('simulateTransaction', budget, 'backoffBudgetSpent');

    assert.match(error.message, /rate limited \(HTTP 429\)/);
    assert.match(error.message, /simulateTransaction/);
    assert.match(error.message, /2 retries/);
    assert.match(error.message, /750ms of backoff/);
    assert.match(error.message, /spent its backoff budget/);
    // The distinction a reader of an alert has to be able to make.
    assert.match(error.message, /not the protocol being unreadable/);
  });

  it('is recognisable without instanceof, across bundle boundaries', () => {
    // @stenion/core is bundled separately into the dashboard's serverless
    // functions and into the indexer, so `instanceof` can compare two copies of
    // the class. Detection is on the stamped `name`, which is a literal and
    // therefore survives minification — see ProtocolMetadata.adapterRef.
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    const real = new RateLimitExhaustedError('x', budget, 'callRetriesExhausted');
    assert.equal(isRateLimitExhausted(real), true);

    const copy = new Error(real.message);
    copy.name = 'RateLimitExhaustedError';
    assert.equal(isRateLimitExhausted(copy), true, 'a cross-bundle copy must still be recognised');

    // And nothing else is mistaken for it.
    assert.equal(
      isRateLimitExhausted(new Error('attempt exceeded its 10000ms time budget')),
      false,
    );
    assert.equal(isRateLimitExhausted(new Error('Soroban RPC unreachable')), false);
    assert.equal(isRateLimitExhausted(null), false);
  });

  it('singularises one retry', () => {
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    budget.recordRetry(250, 'x');
    const error = new RateLimitExhaustedError('x', budget, 'callRetriesExhausted');
    assert.match(error.message, /1 retry and/);
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe('the ambient budget is per attempt, not per process', () => {
  it('is null outside any scope, so a direct fetch still works', () => {
    assert.equal(currentRateLimitBudget(), null);
  });

  it('keeps two concurrent attempts budgets apart', async () => {
    // The reason this is AsyncLocalStorage and not a module-level variable.
    // STENION_CYCLE_CONCURRENCY is 1 today and is under review; a shared mutable
    // would have each target's retries silently spend the other's allowance the
    // day it is raised, and the symptom would be one target failing for reasons
    // that happened inside another.
    const a = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    const b = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);

    const seen: string[] = [];
    const task = (budget: RateLimitBudget, label: string, retries: number) =>
      runWithRateLimitBudget(budget, async () => {
        for (let i = 0; i < retries; i++) {
          await new Promise((r) => setImmediate(r));
          const ambient = currentRateLimitBudget();
          assert.equal(ambient, budget, `${label} saw another attempt's budget`);
          ambient?.recordRetry(10, label);
        }
        seen.push(label);
        return label;
      });

    await Promise.all([task(a, 'a', 3), task(b, 'b', 1)]);

    assert.deepEqual(seen.sort(), ['a', 'b']);
    assert.equal(a.retriesUsed, 3);
    assert.equal(b.retriesUsed, 1, "b must not have been charged for a's retries");
    assert.equal(currentRateLimitBudget(), null, 'the scope must not leak past the attempt');
  });
});
