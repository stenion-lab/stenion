// Tests for the indexer's run loop, and specifically its error model.
//
// WHY THESE EXIST: the contract is that adapters throw and the indexer catches,
// records a failed run, and carries on — one protocol failing must never abort
// the cycle or lose another protocol's score. As of 2026-08-16 the production
// `risk_scores` table holds 1,683 rows and **zero** failed ones, so this entire
// path has never executed against real data. "It works in production" is not
// evidence here; a deliberately throwing adapter is.
//
// Everything is in-memory: a fake Store records what it was asked to write, and
// fake adapters decide whether to throw. No pg, no RPC, no env.
//
// Run with: pnpm --filter @stenion/indexer test

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_CONCURRENCY,
  cycleFeasibility,
  cycleWaves,
  feasibilityWarning,
  orderByLatency,
  runCycle,
  targetDeadline,
  toTarget,
  type CycleOptions,
  type IndexTarget,
} from './cycle.ts';
import type { StreakAlert } from './alerts.ts';
import {
  DEFAULT_RATE_LIMIT_POLICY,
  OperationalLevel,
  RateLimitBudget,
  RateLimitExhaustedError,
  currentRateLimitBudget,
} from '@stenion/core';
import type {
  Adapter,
  OperationalState,
  ProtocolMetadata,
  RiskFactorMap,
  RiskScoreResult,
} from '@stenion/core';
import type { RecentRun, RunRecord, Store } from '@stenion/db';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A Store that keeps writes in an array, and can be told to fail them.
 *
 * `history` seeds pre-existing runs per protocol (newest first) so a failure
 * streak can be set up deliberately — the only way to test that path, since
 * `risk_scores` has never held a failed row and was truncated on 2026-08-19.
 * Newly-written records are prepended, so `listRecentRuns` sees the run this
 * cycle just recorded exactly as the real Store would.
 */
function fakeStore(
  opts: { failWrites?: boolean; failReads?: boolean; history?: Record<string, RecentRun[]> } = {},
) {
  const written: RunRecord[] = [];
  const history: Record<string, RecentRun[]> = structuredClone(opts.history ?? {});

  const store: Store = {
    async upsertProtocol() {},
    async insertRunRecord(record) {
      if (opts.failWrites) throw new Error('connection terminated unexpectedly');
      written.push(record);
      (history[record.protocolId] ??= []).unshift({
        status: record.status,
        error: record.status === 'failed' ? record.error : null,
        runAt: record.runAt,
      });
    },
    async listProtocolsWithLatestScore() {
      return [];
    },
    async getProtocolDetail() {
      return null;
    },
    // Health reads nothing this fake models — the cycle never calls it. Present
    // only to satisfy the Store interface.
    async listRunHealth() {
      return [];
    },
    async listRecentRuns(protocolId, limit) {
      if (opts.failReads) throw new Error('connection terminated unexpectedly');
      return (history[protocolId] ?? []).slice(0, limit);
    },
  };
  return { store, written, history };
}

/** A run of consecutive failures, newest first, on the 5-minute cadence. */
function failedRuns(n: number, error = 'Soroban RPC unreachable'): RecentRun[] {
  return Array.from({ length: n }, (_, i) => ({
    status: 'failed' as const,
    error,
    runAt: new Date(Date.parse('2026-08-19T12:00:00.000Z') - (i + 1) * 5 * 60_000).toISOString(),
  }));
}

/** Capture alerts instead of POSTing them. */
function fakeNotifier() {
  const batches: StreakAlert[][] = [];
  const notifier = async (alerts: StreakAlert[]) => void batches.push(alerts);
  return { notifier, batches, all: () => batches.flat() };
}

/** Alerting on, retry off — so streak tests aren't also testing the backoff. */
function alerting(over: Partial<CycleOptions> = {}): CycleOptions {
  return { alertThreshold: 4, ...over };
}

const FACTORS = {
  collateralSafety: { value: 70, weight: 0.2, detail: 'x' },
  oracleSafety: { value: 100, weight: 0.25, detail: 'x' },
  adminKeySafety: { value: 40, weight: 0.2, detail: 'x' },
  liquiditySafety: { value: 22, weight: 0.15, detail: 'x' },
  utilizationSafety: { value: 14, weight: 0.2, detail: 'x' },
} as unknown as RiskFactorMap;

const COMPUTED_AT = new Date('2026-08-16T10:00:00.000Z');

/**
 * A stand-in operational state. Deliberately `Active`/empty: these tests are
 * about the run loop, not about classification, and a restricted state here
 * would read as a claim about a fake protocol. The rules that turn on a real
 * state are tested in @stenion/core and in the adapters.
 */
const OPERATIONAL_STATE: OperationalState<'lending'> = {
  level: OperationalLevel.Active,
  source: 'fake',
  blocked: [],
  origin: 'indeterminate',
  detail: 'fixture',
  asOf: COMPUTED_AT.toISOString(),
};

/** A target that succeeds with a fixed score. */
function okTarget(id: string, safetyScore = 53): IndexTarget {
  return {
    metadata: { id, name: id, chain: 'stellar', category: 'lending', adapterRef: 'FakeAdapter' },
    run: async () => ({
      safetyScore,
      factors: FACTORS,
      operationalState: OPERATIONAL_STATE,
      computedAt: COMPUTED_AT,
    }),
  };
}

/** A target whose adapter throws, the way a real one does on RPC failure. */
function throwingTarget(id: string, thrown: unknown = new Error('Soroban RPC unreachable')) {
  return {
    metadata: {
      id,
      name: id,
      chain: 'stellar' as const,
      category: 'lending' as const,
      adapterRef: 'FakeAdapter',
    },
    run: async () => {
      throw thrown;
    },
  };
}

// Silence the loop's console output; it logs every run by design.
let logs: string[] = [];
beforeEach(() => {
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.join(' '));
  console.warn = (...a: unknown[]) => void logs.push(a.join(' '));
});

// ---------------------------------------------------------------------------

describe('runCycle — a throwing adapter records a failed run', () => {
  it('writes a failed record instead of propagating the error', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('blend')], store);

    assert.equal(written.length, 1);
    const record = written[0];
    assert.equal(record.status, 'failed');
    assert.equal(record.protocolId, 'blend');
    assert.equal(summary.failed, 1);
  });

  it("carries the adapter's own error message, not a generic one", async () => {
    // The message is the only diagnostic that survives into the database, so it
    // must be the adapter's, verbatim.
    const { store, written } = fakeStore();
    await runCycle([throwingTarget('blend', new Error('no ResConfig for asset CXYZ'))], store);

    const record = written[0];
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'no ResConfig for asset CXYZ');
  });

  it('survives a thrown non-Error without producing "[object Object]"', async () => {
    // Nothing guarantees a throw is an Error — a rejected fetch or a bare
    // `throw 'boom'` both reach here, and the record must still be readable.
    for (const [thrown, expected] of [
      ['boom', 'boom'],
      [404, '404'],
      [{ code: 'ETIMEDOUT' }, '[object Object]'],
    ] as const) {
      const { store, written } = fakeStore();
      await runCycle([throwingTarget('blend', thrown)], store);
      const record = written[0];
      assert.equal(record.status, 'failed');
      assert.equal(record.error, expected);
      assert.ok(typeof record.error === 'string' && record.error.length > 0);
    }
  });

  it('records a failed run with no score, so nothing fabricates a number', async () => {
    const { store, written } = fakeStore();
    await runCycle([throwingTarget('blend')], store);

    const record = written[0] as Record<string, unknown>;
    assert.equal(record.status, 'failed');
    // The persisted union's failed arm carries no score, factors, or
    // methodologyVersion — the DB CHECK enforces the same split.
    assert.equal(record.safetyScore, undefined);
    assert.equal(record.factors, undefined);
    assert.equal(record.methodologyVersion, undefined);
    assert.equal(record.computedAt, undefined);
    assert.ok(typeof record.runAt === 'string', 'a failed run still has a runAt');
  });
});

