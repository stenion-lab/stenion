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
        ? [protocolId, 'ok', row.score, '{}', null, row.runAt, row.runAt, row.version ?? 2]
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
    await store.upsertProtocol({ id: p, name: 'Stale', chain: 'stellar' }, 'FakeAdapter');
    await insertRun(p, { status: 'ok', score: 53, runAt: '2026-08-16T10:00:00Z' });
    await insertRun(p, { status: 'failed', error: 'RPC down', runAt: '2026-08-16T10:05:00Z' });

    const detail = await store.getProtocolDetail(p);
    assert.ok(detail);
    assert.equal(detail.safetyScore, 53, 'the older ok run still supplies the score');
    assert.equal(detail.computedAt, '2026-08-16T10:00:00.000Z');
    assert.equal(detail.lastRunStatus, 'failed');
    assert.equal(detail.lastRunAt, '2026-08-16T10:05:00.000Z');
  });

  it('returns null for an unknown id — what the route turns into a 404', async () => {
    assert.equal(await store.getProtocolDetail(id('does-not-exist')), null);
  });

  it('returns a protocol with no runs, rather than hiding it', async () => {
    const p = id('unscored');
    await store.upsertProtocol({ id: p, name: 'Unscored', chain: 'stellar' }, 'FakeAdapter');

    const detail = await store.getProtocolDetail(p);
    assert.ok(detail, 'a registered protocol with no runs must still resolve');
    assert.equal(detail.safetyScore, null);
    assert.equal(detail.lastRunStatus, null);
    assert.deepEqual(detail.history, []);
  });

  it('orders history newest-first', async () => {
    const p = id('history');
    await store.upsertProtocol({ id: p, name: 'History', chain: 'stellar' }, 'FakeAdapter');
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
      await store.upsertProtocol({ id: p, name, chain: 'stellar' }, 'FakeAdapter');
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
    await store.upsertProtocol({ id: p, name: 'Check', chain: 'stellar' }, 'FakeAdapter');
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

  it('round-trips a run written through insertRunRecord', async () => {
    const p = id('roundtrip');
    await store.upsertProtocol({ id: p, name: 'Round', chain: 'stellar' }, 'FakeAdapter');
    await store.insertRunRecord({
      protocolId: p,
      status: 'ok',
      safetyScore: 53,
      factors: {} as never,
      methodologyVersion: 2,
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

  it('upsertProtocol is idempotent and refreshes metadata', async () => {
    const p = id('upsert');
    await store.upsertProtocol({ id: p, name: 'First', chain: 'stellar' }, 'AdapterA');
    await store.upsertProtocol({ id: p, name: 'Second', chain: 'stellar' }, 'AdapterB');

    const detail = await store.getProtocolDetail(p);
    assert.equal(detail!.name, 'Second');
    assert.equal(detail!.adapter, 'AdapterB');
  });
});
