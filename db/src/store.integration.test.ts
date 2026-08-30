// Integration tests for the Store's SQL, against a real Postgres.
//
// SKIPPED UNLESS `STENION_TEST_DATABASE_URL` IS SET. CI never sets it, so a
// contributor's PR does not need database credentials to go green. Run locally:
//
//   STENION_TEST_DATABASE_URL=postgresql://… pnpm --filter @stenion/db test
//
// WHY A REAL DATABASE: the parts worth testing here cannot be faked. The two
// LATERAL joins are what separate "latest ok score" from "newest run of any
// status" — the entire staleness model — and `ORDER BY safety_score DESC NULLS
// LAST` is what keeps a never-scored protocol off the bottom of the board rather
// than at it. Both are SQL semantics; an in-memory Store would only test my
// re-implementation of them. The row → response *mapping* is separate and pure,
// and lives in store.test.ts, which runs everywhere.
//
// Safety: this writes to `protocols` and `risk_scores`. Every row it creates is
// prefixed and removed afterwards, and it refuses to run against the same URL as
// DATABASE_URL so it can never append junk to the published history.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

import { createStore, type Store } from './store.ts';
import { OperationalLevel } from '@stenion/core';

const TEST_URL = process.env.STENION_TEST_DATABASE_URL?.trim();
const PREFIX = `zz-test-${process.pid}-`;

/** Never touch the real history table, even if someone exports the wrong URL. */
function guardUrl(): string | null {
  if (!TEST_URL) return null;
  const prod = process.env.DATABASE_URL?.trim();
  if (prod && prod === TEST_URL) {
    throw new Error(
      'STENION_TEST_DATABASE_URL is identical to DATABASE_URL. Point it at a scratch ' +
        'database — these tests insert and delete rows.',
    );
  }
  return TEST_URL;
}

const skip = TEST_URL ? false : 'STENION_TEST_DATABASE_URL is not set';