describe('runCycle — one failure never affects another protocol', () => {
  it('keeps scoring the remaining targets after one throws', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle(
      [okTarget('alpha', 61), throwingTarget('beta'), okTarget('gamma', 47)],
      store,
    );

    assert.equal(summary.ran, 3);
    assert.equal(summary.ok, 2);
    assert.equal(summary.failed, 1);
    // Sorted, because targets run concurrently and the DB writes genuinely
    // interleave — write ORDER is not a property of this cycle and asserting it
    // would be asserting the scheduler's internals. What must hold is that every
    // target got written, with its own outcome. The ORDERED thing is
    // `summary.results`, asserted separately.
    assert.deepEqual(written.map((r) => [r.protocolId, r.status]).sort(), [
      ['alpha', 'ok'],
      ['beta', 'failed'],
      ['gamma', 'ok'],
    ]);
    assert.deepEqual(
      summary.results.map((r) => r.id),
      ['alpha', 'beta', 'gamma'],
      'the summary reads in registration order regardless of who finished first',
    );
  });

  it('still scores later targets when the FIRST one throws', async () => {
    // Ordering matters: an early failure aborting the loop would silently stop
    // every target behind it — and with three registered, losing the first one
    // costs two thirds of the registry.
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('blend'), okTarget('kinetic', 24)], store);

    assert.equal(summary.ok, 1);
    const kinetic = written.find((r) => r.protocolId === 'kinetic');
    assert.ok(kinetic && kinetic.status === 'ok');
    assert.equal(kinetic.safetyScore, 24);
  });

  it('handles every target failing without throwing', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('a'), throwingTarget('b')], store);

    assert.deepEqual(
      { ran: summary.ran, ok: summary.ok, failed: summary.failed },
      {
        ran: 2,
        ok: 0,
        failed: 2,
      },
    );
    assert.equal(written.length, 2);
  });

  it('returns an empty summary for no targets', async () => {
    const { store } = fakeStore();
    const summary = await runCycle([], store);
    const { totalMs, ...rest } = summary;
    assert.deepEqual(rest, { ran: 0, ok: 0, failed: 0, results: [] });
    assert.equal(typeof totalMs, 'number');
  });
});

describe('runCycle — a database failure does not abort the cycle', () => {
  it('keeps running when every write fails', async () => {
    // The write is caught separately from the adapter run, so an unreachable
    // database degrades to "nothing recorded" rather than "the cycle died".
    const { store } = fakeStore({ failWrites: true });
    const summary = await runCycle([okTarget('alpha'), okTarget('beta')], store);

    assert.equal(summary.ran, 2);
    assert.equal(summary.ok, 2, 'the runs still succeeded — only persistence failed');
    assert.ok(
      logs.some((l) => l.includes('DB write failed')),
      'a failed write must be logged, not swallowed silently',
    );
  });

  it('reports a run as ok even if its record could not be stored', async () => {
    // Deliberate: the summary describes what the cycle *did*, and the cron route
    // reports it. Conflating a storage failure with a scoring failure would
    // misattribute an infrastructure problem to the protocol.
    const { store } = fakeStore({ failWrites: true });
    const summary = await runCycle([okTarget('alpha', 61)], store);
    const [{ durationMs, ...result }] = summary.results;
    assert.deepEqual(result, { id: 'alpha', status: 'ok', safetyScore: 61, attempts: 1 });
    assert.equal(typeof durationMs, 'number');
  });
});

