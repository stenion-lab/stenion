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

import { runCycle, toTarget, type IndexTarget } from './cycle.ts';
import type { Adapter, ProtocolMetadata, RiskFactorMap, RiskScoreResult } from '@stenion/core';
import type { RunRecord, Store } from '@stenion/db';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A Store that keeps writes in an array, and can be told to fail them. */
function fakeStore(opts: { failWrites?: boolean } = {}) {
  const written: RunRecord[] = [];
  const store: Store = {
    async upsertProtocol() {},
    async insertRunRecord(record) {
      if (opts.failWrites) throw new Error('connection terminated unexpectedly');
      written.push(record);
    },
    async listProtocolsWithLatestScore() {
      return [];
    },
    async getProtocolDetail() {
      return null;
    },
  };
  return { store, written };
}

const FACTORS = {
  collateralSafety: { value: 70, weight: 0.2, detail: 'x' },
  oracleSafety: { value: 100, weight: 0.25, detail: 'x' },
  adminKeySafety: { value: 40, weight: 0.2, detail: 'x' },
  liquiditySafety: { value: 22, weight: 0.15, detail: 'x' },
  utilizationSafety: { value: 14, weight: 0.2, detail: 'x' },
} as unknown as RiskFactorMap;

const COMPUTED_AT = new Date('2026-08-16T10:00:00.000Z');

/** A target that succeeds with a fixed score. */
function okTarget(id: string, safetyScore = 53): IndexTarget {
  return {
    metadata: { id, name: id, chain: 'stellar' },
    adapterRef: 'FakeAdapter',
    run: async () => ({ safetyScore, factors: FACTORS, computedAt: COMPUTED_AT }),
  };
}

/** A target whose adapter throws, the way a real one does on RPC failure. */
function throwingTarget(id: string, thrown: unknown = new Error('Soroban RPC unreachable')) {
  return {
    metadata: { id, name: id, chain: 'stellar' as const },
    adapterRef: 'FakeAdapter',
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
    assert.deepEqual(
      written.map((r) => [r.protocolId, r.status]),
      [
        ['alpha', 'ok'],
        ['beta', 'failed'],
        ['gamma', 'ok'],
      ],
    );
  });

  it('still scores later targets when the FIRST one throws', async () => {
    // Ordering matters: an early failure aborting the loop would silently stop
    // every protocol behind it, and with two adapters that is half the registry.
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
    assert.deepEqual(summary, { ran: 0, ok: 0, failed: 0, results: [] });
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
    assert.deepEqual(summary.results, [{ id: 'alpha', status: 'ok', safetyScore: 61 }]);
  });
});

describe('runCycle — the ok record', () => {
  it('stamps the methodology version from core, not from the adapter', async () => {
    // One rulebook applies to every protocol, so the version is a property of
    // the run. An adapter has no say in it — that is what keeps stored history
    // interpretable.
    const { METHODOLOGY_VERSION } = await import('@stenion/core');
    const { store, written } = fakeStore();
    await runCycle([okTarget('blend')], store);

    const record = written[0];
    assert.equal(record.status, 'ok');
    assert.equal(record.methodologyVersion, METHODOLOGY_VERSION);
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
  /** A minimal adapter with its own raw shape, to prove TRawData stays internal. */
  function fakeAdapter(id: string, calls: string[]): Adapter<{ n: number }> {
    return {
      metadata: { id, name: id, chain: 'stellar' } as ProtocolMetadata,
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
    };
  }

  it('runs fetch → compute → score in order, threading the raw data through', async () => {
    const calls: string[] = [];
    const target = toTarget(fakeAdapter('blend', calls));
    const out = await target.run();

    assert.deepEqual(calls, ['fetchRawData', 'computeRiskFactors(1)', 'score']);
    assert.equal(out.safetyScore, 53);
    assert.equal(out.computedAt, COMPUTED_AT);
  });

  it("takes adapterRef from the adapter's class name", async () => {
    // This is what lands in the protocols table's `adapter` column.
    class BlendAdapter implements Adapter<{ n: number }> {
      metadata = { id: 'blend', name: 'Blend', chain: 'stellar' } as ProtocolMetadata;
      async fetchRawData() {
        return { n: 1 };
      }
      async computeRiskFactors() {
        return FACTORS;
      }
      score(factors: RiskFactorMap): RiskScoreResult {
        return { score: 1, factors, computedAt: COMPUTED_AT };
      }
    }
    assert.equal(toTarget(new BlendAdapter()).adapterRef, 'BlendAdapter');
  });

  it('lets a failure anywhere in the pipeline surface to runCycle', async () => {
    // Each stage throws for real reasons — RPC down, a price that won't decode.
    // None of them may be swallowed inside the wrapper.
    for (const stage of ['fetchRawData', 'computeRiskFactors', 'score'] as const) {
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