describe('Store SQL (integration)', { skip }, () => {
  let pool: pg.Pool;
  let store: Store;

  const id = (name: string) => `${PREFIX}${name}`;

  /** Append a run directly, so run_at can be controlled precisely. */
  async function insertRun(
    protocolId: string,
    row: {
      status: 'ok' | 'failed';
      score?: number;
      error?: string;
      runAt: string;
      version?: number;
    },
  ) {
    await pool.query(
      `INSERT INTO risk_scores
         (protocol_id, status, safety_score, factors, error, computed_at, run_at, methodology_version)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      row.status === 'ok'
        ? [protocolId, 'ok', row.score, '{}', null, row.runAt, row.runAt, row.version ?? 1]
        : [protocolId, 'failed', null, null, row.error ?? 'boom', null, row.runAt, null],
    );
  }

  before(async () => {
    const url = guardUrl();
    pool = new pg.Pool({ connectionString: url! });
    store = createStore(pool);
    const { rows } = await pool.query(`SELECT to_regclass('public.risk_scores') AS t`);
    assert.ok(rows[0].t, 'run `pnpm --filter @stenion/db migrate` against the test database first');
    await pool.query(`DELETE FROM risk_scores WHERE protocol_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM protocols WHERE id LIKE $1`, [`${PREFIX}%`]);
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM risk_scores WHERE protocol_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM protocols WHERE id LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  });

  it('surfaces the last good score and flags it stale when the newest run failed', async () => {
    // The two LATERAL joins, which is the whole reason this needs real SQL.
    const p = id('stale');
    await store.upsertProtocol({
      id: p,
      name: 'Stale',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });
    await insertRun(p, { status: 'ok', score: 53, runAt: '2026-08-16T10:00:00Z' });
    await insertRun(p, { status: 'failed', error: 'RPC down', runAt: '2026-08-16T10:05:00Z' });

    const detail = await store.getProtocolDetail(p);
    assert.ok(detail);
    assert.equal(detail.safetyScore, 53, 'the older ok run still supplies the score');
    assert.equal(detail.computedAt, '2026-08-16T10:00:00.000Z');
    assert.equal(detail.lastRunStatus, 'failed');
    assert.equal(detail.lastRunAt, '2026-08-16T10:05:00.000Z');
  });

  it('separates the last successful run from the last run, for GET /api/v1/health', async () => {
    // The health endpoint's entire signal is the gap between these two, and like
    // the staleness model above it is SQL semantics: the `ok` LATERAL filters on
    // status, the `latest` one does not. An in-memory Store would only test a
    // re-implementation of that.
    const p = id('health-failing');
    await store.upsertProtocol({
      id: p,
      name: 'Failing',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });
    await insertRun(p, { status: 'ok', score: 53, runAt: '2026-08-16T10:00:00Z' });
    await insertRun(p, { status: 'failed', error: 'RPC down', runAt: '2026-08-16T10:05:00Z' });

    const rows = await store.listRunHealth();
    const entry = rows.find((r) => r.id === p);
    assert.ok(entry);
    // The failed run must NOT advance the success timestamp — otherwise an
    // adapter failing every cycle reports as permanently fresh.
    assert.equal(entry.lastSuccessfulRunAt, '2026-08-16T10:00:00.000Z');
    assert.equal(entry.lastRunAt, '2026-08-16T10:05:00.000Z');
    assert.equal(entry.lastRunStatus, 'failed');
  });

  it('includes a protocol that has never run, rather than omitting it', async () => {
    // LEFT JOIN LATERAL, not an inner join. A protocol missing from the health
    // response would read as "nothing wrong here", which is the opposite of what
    // a row with no runs means.
    const p = id('health-never');
    await store.upsertProtocol({
      id: p,
      name: 'Never',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });

    const entry = (await store.listRunHealth()).find((r) => r.id === p);
    assert.ok(entry, 'a registered protocol with no runs must still appear');
    assert.equal(entry.lastSuccessfulRunAt, null);
    assert.equal(entry.lastRunAt, null);
    assert.equal(entry.lastRunStatus, null);
  });

  it('returns exactly one row per protocol', async () => {
    // The acceptance criterion that matters for cost: one row per protocol out of
    // one query, no fan-out and no duplicate rows from the joins. Several runs
    // for one protocol must still collapse to a single entry.
    const p = id('health-many-runs');
    await store.upsertProtocol({
      id: p,
      name: 'Many',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });
    for (const minute of ['00', '05', '10', '15']) {
      await insertRun(p, { status: 'ok', score: 50, runAt: `2026-08-16T12:${minute}:00Z` });
    }

    const rows = await store.listRunHealth();
    assert.equal(rows.filter((r) => r.id === p).length, 1);
    assert.equal(
      rows.find((r) => r.id === p)?.lastSuccessfulRunAt,
      '2026-08-16T12:15:00.000Z',
      'the newest ok run wins',
    );
  });

  it('returns null for an unknown id — what the route turns into a 404', async () => {
    assert.equal(await store.getProtocolDetail(id('does-not-exist')), null);
  });

  it('returns a protocol with no runs, rather than hiding it', async () => {
    const p = id('unscored');
    await store.upsertProtocol({
      id: p,
      name: 'Unscored',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });

    const detail = await store.getProtocolDetail(p);
    assert.ok(detail, 'a registered protocol with no runs must still resolve');
    assert.equal(detail.safetyScore, null);
    assert.equal(detail.lastRunStatus, null);
    assert.deepEqual(detail.history, []);
  });

  it('orders history newest-first', async () => {
    const p = id('history');
    await store.upsertProtocol({
      id: p,
      name: 'History',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });
    await insertRun(p, { status: 'ok', score: 40, runAt: '2026-08-16T10:00:00Z' });
    await insertRun(p, { status: 'ok', score: 60, runAt: '2026-08-16T10:10:00Z' });
    await insertRun(p, { status: 'failed', runAt: '2026-08-16T10:05:00Z' });

    const detail = await store.getProtocolDetail(p);
    assert.deepEqual(
      detail!.history.map((h) => h.runAt),
      ['2026-08-16T10:10:00.000Z', '2026-08-16T10:05:00.000Z', '2026-08-16T10:00:00.000Z'],
    );
  });

  it('ranks never-scored protocols last, not as zero', async () => {
    // `NULLS LAST`. Without it a protocol that has never scored sorts to the
    // very bottom on some engines and the very top on others — and either way
    // reads as a risk judgment we did not make.
    const low = id('rank-low');
    const high = id('rank-high');
    const none = id('rank-none');
    for (const [p, name] of [
      [low, 'Low'],
      [high, 'High'],
      [none, 'None'],
    ]) {
      await store.upsertProtocol({
        id: p,
        name,
        chain: 'stellar',
        category: 'lending',
        adapterRef: 'FakeAdapter',
      });
    }
    await insertRun(low, { status: 'ok', score: 10, runAt: '2026-08-16T10:00:00Z' });
    await insertRun(high, { status: 'ok', score: 90, runAt: '2026-08-16T10:00:00Z' });
    await insertRun(none, { status: 'failed', runAt: '2026-08-16T10:00:00Z' });

    // Filter to just these three: other tests in this run also create prefixed
    // protocols, and they'd interleave by score. Relative order is what matters.
    const wanted = new Set([high, low, none]);
    const board = (await store.listProtocolsWithLatestScore()).filter((e) => wanted.has(e.id));
    assert.deepEqual(
      board.map((e) => e.id),
      [high, low, none],
    );
    assert.equal(board[2].safetyScore, null, 'the unscored one sorts last, with a null score');
  });

  it('enforces the ok/failed split at the database level', async () => {
    // The risk_scores_shape CHECK is a second line of defence behind the
    // RunRecord union: a failed row carrying a score should be impossible even
    // if application code regressed.
    const p = id('check');
    await store.upsertProtocol({
      id: p,
      name: 'Check',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO risk_scores (protocol_id, status, safety_score, error, run_at)
           VALUES ($1, 'failed', 42, 'boom', now())`,
          [p],
        ),
      /risk_scores_shape|violates check constraint/i,
      'a failed row with a score must be rejected',
    );
  });

  it('requires a methodology version on ok rows and forbids one on failed rows', async () => {
    // The other half of the union, added in migration 0004 once the deployed
    // indexer named the column on both arms. Both directions are asserted
    // because only one of them is exercised by anything else: every seeded row
    // in this file is well-formed, so "the constraint accepts a failed row with
    // no version" proves nothing about whether it would REJECT one carrying a
    // version. There are zero failed rows in the real database, so this test is
    // the only thing that ever runs the failed half.
    const p = id('version-shape');
    await store.upsertProtocol({
      id: p,
      name: 'VersionShape',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });

    // A failed run produced no score, so there is no rulebook to attribute it
    // to. A version here would be a fabricated attribution.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO risk_scores (protocol_id, status, error, run_at, methodology_version)
           VALUES ($1, 'failed', 'boom', now(), 1)`,
          [p],
        ),
      /risk_scores_methodology_version_shape/,
      'a failed row carrying a version must be rejected',
    );

    // The direction migration 0004 exists for: with the DEFAULT dropped, a
    // writer that forgets the column no longer gets silently stamped 1.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO risk_scores (protocol_id, status, safety_score, factors, computed_at, run_at)
           VALUES ($1, 'ok', 50, '{}'::jsonb, now(), now())`,
          [p],
        ),
      /risk_scores_methodology_version_shape/,
      'an ok row with no version must be rejected, not defaulted to 1',
    );

    // And the well-formed failed row still lands.
    await insertRun(p, { status: 'failed', error: 'RPC down', runAt: '2026-08-16T11:00:00Z' });
    const detail = await store.getProtocolDetail(p);
    assert.equal(detail!.history.length, 1, 'only the well-formed row was written');
    assert.equal(detail!.history[0].status, 'failed');
  });

  it('carries a per-row methodology version through to the history', async () => {
    // Every row stored today is v1 and there is no second version yet, so live
    // data cannot exercise this. It is seeded instead, for the same reason the
    // failed-run path is: the version stamp is what lets the score chart BREAK
    // the line at a rulebook change instead of drawing a step change through it,
    // and a path we are relying on later is worth nothing untested.
    //
    // This is the DB half of that seam — the column round-trips per row, not per
    // protocol. The break-detection half lives in the dashboard's
    // score-series.test.ts fixtures.
    const p = id('methodology-break');
    await store.upsertProtocol({
      id: p,
      name: 'Break',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });
    await insertRun(p, { status: 'ok', score: 21, runAt: '2026-08-16T09:00:00Z', version: 1 });
    await insertRun(p, { status: 'ok', score: 21, runAt: '2026-08-16T09:05:00Z', version: 1 });
    await insertRun(p, { status: 'ok', score: 46, runAt: '2026-08-16T09:10:00Z', version: 2 });

    const detail = await store.getProtocolDetail(p);
    // History is newest-first.
    assert.deepEqual(
      detail!.history.map((h) => (h.status === 'ok' ? h.methodologyVersion : null)),
      [2, 1, 1],
      'each row must keep the version it was written with',
    );
    assert.equal(detail!.methodologyVersion, 2, 'the detail reports the newest run’s version');
  });

  it('round-trips a run written through insertRunRecord', async () => {
    const p = id('roundtrip');
    await store.upsertProtocol({
      id: p,
      name: 'Round',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'FakeAdapter',
    });
    await store.insertRunRecord({
      protocolId: p,
      status: 'ok',
      safetyScore: 53,
      factors: {} as never,
      category: 'lending',
      methodologyVersion: 1,
      operationalState: {
        level: OperationalLevel.Active,
        source: 'PoolConfig.status = 1',
        blocked: [],
        origin: 'protocol',
        detail: 'pool status 1 (Active)',
        asOf: '2026-08-16T10:00:00.000Z',
      },
      computedAt: '2026-08-16T10:00:00.000Z',
      runAt: '2026-08-16T10:00:00.000Z',
    });
    await store.insertRunRecord({
      protocolId: p,
      status: 'failed',
      error: 'Kinetic: oracle unreachable',
      runAt: '2026-08-16T10:05:00.000Z',
    });

    const detail = await store.getProtocolDetail(p);
    assert.equal(detail!.history.length, 2);
    const [newest, oldest] = detail!.history;
    assert.equal(newest.status, 'failed');
    assert.equal(newest.status === 'failed' && newest.error, 'Kinetic: oracle unreachable');
    assert.equal(oldest.status === 'ok' && oldest.safetyScore, 53);
    assert.equal(detail!.safetyScore, 53, 'the failed run must not clear the score');
  });

  it('round-trips a dex run — a factor map that is not lending’s five', async () => {
    // The proof for the dex round-trip, and it is a proof about the READ path,
    // not about JSON.
    // `recordRun` writes `JSON.stringify(record.factors)` into a `$4::jsonb`
    // column and nothing on the way in inspects a key, so storage was never the
    // question. What was wrong was the declared type: `RunRecord.factors`,
    // `HistoryEntry.factors` and `ProtocolDetail.factors` were all
    // `RiskFactorMap` — LENDING's five keys — and `toHistoryEntry` cast
    // `row.factors as RiskFactorMap`, which would have typed a two-key dex row
    // as five and handed `undefined` to anything reading `.oracleSafety` off it,
    // with no error anywhere.
    //
    // So this writes a real `dex` map through `insertRunRecord`, reads it back
    // through `getProtocolDetail`, and asserts the map comes out with EXACTLY
    // its own two keys, on both the top-level `factors` and the history row —
    // the two places that cast used to lie about.
    const p = id('dex-roundtrip');
    const factors = {
      adminKeySafety: {
        value: 10,
        weight: 0.55,
        detail: 'worst of 7 roles',
        components: [
          { id: 'rolePosture', label: 'Role posture', value: 10, detail: 'two keys at 200 ops' },
        ],
      },
      assetControlSafety: {
        value: 40,
        weight: 0.45,
        detail: 'worst of 2 gradable reserves',
      },
    };
    await store.upsertProtocol({
      id: p,
      name: 'Aquarius XLM/USDC',
      chain: 'stellar',
      category: 'dex',
      adapterRef: 'AquariusAdapter',
      contractId: 'CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE',
    });
    await store.insertRunRecord({
      protocolId: p,
      status: 'ok',
      safetyScore: 24,
      factors,
      category: 'dex',
      methodologyVersion: 1,
      operationalState: {
        level: OperationalLevel.Active,
        source: 'router.get_emergency_mode() = false',
        blocked: [],
        origin: 'protocol',
        detail: 'no kill switch is set and neither emergency mode is on',
        asOf: '2026-08-29T19:32:15.000Z',
      },
      computedAt: '2026-08-29T19:32:15.000Z',
      runAt: '2026-08-29T19:32:15.000Z',
    });

    const detail = await store.getProtocolDetail(p);
    assert.equal(detail!.category, 'dex', 'the category the run was stamped with');
    assert.equal(detail!.methodologyVersion, 1, 'dex methodology version 1, its own counter');
    assert.deepEqual(
      Object.keys(detail!.factors ?? {}).sort(),
      ['adminKeySafety', 'assetControlSafety'],
      'two keys out, and none of lending’s four invented on the way',
    );
    assert.deepEqual(detail!.factors, factors, 'the whole map, components included');

    const [run] = detail!.history;
    assert.equal(run!.status, 'ok');
    assert.deepEqual(
      run!.status === 'ok' ? run.factors : null,
      factors,
      'the history row carries the same two-key map — this is the read path whose cast used to claim five',
    );
    // The one that would have been silently wrong before: reading a lending key
    // off a dex row. It is absent, which is the truth; the old type said it was
    // a `RiskFactor | null`.
    assert.ok(!('oracleSafety' in (detail!.factors ?? {})));
  });

  it('upsertProtocol is idempotent and refreshes metadata', async () => {
    const p = id('upsert');
    await store.upsertProtocol({
      id: p,
      name: 'First',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'AdapterA',
    });
    await store.upsertProtocol({
      id: p,
      name: 'Second',
      chain: 'stellar',
      category: 'lending',
      adapterRef: 'AdapterB',
    });

    const detail = await store.getProtocolDetail(p);
    assert.equal(detail!.name, 'Second');
    assert.equal(detail!.adapter, 'AdapterB');
  });
});