describe('runCycle — the ok record', () => {
  it('stamps the methodology version from core, not from the adapter', async () => {
    // One rulebook applies to every protocol IN A CATEGORY, so the version is a
    // property of the run. An adapter has no say in it — that is what keeps
    // stored history interpretable. What the adapter DOES say is which category
    // it belongs to, which is what selects the counter.
    const { METHODOLOGY_VERSIONS } = await import('@stenion/core');
    const { store, written } = fakeStore();
    await runCycle([okTarget('blend')], store);

    const record = written[0];
    assert.equal(record.status, 'ok');
    assert.equal(record.methodologyVersion, METHODOLOGY_VERSIONS.lending);
  });

  it("stamps the target's own category, so the version stays interpretable", async () => {
    // The pair is the identifier of a rulebook, not the integer: every
    // category's counter starts at 1, so a stored `methodologyVersion: 1` says
    // nothing on its own once a second category exists. Migration 0008.
    //
    // Resolved from target.metadata.category rather than from a global
    // constant — that is the whole difference between this and the scalar it
    // replaced, and it is what makes a second category a config change here
    // rather than a code change.
    const { store, written } = fakeStore();
    await runCycle([okTarget('blend')], store);

    const record = written[0];
    assert.equal(record.status, 'ok');
    assert.equal(record.category, 'lending');
  });

  it('records no category on a failed run, because nothing was scored', async () => {
    // Same discriminated union methodologyVersion follows: a failed run
    // produced no score, so there is no rulebook to attribute it to. Writing
    // `lending` here would claim a lending score was computed when none was.
    const { store, written } = fakeStore();
    await runCycle([throwingTarget('blend')], store);

    const record = written[0];
    assert.equal(record.status, 'failed');
    assert.ok(!('category' in record), 'a failed record must not carry a category');
  });

  it('persists the score, factors and both timestamps as ISO strings', async () => {
    const { store, written } = fakeStore();
    await runCycle([okTarget('blend', 53)], store);

    const record = written[0];
    assert.equal(record.status, 'ok');
    assert.equal(record.safetyScore, 53);
    assert.equal(record.factors, FACTORS);
    assert.equal(record.computedAt, COMPUTED_AT.toISOString());
    assert.match(record.runAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

describe('toTarget — the adapter pipeline wrapper', () => {
  /**
   * A minimal adapter with its own raw shape, to prove TRawData stays internal.
   *
   * `Adapter<{ n: number }, 'lending'>` — the category is spelled out, because
   * the factor map is derived from it. A bare `Adapter<{ n: number }>`
   * defaults the category to the whole union, so its factor map is the union of
   * every category's and `RiskFactorMap` is no longer what it owes. Naming the
   * category is the fix, and it is the same thing every real adapter does.
   */
  function fakeAdapter(id: string, calls: string[]): Adapter<{ n: number }, 'lending'> {
    return {
      metadata: {
        id,
        name: id,
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      } as ProtocolMetadata<'lending'>,
      async fetchRawData() {
        calls.push('fetchRawData');
        return { n: 1 };
      },
      async computeRiskFactors(raw) {
        calls.push(`computeRiskFactors(${raw.n})`);
        return FACTORS;
      },
      score(factors): RiskScoreResult {
        calls.push('score');
        return { score: 53, factors, computedAt: COMPUTED_AT };
      },
      operationalState(raw) {
        calls.push(`operationalState(${raw.n})`);
        return OPERATIONAL_STATE;
      },
    };
  }

  it('runs fetch → compute → score in order, threading the raw data through', async () => {
    const calls: string[] = [];
    const target = toTarget(fakeAdapter('blend', calls));
    const out = await target.run();

    assert.deepEqual(calls, [
      'fetchRawData',
      'computeRiskFactors(1)',
      'score',
      // Same `raw`, not a second fetch — see IndexTarget.run.
      'operationalState(1)',
    ]);
    assert.equal(out.safetyScore, 53);
    assert.equal(out.computedAt, COMPUTED_AT);
  });

  it('carries adapterRef through from metadata, independent of the class name', async () => {
    // This is what lands in the protocols table's `adapter` column.
    //
    // The class here is deliberately named something OTHER than its adapterRef.
    // The previous version of this test read the value off `constructor.name`
    // and asserted it equalled the class name — which passes under `node --test`
    // and in dev, and passed the whole time production was writing `w` to every
    // row, because minification renames classes in the bundled serverless build
    // and nothing unminified ever exercised that path. Asserting on a value the
    // build is free to rewrite is what made the test worthless. Naming the class
    // `MinifiedToSomethingElse` means this can only pass if the literal on
    // `metadata` is the thing being persisted.
    class MinifiedToSomethingElse implements Adapter<{ n: number }, 'lending'> {
      metadata = {
        id: 'blend',
        name: 'Blend',
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'BlendAdapter',
      } as ProtocolMetadata<'lending'>;
      async fetchRawData() {
        return { n: 1 };
      }
      async computeRiskFactors() {
        return FACTORS;
      }
      score(factors: RiskFactorMap): RiskScoreResult {
        return { score: 1, factors, computedAt: COMPUTED_AT };
      }
      operationalState(): OperationalState<'lending'> {
        return OPERATIONAL_STATE;
      }
    }

    const target = toTarget(new MinifiedToSomethingElse());
    assert.equal(target.metadata.adapterRef, 'BlendAdapter');
    assert.notEqual(target.metadata.adapterRef, MinifiedToSomethingElse.name);
  });

  it('lets a failure anywhere in the pipeline surface to runCycle', async () => {
    // Each stage throws for real reasons — RPC down, a price that won't decode.
    // None of them may be swallowed inside the wrapper.
    for (const stage of [
      'fetchRawData',
      'computeRiskFactors',
      'score',
      'operationalState',
    ] as const) {
      const adapter = fakeAdapter('blend', []);
      const boom = new Error(`${stage} exploded`);
      Object.assign(adapter, {
        [stage]: () => {
          throw boom;
        },
      });

      const { store, written } = fakeStore();
      const summary = await runCycle([toTarget(adapter)], store);
      assert.equal(summary.failed, 1, `a throw in ${stage} should be recorded as failed`);
      assert.equal(written[0].status === 'failed' && written[0].error, `${stage} exploded`);
    }
  });
});

// ---------------------------------------------------------------------------
// Retry, inside the run loop
// ---------------------------------------------------------------------------

/** A target that throws for its first `failures` calls, then succeeds. */
function flakyTarget(id: string, failures: number, safetyScore = 53) {
  let calls = 0;
  const target: IndexTarget = {
    metadata: { id, name: id, chain: 'stellar', category: 'lending', adapterRef: 'FakeAdapter' },
    run: async () => {
      calls++;
      if (calls <= failures) throw new Error('Soroban RPC unreachable');
      return {
        safetyScore,
        factors: FACTORS,
        operationalState: OPERATIONAL_STATE,
        computedAt: COMPUTED_AT,
      };
    },
  };
  return { target, calls: () => calls };
}

const RETRY: CycleOptions = {
  retry: { attempts: 3, baseDelayMs: 1, attemptTimeoutMs: 5000, minAttemptMs: 1 },
};

describe('runCycle — retry reduces false failures', () => {
  it('records ok when a transient failure clears on a later attempt', async () => {
    // The whole point: an RPC blip on the first attempt must not become a
    // permanent hole in this protocol's history.
    const { store, written } = fakeStore();
    const flaky = flakyTarget('blend', 2, 61);
    const summary = await runCycle([flaky.target], store, RETRY);

    assert.equal(flaky.calls(), 3);
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 0);
    assert.equal(written[0].status === 'ok' && written[0].safetyScore, 61);
    assert.equal(summary.results[0].attempts, 3, 'the summary says it took three goes');
  });

  it('does not retry a run that succeeded first time', async () => {
    const { store } = fakeStore();
    const flaky = flakyTarget('blend', 0);
    const summary = await runCycle([flaky.target], store, RETRY);

    assert.equal(flaky.calls(), 1);
    assert.equal(summary.results[0].attempts, 1);
  });
});

describe('runCycle — retry never hides a real failure', () => {
  it('still records `failed` after exhausting every attempt', async () => {
    // The invariant that lets retry exist at all. A protocol that is genuinely
    // down must still show as down — retries change how often we cry wolf, not
    // what a failure is.
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('blend')], store, RETRY);

    assert.equal(written.length, 1);
    assert.equal(written[0].status, 'failed');
    assert.equal(summary.failed, 1);
    assert.equal(summary.ok, 0);
  });

  it("keeps the adapter's own final error, not a retry-flavoured wrapper", async () => {
    const { store, written } = fakeStore();
    await runCycle(
      [throwingTarget('blend', new Error('no ResConfig for asset CXYZ'))],
      store,
      RETRY,
    );

    assert.equal(written[0].status === 'failed' && written[0].error, 'no ResConfig for asset CXYZ');
  });

  it('makes exactly the configured number of attempts before giving up', async () => {
    const { store } = fakeStore();
    const flaky = flakyTarget('blend', Infinity);
    await runCycle([flaky.target], store, RETRY);
    assert.equal(flaky.calls(), 3);
  });

  it('records a failed run with no score, exactly as before retry existed', async () => {
    const { store, written } = fakeStore();
    await runCycle([throwingTarget('blend')], store, RETRY);

    const record = written[0] as Record<string, unknown>;
    assert.equal(record.status, 'failed');
    assert.equal(record.safetyScore, undefined);
    assert.equal(record.factors, undefined);
  });
});

describe('cycleWaves + cycleFeasibility — the ceiling is arithmetic, not folklore', () => {
  it('counts waves as ceil(targets / concurrency)', () => {
    assert.equal(cycleWaves(0, 2), 0);
    assert.equal(cycleWaves(1, 2), 1);
    assert.equal(cycleWaves(4, 2), 2);
    assert.equal(cycleWaves(5, 2), 3);
    // Nonsense inputs must not produce a negative reservation, which would hand
    // a target MORE than the budget.
    assert.equal(cycleWaves(-3, 2), 0);
    assert.equal(cycleWaves(4, 0), 4);
  });

  it('holds at five targets and fails at six, on the shipped defaults', () => {
    // This is the number the whole change exists to make checkable, and these
    // ARE the shipped defaults — 50s budget, 10s attempt timeout, 1 at a time.
    // Keep them in step with config.ts: a test asserting a ceiling from numbers
    // the indexer no longer runs is worse than no test, because it still passes.
    const at = (targetCount: number) =>
      cycleFeasibility({ targetCount, concurrency: 1, attemptTimeoutMs: 10_000, budgetMs: 50_000 });

    assert.equal(at(4).feasible, true, 'the four lending targets, unchanged');
    assert.equal(
      at(5).feasible,
      true,
      'five targets today — the four lending markets plus one Aquarius pool',
    );
    assert.equal(at(6).feasible, false);
    assert.deepEqual(
      { waves: at(6).waves, requiredMs: at(6).requiredMs },
      { waves: 6, requiredMs: 60_000 },
      'a sixth target needs 60s of attempts, which IS the maxDuration ceiling — ' +
        'so it can never come from the budget',
    );
  });

  it('was infeasible at five on the old 42s budget, which is why it moved', () => {
    // The state registering the first dex market had to resolve: at the old 42s
    // budget, registering ANY dex market at all made the cycle infeasible,
    // whichever market it was. Pinned so the reason the default changed stays checkable
    // after the default itself has moved on.
    const old = cycleFeasibility({
      targetCount: 5,
      concurrency: 1,
      attemptTimeoutMs: 10_000,
      budgetMs: 42_000,
    });
    assert.equal(old.feasible, false, '5 x 10s = 50s > 42s');
  });

  it('would have warned every cycle at the old 15s timeout, which is why it moved', () => {
    // The 429 fix was concurrency 1, and concurrency 1 at a 15s attempt timeout
    // is infeasible at THREE targets — the registry as it stands. Lowering the
    // timeout to 10s (justified by the deployed measurement: nothing healthy
    // exceeds 6.1s) is the half of the fix that stops the guard crying wolf.
    const old = cycleFeasibility({
      targetCount: 3,
      concurrency: 1,
      attemptTimeoutMs: 15_000,
      budgetMs: 42_000,
    });
    assert.equal(old.feasible, false, '3 x 15s = 45s > 42s');
  });

  it('is a budget question, not a concurrency one — both dials move the same ceiling', () => {
    // Worth pinning because the first fix reached for concurrency and the second
    // reached for the timeout, and they are the same lever seen from two sides.
    // Four targets fit either way; what differs is the load on the RPC.
    const cheap = cycleFeasibility({
      targetCount: 4,
      concurrency: 1,
      attemptTimeoutMs: 10_000,
      budgetMs: 42_000,
    });
    const loud = cycleFeasibility({
      targetCount: 4,
      concurrency: 2,
      attemptTimeoutMs: 15_000,
      budgetMs: 42_000,
    });
    assert.equal(cheap.feasible, true);
    assert.equal(loud.feasible, true);
    // ...and only one of them survived contact with the public RPC.
    assert.ok(cheap.requiredMs < loud.requiredMs * 2);
  });

  it('has nothing to say when there is no bound to check', () => {
    // An unbounded attempt or budget makes the question meaningless rather than
    // failed — a caller passing no retry policy must not be warned at.
    const f = cycleFeasibility({
      targetCount: 99,
      concurrency: 1,
      attemptTimeoutMs: Number.POSITIVE_INFINITY,
      budgetMs: Number.POSITIVE_INFINITY,
    });
    assert.equal(f.feasible, true);
    assert.equal(feasibilityWarning(f, 99), null);
  });

  it('names the actual numbers in the warning, and the levers', () => {
    const f = cycleFeasibility({
      targetCount: 5,
      concurrency: 2,
      attemptTimeoutMs: 15_000,
      budgetMs: 42_000,
    });
    const warning = feasibilityWarning(f, 5);
    assert.ok(warning, 'an infeasible cycle must warn');
    for (const fragment of ['5 targets', '45000ms', '42000ms', 'STENION_CYCLE_CONCURRENCY']) {
      assert.ok(warning.includes(fragment), `the warning should mention ${fragment}: ${warning}`);
    }
  });
});

describe('targetDeadline — a deadline that does not collapse as targets are added', () => {
  const BUDGET_ENDS_AT = 42_000;
  const base = { budgetEndsAt: BUDGET_ENDS_AT, now: 0, concurrency: 2, attemptTimeoutMs: 15_000 };

  it('guarantees every target one full attempt at any feasible target count', () => {
    // THE REGRESSION THIS PINS. Under the old rule the first target's deadline
    // was budgetMs / targetCount: 14s at three targets and 10.5s at four — and
    // 10.5s is below the *healthy* fetch duration of Kinetic (7.7-10.5s) and
    // YieldBlox (8.1-12.5s) as measured on a developer machine, which is what
    // was known when the rule was changed. Registering a pool could therefore
    // fail protocols that already worked. Whatever else changes, that must never
    // come back. (The deployed function is 2-3x faster — see ARCHITECTURE.md —
    // so the bar below is the conservative one, deliberately.)
    for (const targetCount of [1, 2, 3, 4]) {
      const deadline = targetDeadline({ ...base, queuedAfter: targetCount - 1 });
      assert.ok(
        deadline >= base.attemptTimeoutMs,
        `at ${targetCount} targets the first deadline was ${deadline}ms, ` +
          `below one ${base.attemptTimeoutMs}ms attempt`,
      );
      const evenShare = BUDGET_ENDS_AT / targetCount;
      assert.ok(
        deadline >= evenShare,
        `at ${targetCount} targets the new rule (${deadline}ms) must not be worse ` +
          `than the even division it replaced (${evenShare}ms)`,
      );
    }
  });

  it('clears the slowest observed healthy fetch at four targets, where the old rule did not', () => {
    // The slowest healthy fetch ever observed anywhere: YieldBlox at 12.5s on a
    // developer machine (2026-08-19). Deployed, nothing exceeds 6.1s — so this
    // is the conservative bar, kept deliberately rather than relaxed to the
    // measured one. The old rule gave the first of four targets 10.5s.
    const SLOWEST_HEALTHY_MS = 12_500;
    const deadline = targetDeadline({ ...base, queuedAfter: 3 });
    assert.ok(deadline >= SLOWEST_HEALTHY_MS, `${deadline}ms would cut off a HEALTHY YieldBlox`);
    assert.ok(42_000 / 4 < SLOWEST_HEALTHY_MS, 'the old rule really was below it');
  });

  it('hands slack on when the queue drains, rather than planning it up front', () => {
    // The one property of the old rule worth keeping: `queuedAfter` is read when
    // a worker picks a target up, so a target that finished early has already
    // shortened the queue and the next one sees a longer deadline for free.
    const withQueue = targetDeadline({ ...base, now: 8_000, queuedAfter: 2 });
    const drained = targetDeadline({ ...base, now: 8_000, queuedAfter: 0 });
    assert.ok(drained > withQueue);
    assert.equal(drained, BUDGET_ENDS_AT, 'the last target may use the whole remaining budget');
  });

  it('reserves nothing when the attempt timeout is unbounded', () => {
    // The no-retry default. A caller that passes no policy gets the whole budget,
    // exactly as it did before any of this existed.
    assert.equal(
      targetDeadline({ ...base, queuedAfter: 5, attemptTimeoutMs: Number.POSITIVE_INFINITY }),
      BUDGET_ENDS_AT,
    );
  });

  it('degrades past the ceiling to whole attempts first-come, not a squeeze for everyone', () => {
    // Five targets at concurrency 2 is infeasible (45s of attempts, 42s budget).
    // The wrong answer is 8.4s each — a length at which nothing can succeed. The
    // right one is full attempts while the clock allows and a clean, visible
    // failure for the tail.
    const first = targetDeadline({ ...base, queuedAfter: 4 });
    assert.equal(first, base.attemptTimeoutMs, 'still a whole attempt, not a fifth of the budget');
  });

  it('grants nothing once the budget is genuinely spent', () => {
    // A target picked up after an earlier one overran its soft timeout must fail
    // fast rather than start work the 60s function cannot finish.
    const deadline = targetDeadline({ ...base, now: 100_000, queuedAfter: 0 });
    assert.ok(deadline <= 100_000, 'a blown budget must not be topped back up by the floor');
  });
});

describe('runCycle — the cycle budget is a hard ceiling', () => {
  it('lets one protocol exhaust its deadline without costing the other a turn', async () => {
    // The requirement this pins, unchanged from the old division rule: one
    // protocol failing must not spend the other's budget. Concurrency 1 so the
    // fake clock models real elapsed time — a shared mutable counter cannot
    // represent two targets advancing it at once.
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const { store, written } = fakeStore();

    const blend: IndexTarget = {
      metadata: {
        id: 'blend',
        name: 'blend',
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      },
      run: async () => {
        // Each attempt runs to its cap, as the SOFT timeout permits — it
        // abandons the attempt rather than cancelling it, so an attempt can and
        // does overrun the remaining budget.
        t += 15_000;
        throw new Error('hung rpc');
      },
    };

    const summary = await runCycle([blend, okTarget('kinetic', 24)], store, {
      retry: { attempts: 3, baseDelayMs: 1000, attemptTimeoutMs: 15_000, minAttemptMs: 1000 },
      budgetMs: 42_000,
      concurrency: 1,
      deps,
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.ok, 1, 'kinetic still ran after blend spent its entire deadline');
    assert.deepEqual(
      written.map((r) => [r.protocolId, r.status]),
      [
        ['blend', 'failed'],
        ['kinetic', 'ok'],
      ],
    );
    assert.ok(t <= 42_000, `the cycle stayed inside its budget (ended at ${t}ms)`);
  });

  it('fails a later protocol fast and cleanly if the budget is genuinely gone', async () => {
    // If something overran far past its deadline, the 60s function is already
    // lost. Starting work that will be killed mid-flight is the worst outcome —
    // it can leave a protocol neither scored NOR recorded. Failing immediately at
    // least writes an honest `failed` row that says we never got to look.
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const { store, written } = fakeStore();
    let kineticStarted = 0;

    const runaway: IndexTarget = {
      metadata: {
        id: 'blend',
        name: 'blend',
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      },
      run: async () => {
        t += 100_000;
        throw new Error('hung rpc');
      },
    };
    const kinetic: IndexTarget = {
      metadata: {
        id: 'kinetic',
        name: 'kinetic',
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      },
      run: async () => {
        kineticStarted++;
        return {
          safetyScore: 24,
          factors: FACTORS,
          operationalState: OPERATIONAL_STATE,
          computedAt: COMPUTED_AT,
        };
      },
    };

    const summary = await runCycle([runaway, kinetic], store, {
      retry: { attempts: 3, baseDelayMs: 1000, attemptTimeoutMs: 15_000, minAttemptMs: 1000 },
      budgetMs: 42_000,
      concurrency: 1,
      deps,
    });

    assert.equal(kineticStarted, 0, 'no work is begun that cannot finish');
    assert.equal(summary.failed, 2);
    assert.deepEqual(
      written.map((r) => [r.protocolId, r.status]),
      [
        ['blend', 'failed'],
        ['kinetic', 'failed'],
      ],
    );
    assert.match(
      written[1].status === 'failed' ? written[1].error : '',
      /no time left in the cycle budget/,
      'the record says why, rather than blaming the protocol for something it did not do',
    );
  });

  it('stops retrying a protocol once its deadline is spent', async () => {
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const { store } = fakeStore();
    let calls = 0;
    const slow: IndexTarget = {
      metadata: {
        id: 'blend',
        name: 'blend',
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      },
      run: async () => {
        calls++;
        t += 15_000; // the attempt cap
        throw new Error('rpc timeout');
      },
    };

    await runCycle([slow, okTarget('kinetic')], store, {
      retry: { attempts: 3, baseDelayMs: 1000, attemptTimeoutMs: 15_000, minAttemptMs: 1000 },
      budgetMs: 42_000,
      concurrency: 1,
      deps,
    });

    // Blend's deadline is 42s less one 15s attempt reserved for the target still
    // queued behind it = 27s. One 15s attempt leaves 12s; after the 1s backoff a
    // second starts and (soft timeout) overruns to 31s. The third has nothing.
    assert.equal(calls, 2, 'the third attempt the policy allows had no budget');
    assert.ok(t <= 42_000, `the run loop stayed inside its budget (ended at ${t}ms)`);
  });

  it('warns, rather than refusing to run, when the registry outgrows the budget', async () => {
    // Refusing would take the whole registry down over a config question. Five
    // targets at concurrency 2 is infeasible; all five must still be attempted.
    const { store } = fakeStore();
    const summary = await runCycle(
      ['a', 'b', 'c', 'd', 'e'].map((id) => okTarget(id)),
      store,
      {
        retry: { attempts: 1, baseDelayMs: 0, attemptTimeoutMs: 15_000 },
        budgetMs: 42_000,
        concurrency: 2,
      },
    );

    assert.equal(summary.ok, 5, 'an infeasible budget is a warning, never a refusal to run');
    assert.ok(
      logs.some((l) => l.includes('[budget]') && l.includes('STENION_CYCLE_CONCURRENCY')),
      `the cycle must say so out loud; logs were: ${logs.join(' | ')}`,
    );
  });

  it('reports per-target and whole-cycle durations, so the budget can be checked in production', () => {
    // Not a behaviour test — a plumbing one. These numbers are the ONLY way the
    // arithmetic above gets validated against Vercel's path to the RPC rather
    // than a developer machine's, because the cron route spreads this summary
    // into its JSON response.
    return (async () => {
      let t = 0;
      const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
      const { store } = fakeStore();
      const slow: IndexTarget = {
        metadata: {
          id: 'slow',
          name: 'slow',
          chain: 'stellar',
          category: 'lending',
          adapterRef: 'FakeAdapter',
        },
        run: async () => {
          t += 9_000;
          return {
            safetyScore: 40,
            factors: FACTORS,
            operationalState: OPERATIONAL_STATE,
            computedAt: COMPUTED_AT,
          };
        },
      };

      const summary = await runCycle([slow, okTarget('fast')], store, {
        budgetMs: 42_000,
        concurrency: 1,
        deps,
      });

      assert.equal(summary.results[0].durationMs, 9_000);
      assert.equal(summary.results[1].durationMs, 0);
      assert.equal(summary.totalMs, 9_000);
    })();
  });
});

// ---------------------------------------------------------------------------
// Concurrency
//
// These use real promises rather than the fake clock. A fake clock is a shared
// mutable counter, and a shared mutable counter cannot represent two targets
// elapsing time simultaneously — driving concurrency with one would test the
// counter, not the pool. What matters here is not WHEN things happen but what
// is true regardless of when: the peak is bounded, the output is ordered, and
// nothing leaks between targets.
// ---------------------------------------------------------------------------

/** A target whose completion the test controls. */
function deferredTarget(id: string, safetyScore = 50) {
  let settle!: (fail?: unknown) => void;
  const gate = new Promise<void>((resolve, reject) => {
    settle = (fail?: unknown) => (fail === undefined ? resolve() : reject(fail));
  });
  let started = false;
  const target: IndexTarget = {
    metadata: { id, name: id, chain: 'stellar', category: 'lending', adapterRef: 'FakeAdapter' },
    run: async () => {
      started = true;
      await gate;
      return {
        safetyScore,
        factors: FACTORS,
        operationalState: OPERATIONAL_STATE,
        computedAt: COMPUTED_AT,
      };
    },
  };
  return {
    target,
    finish: () => settle(),
    fail: (e: unknown) => settle(e),
    hasStarted: () => started,
  };
}

describe('orderByLatency — slowest first, because the pool overlaps the rest', () => {
  const ids = (targets: IndexTarget[]) => targets.map((t) => t.metadata.id);

  it('puts the slowest measured target first and the fastest last', () => {
    // The order the indexer actually registers them in is BLEND_POOLS order
    // (blend, yieldblox) then kinetic. Deployed-function durations put Kinetic
    // slowest and Blend Fixed fastest — see ARCHITECTURE.md.
    const ordered = orderByLatency(['blend', 'yieldblox', 'kinetic'].map((id) => okTarget(id)));
    assert.deepEqual(ids(ordered), ['kinetic', 'yieldblox', 'blend']);
  });

  it('is the OPPOSITE of the order it replaced, and that is the point', () => {
    // Fastest-first was correct only under the budget-division rule, where the
    // first target got the tightest share. Under a worker pool a slow target
    // started last is a slow target nothing can overlap with.
    const ordered = orderByLatency(['blend', 'yieldblox', 'kinetic'].map((id) => okTarget(id)));
    assert.notDeepEqual(ids(ordered), ['blend', 'yieldblox', 'kinetic']);
    assert.equal(ids(ordered)[0], 'kinetic', 'the slowest adapter leads');
    assert.equal(ids(ordered).at(-1), 'blend', 'and the fastest is what the last wave gets');
  });

  it('treats an unmeasured target as the slowest, so a new pool is not squeezed', () => {
    // A pool registered in BLEND_POOLS that nobody has timed yet must not land
    // in the worst slot by default. Assumed-slowest is the conservative reading.
    const ordered = orderByLatency(
      ['blend', 'etherfuse', 'kinetic', 'yieldblox'].map((id) => okTarget(id)),
    );
    assert.equal(ids(ordered)[0], 'etherfuse');
  });

  it('keeps registration order between equally-ranked targets', () => {
    // Two unmeasured pools stay in BLEND_POOLS order rather than being
    // rearranged by a sort that had nothing to say about them.
    const ordered = orderByLatency(['new-a', 'new-b'].map((id) => okTarget(id)));
    assert.deepEqual(ids(ordered), ['new-a', 'new-b']);
  });

  it('does not mutate the list it was given', () => {
    const targets = ['blend', 'yieldblox'].map((id) => okTarget(id));
    orderByLatency(targets);
    assert.deepEqual(ids(targets), ['blend', 'yieldblox']);
  });
});

describe('runCycle — bounded concurrency', () => {
  it('defaults to one target in flight, because two was measured and 429d', () => {
    // Not a style preference. Concurrency 2 shipped and was reverted the same day
    // after mainnet.sorobanrpc.com began refusing the target that ran behind the
    // burst. Anyone raising this default should have to change this test, and
    // therefore read why. See ARCHITECTURE.md's incident note.
    assert.equal(DEFAULT_CONCURRENCY, 1);
  });

  it('runs targets one at a time when the caller says nothing', async () => {
    let inFlight = 0;
    let peak = 0;
    const { store } = fakeStore();
    const targets: IndexTarget[] = Array.from({ length: 4 }, (_, i) => ({
      metadata: {
        id: `p${i}`,
        name: `p${i}`,
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      },
      run: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return {
          safetyScore: 50,
          factors: FACTORS,
          operationalState: OPERATIONAL_STATE,
          computedAt: COMPUTED_AT,
        };
      },
    }));

    // No `concurrency` passed — this is what production runs.
    const summary = await runCycle(targets, store, {});
    assert.equal(summary.ok, 4);
    assert.equal(peak, 1, `peak in-flight was ${peak}; the shipped default must not burst`);
  });

  it('never has more than `concurrency` targets in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { store } = fakeStore();
    const targets: IndexTarget[] = Array.from({ length: 6 }, (_, i) => ({
      metadata: {
        id: `p${i}`,
        name: `p${i}`,
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      },
      run: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Two turns of the event loop, so an unbounded implementation would have
        // every target in flight at once by the time the first one resumes.
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return {
          safetyScore: 50,
          factors: FACTORS,
          operationalState: OPERATIONAL_STATE,
          computedAt: COMPUTED_AT,
        };
      },
    }));

    const summary = await runCycle(targets, store, { concurrency: 2 });

    assert.equal(summary.ok, 6);
    assert.equal(peak, 2, `peak in-flight was ${peak}, not the configured 2`);
  });

  it('really does overlap — the second target starts before the first finishes', async () => {
    const { store } = fakeStore();
    const a = deferredTarget('a');
    const b = deferredTarget('b');
    const cycle = runCycle([a.target, b.target], store, { concurrency: 2 });

    // Let the pool start both. Neither has been allowed to complete.
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(a.hasStarted() && b.hasStarted(), 'both targets should be in flight');

    a.finish();
    b.finish();
    assert.equal((await cycle).ok, 2);
  });

  it('holds the third target back until a worker frees up', async () => {
    const { store } = fakeStore();
    const [a, b, c] = ['a', 'b', 'c'].map((id) => deferredTarget(id));
    const cycle = runCycle([a.target, b.target, c.target], store, { concurrency: 2 });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(c.hasStarted(), false, 'the third target must wait for a free worker');

    a.finish();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(c.hasStarted(), true, 'and start as soon as one frees up');

    b.finish();
    c.finish();
    assert.equal((await cycle).ok, 3);
  });

  it('keeps results in registration order however completion is ordered', async () => {
    const { store } = fakeStore();
    const a = deferredTarget('alpha', 11);
    const b = deferredTarget('beta', 22);
    const cycle = runCycle([a.target, b.target], store, { concurrency: 2 });

    await Promise.resolve();
    await Promise.resolve();
    // Finish in the opposite order to registration.
    b.finish();
    await new Promise((r) => setTimeout(r, 0));
    a.finish();

    const summary = await cycle;
    assert.deepEqual(
      summary.results.map((r) => [r.id, r.safetyScore]),
      [
        ['alpha', 11],
        ['beta', 22],
      ],
      'a summary that reorders itself by whoever the RPC answered first is undiffable',
    );
  });

  it('produces byte-identical alerting at concurrency 1 and 2', async () => {
    // The streak read is per-protocol and sits inside its own target's task, and
    // the POST happens after the pool joins — so neither depends on how many
    // workers exist. Asserted rather than reasoned about, because the shipped
    // default moved from 2 to 1 after the 429 incident and the alerting path was
    // originally only exercised at 2.
    const run = async (concurrency: number) => {
      const { store } = fakeStore({
        history: { alpha: failedRuns(3), beta: failedRuns(3), gamma: failedRuns(3) },
      });
      const { notifier, batches } = fakeNotifier();
      const summary = await runCycle(
        ['alpha', 'beta', 'gamma'].map((id) => throwingTarget(id)),
        store,
        alerting({ notifier, concurrency }),
      );
      return {
        posts: batches.length,
        posted: batches[0]?.map((a) => [a.kind, a.protocolId, a.consecutiveFailures]),
        summarised: summary.alerts?.map((a) => [a.kind, a.protocolId, a.consecutiveFailures]),
        results: summary.results.map((r) => [r.id, r.status]),
      };
    };

    const one = await run(1);
    const two = await run(2);
    assert.equal(one.posts, 1, 'one POST per cycle at concurrency 1');
    assert.equal(two.posts, 1, 'one POST per cycle at concurrency 2');
    assert.deepEqual(one, two, 'dropping to a single worker changes nothing an operator sees');
    assert.deepEqual(one.posted, [
      ['failing', 'alpha', 4],
      ['failing', 'beta', 4],
      ['failing', 'gamma', 4],
    ]);
  });

  it('keeps a batched alert in registration order however completion is ordered', async () => {
    // The one-POST-per-cycle aggregation is asserted elsewhere; what is at stake
    // here is that its BODY does not reshuffle itself between cycles according to
    // which protocol the RPC happened to answer first. An alert that renders its
    // protocols in a different order each time is one nobody can diff.
    const { store } = fakeStore({ history: { alpha: failedRuns(3), beta: failedRuns(3) } });
    const { notifier, batches } = fakeNotifier();
    const a = deferredTarget('alpha');
    const b = deferredTarget('beta');

    const cycle = runCycle([a.target, b.target], store, alerting({ notifier, concurrency: 2 }));
    await Promise.resolve();
    await Promise.resolve();
    // beta crosses its threshold first; alpha finishes second.
    b.fail(new Error('Soroban RPC unreachable'));
    await new Promise((r) => setTimeout(r, 0));
    a.fail(new Error('Soroban RPC unreachable'));

    const summary = await cycle;
    assert.equal(batches.length, 1, 'still one POST for the cycle');
    assert.deepEqual(
      batches[0].map((al) => al.protocolId),
      ['alpha', 'beta'],
    );
    assert.deepEqual(
      summary.alerts?.map((al) => al.protocolId),
      ['alpha', 'beta'],
    );
  });

  it('isolates a failure to its own target while another is mid-flight', async () => {
    const { store, written } = fakeStore();
    const a = deferredTarget('alpha', 11);
    const b = deferredTarget('beta', 22);
    const cycle = runCycle([a.target, b.target], store, { concurrency: 2 });

    await Promise.resolve();
    await Promise.resolve();
    a.fail(new Error('Soroban RPC unreachable'));
    await new Promise((r) => setTimeout(r, 0));
    b.finish();

    const summary = await cycle;
    assert.deepEqual(
      summary.results.map((r) => [r.id, r.status]),
      [
        ['alpha', 'failed'],
        ['beta', 'ok'],
      ],
    );
    const beta = written.find((r) => r.protocolId === 'beta');
    assert.ok(beta && beta.status === 'ok' && beta.safetyScore === 22);
  });
});

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

describe('runCycle — a fresh, empty history never alerts', () => {
  it('sends nothing on the first cycle against an empty risk_scores', async () => {
    // risk_scores was truncated on 2026-08-19, so this is the literal state of
    // production on the next cycle — not a hypothetical. A protocol with no
    // history at all must not read as a failure streak.
    const { store } = fakeStore();
    const { notifier, all } = fakeNotifier();

    const summary = await runCycle([throwingTarget('blend')], store, alerting({ notifier }));

    assert.equal(summary.failed, 1, 'the failure is still recorded');
    assert.deepEqual(all(), [], 'but nobody is paged for one blip on an empty table');
    assert.equal(summary.alerts, undefined);
  });

  it('stays silent for every cycle below the threshold', async () => {
    const { store } = fakeStore();
    const { notifier, all } = fakeNotifier();

    for (let cycle = 1; cycle < 4; cycle++) {
      await runCycle([throwingTarget('blend')], store, alerting({ notifier }));
      assert.deepEqual(all(), [], `no alert after ${cycle} consecutive failures`);
    }
  });

  it('sends nothing when a protocol has only ever succeeded', async () => {
    const { store } = fakeStore();
    const { notifier, all } = fakeNotifier();
    for (let i = 0; i < 6; i++) {
      await runCycle([okTarget('blend')], store, alerting({ notifier }));
    }
    assert.deepEqual(all(), []);
  });
});

describe('runCycle — alerting on a seeded failure streak', () => {
  it('fires on the cycle that completes the fourth consecutive failure', async () => {
    // Three failures already on record; this cycle's failure is the fourth.
    const { store } = fakeStore({ history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    await runCycle(
      [throwingTarget('blend', new Error('Blend: simulation of get_reserve_list failed'))],
      store,
      alerting({ notifier }),
    );

    const alerts = all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'failing');
    assert.equal(alerts[0].protocolId, 'blend');
    assert.equal(alerts[0].consecutiveFailures, 4);
    assert.match(alerts[0].latestError, /simulation of get_reserve_list failed/);
  });

  it('does not fire again on the fifth, sixth or seventh consecutive failure', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(4) } });
    const { notifier, all } = fakeNotifier();

    for (let i = 0; i < 3; i++) {
      await runCycle([throwingTarget('blend')], store, alerting({ notifier }));
    }
    assert.deepEqual(all(), [], 'a long outage is one message, not one per cycle');
  });

  it('sends a recovery alert when the protocol scores again', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(6) } });
    const { notifier, all } = fakeNotifier();

    await runCycle([okTarget('blend', 61)], store, alerting({ notifier }));

    const alerts = all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'recovered');
    assert.equal(alerts[0].consecutiveFailures, 6);
  });

  it('sends no recovery alert for a streak that never crossed the threshold', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(2) } });
    const { notifier, all } = fakeNotifier();

    await runCycle([okTarget('blend')], store, alerting({ notifier }));
    assert.deepEqual(all(), [], 'no failing alert was sent, so there is nothing to answer');
  });

  it('batches both protocols into one notification when both cross together', async () => {
    // An RPC-wide outage is one incident, and should read as one.
    const { store } = fakeStore({ history: { blend: failedRuns(3), kinetic: failedRuns(3) } });
    const { notifier, batches } = fakeNotifier();

    const summary = await runCycle(
      [throwingTarget('blend'), throwingTarget('kinetic')],
      store,
      alerting({ notifier }),
    );

    assert.equal(batches.length, 1, 'one POST for the cycle, not one per protocol');
    assert.deepEqual(
      batches[0].map((a) => a.protocolId),
      ['blend', 'kinetic'],
    );
    assert.equal(summary.alerts?.length, 2);
  });

  it('alerts on one protocol without involving the other', async () => {
    const { store } = fakeStore({ history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    await runCycle(
      [throwingTarget('blend'), okTarget('kinetic', 47)],
      store,
      alerting({ notifier }),
    );

    assert.deepEqual(
      all().map((a) => a.protocolId),
      ['blend'],
    );
  });

  it('does not alert when no notifier is configured, but still records the failure', async () => {
    // STENION_ALERT_WEBHOOK_URL unset is the default: retries and failed-run
    // recording carry on, alerting is simply off.
    const { store, written } = fakeStore({ history: { blend: failedRuns(3) } });
    const summary = await runCycle([throwingTarget('blend')], store, { alertThreshold: 4 });

    assert.equal(written[0].status, 'failed');
    assert.equal(summary.alerts, undefined);
  });
});

describe('runCycle — alerting can never break a cycle', () => {
  it('carries on when the notifier throws', async () => {
    const { store, written } = fakeStore({ history: { blend: failedRuns(3) } });
    const summary = await runCycle([throwingTarget('blend'), okTarget('kinetic', 24)], store, {
      alertThreshold: 4,
      notifier: async () => {
        throw new Error('webhook 500');
      },
    });

    assert.equal(summary.ran, 2);
    assert.equal(summary.ok, 1, 'kinetic still scored');
    assert.equal(written.length, 2, 'both runs still persisted');
    assert.ok(logs.some((l) => l.includes('delivery failed')));
  });

  it('carries on when the streak query itself fails', async () => {
    const { store } = fakeStore({ failReads: true, history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    const summary = await runCycle([throwingTarget('blend')], store, alerting({ notifier }));

    assert.equal(summary.failed, 1);
    assert.deepEqual(all(), []);
    assert.ok(logs.some((l) => l.includes('could not read run history')));
  });

  it('skips the streak check when the run record could not be written', async () => {
    // A streak we could not record is not one to page anyone about — and the
    // history we would read wouldn't contain this cycle anyway.
    const { store } = fakeStore({ failWrites: true, history: { blend: failedRuns(3) } });
    const { notifier, all } = fakeNotifier();

    await runCycle([throwingTarget('blend')], store, alerting({ notifier }));
    assert.deepEqual(all(), []);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting: three outcomes, told apart
// ---------------------------------------------------------------------------

// A 429 from the shared public RPC is not a fact about the protocol being
// scored. Treating it identically to a changed contract interface is what
// erodes what an alert means, so the run loop has to distinguish three things:
// a clean success, a success that had to wait out rate limiting, and a failure
// caused by rate limiting that never let up. These tests pin all three, and pin
// that the middle one does NOT reach the alert path.
describe('runCycle separates rate-limit outcomes from real ones', () => {
  /** A target that waits out `retries` rate-limit responses, then succeeds. */
  function rateLimitedThenOkTarget(id: string, retries: number): IndexTarget {
    return {
      metadata: { id, name: id, chain: 'stellar', category: 'lending', adapterRef: 'FakeAdapter' },
      run: async () => {
        // Exactly what the transport wrapper does on a retried 429 — the budget
        // is ambient, so this needs no argument, which is the property that let
        // the adapters gain retries without an interface change.
        const budget = currentRateLimitBudget();
        assert.ok(budget, 'the run loop must establish a budget for every attempt');
        for (let i = 0; i < retries; i++) budget.recordRetry(250, 'getLedgerEntries');
        return {
          safetyScore: 61,
          factors: FACTORS,
          operationalState: OPERATIONAL_STATE,
          computedAt: COMPUTED_AT,
        };
      },
    };
  }

  /** The error a persistently-429ing endpoint produces once the budget is spent. */
  function exhausted(): RateLimitExhaustedError {
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    budget.recordRetry(250, 'x');
    budget.recordRetry(500, 'x');
    budget.recordRetry(1000, 'x');
    return new RateLimitExhaustedError('getLedgerEntries (9 keys)', budget, 'callRetriesExhausted');
  }

  it('reports a clean success with no rate-limit fields at all', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle([okTarget('blend')], store);

    assert.equal(summary.results[0].status, 'ok');
    assert.equal(summary.results[0].rateLimitRetries, undefined);
    assert.equal(summary.results[0].rateLimited, undefined);
    assert.equal(written[0].status, 'ok');
  });

  it('reports a retry-success as ok, with the retries counted', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle([rateLimitedThenOkTarget('kinetic', 2)], store);

    const result = summary.results[0];
    assert.equal(result.status, 'ok', 'waiting out a 429 is not a failure');
    assert.equal(result.safetyScore, 61);
    assert.equal(result.rateLimitRetries, 2, 'the count is what makes this outcome visible');
    assert.equal(result.rateLimited, undefined, 'that flag is for failures only');
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 0);
    // The persisted row is an ordinary ok run — retries are an operational fact
    // about our path to the RPC, never a fact about the protocol's score.
    assert.equal(written[0].status, 'ok');
  });

  it('logs a retry-success as a success, not as an error', async () => {
    const { store } = fakeStore();
    await runCycle([rateLimitedThenOkTarget('kinetic', 3)], store);

    const line = logs.find((l) => l.includes('kinetic') && l.includes('safetyScore=61'));
    assert.ok(line, 'the success line must still be logged');
    assert.match(line, /waited out 3 rate-limit response/);
    assert.ok(
      !logs.some((l) => l.includes('kinetic') && l.includes('FAILED')),
      'a retry-success must never be logged as a failure',
    );
  });

  it('reports a retry-exhausted failure as rate-limited, with the 429s named', async () => {
    const { store, written } = fakeStore();
    const summary = await runCycle([throwingTarget('blend', exhausted())], store);

    const result = summary.results[0];
    assert.equal(result.status, 'failed');
    assert.equal(result.rateLimited, true, 'countable without parsing the message');
    assert.match(result.error ?? '', /rate limited \(HTTP 429\)/);
    assert.match(result.error ?? '', /getLedgerEntries \(9 keys\)/);
    assert.match(result.error ?? '', /not the protocol being unreadable/);
    // And it is the recorded error, so an alert body carries the same sentence.
    const record = written[0];
    assert.match(record.status === 'failed' ? record.error : '', /HTTP 429/);
  });

  it('does not flag failures that are not about rate limiting', async () => {
    const { store } = fakeStore();
    const summary = await runCycle(
      [
        throwingTarget('blend', new Error('attempt exceeded its 10000ms time budget')),
        throwingTarget('kinetic', new Error('Blend: pool CAJJ has no Config in instance storage')),
      ],
      store,
    );

    for (const result of summary.results) {
      assert.equal(result.status, 'failed');
      assert.equal(
        result.rateLimited,
        undefined,
        `${result.id}: a timeout and a decode break are not the endpoint refusing us`,
      );
    }
  });

  it('never sends a retry-success down the alert path', async () => {
    // The streak alert reads `failed` rows only, so a retry-success cannot reach
    // it — asserted rather than assumed, because "successful after retry" is
    // precisely the outcome someone might later decide to alert on by accident.
    const { notifier, all } = fakeNotifier();
    // Four real prior failures, so the alert path is demonstrably live: a
    // retry-success ends that streak and produces `recovered`. A test that
    // seeded nothing would pass by having no alerting at all.
    const { store } = fakeStore({ history: { blend: failedRuns(4) } });

    await runCycle(
      [rateLimitedThenOkTarget('blend', 4)],
      store,
      alerting({ notifier, alertThreshold: 4 }),
    );

    assert.deepEqual(
      all().map((a) => a.kind),
      ['recovered'],
      'the only alert is that the earlier real failures ended, never one about the retries',
    );
  });
});

// ---------------------------------------------------------------------------
// Rate limiting composes with concurrency
// ---------------------------------------------------------------------------

describe('retries in one target do not touch another target', () => {
  it('gives every target its own budget, with its own full allowance', async () => {
    // STENION_CYCLE_CONCURRENCY is 1 today and under review. A module-level
    // budget would work at 1 and silently cross-charge at 2, so the isolation is
    // tested at 2 rather than at the shipped value.
    const seen = new Map<string, RateLimitBudget>();

    function observing(id: string, retries: number): IndexTarget {
      return {
        metadata: { id, name: id, chain: 'stellar', category: 'lending', adapterRef: 'Fake' },
        run: async () => {
          const budget = currentRateLimitBudget();
          assert.ok(budget);
          seen.set(id, budget);
          for (let i = 0; i < retries; i++) {
            // Yield between retries so the two targets genuinely interleave.
            await new Promise((r) => setImmediate(r));
            assert.equal(currentRateLimitBudget(), budget, `${id} saw a different budget`);
            budget.recordRetry(250, 'call');
          }
          return {
            safetyScore: 50,
            factors: FACTORS,
            operationalState: OPERATIONAL_STATE,
            computedAt: COMPUTED_AT,
          };
        },
      };
    }

    const { store } = fakeStore();
    const summary = await runCycle([observing('a', 4), observing('b', 1)], store, {
      concurrency: 2,
      retry: { attempts: 1, baseDelayMs: 0, attemptTimeoutMs: 10_000 },
      budgetMs: 50_000,
    });

    const a = seen.get('a');
    const b = seen.get('b');
    assert.ok(a && b);
    assert.notEqual(a, b, 'two targets must not share one budget object');
    assert.equal(a.retriesUsed, 4);
    assert.equal(b.retriesUsed, 1, 'b must not be charged for the four retries a made');

    const byId = new Map(summary.results.map((r) => [r.id, r]));
    assert.equal(byId.get('a')?.rateLimitRetries, 4);
    assert.equal(byId.get('b')?.rateLimitRetries, 1);
    assert.equal(summary.ok, 2, 'both still succeeded');
  });

  it('computes a target deadline from the schedule alone, never from retries', () => {
    // `targetDeadline` takes the budget end, the clock, the queue depth, the
    // concurrency and the attempt timeout — and nothing about rate limiting.
    // That is the whole reason a retry inside target A cannot move target B's
    // deadline: there is no term for it to move.
    const base = {
      budgetEndsAt: 50_000,
      now: 0,
      queuedAfter: 3,
      concurrency: 1,
      attemptTimeoutMs: 10_000,
    };
    const deadline = targetDeadline(base);
    assert.equal(targetDeadline({ ...base }), deadline);
    assert.equal(deadline, 50_000 - 3 * 10_000);
  });

  it('keeps a rate-limit budget inside the attempt it belongs to', async () => {
    // The budget's deadline must be the earlier of the attempt timeout and the
    // target deadline, so a retry can never be started that the outer timeout
    // would cut short — the property that stops a 429 becoming a timeout.
    let observed: RateLimitBudget | null = null;
    const target: IndexTarget = {
      metadata: {
        id: 'blend',
        name: 'blend',
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'Fake',
      },
      run: async () => {
        observed = currentRateLimitBudget();
        return {
          safetyScore: 50,
          factors: FACTORS,
          operationalState: OPERATIONAL_STATE,
          computedAt: COMPUTED_AT,
        };
      },
    };

    const { store } = fakeStore();
    const startedAt = Date.now();
    await runCycle([target], store, {
      retry: { attempts: 3, baseDelayMs: 1, attemptTimeoutMs: 10_000 },
      budgetMs: 50_000,
    });

    const budget = observed as RateLimitBudget | null;
    assert.ok(budget);
    assert.ok(
      budget.endsAt <= startedAt + 10_000 + 50,
      'the budget must expire with the attempt, not with the cycle',
    );
  });
});
