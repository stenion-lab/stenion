// Tests for the row → response mapping that shapes the public API.
//
// WHY THESE EXIST: `GET /api/v1/protocol/:id` is a documented contract external
// consumers parse — wallets, third-party dashboards — and the two parts most
// likely to break them silently are the ok/failed discriminated union and the
// staleness fields. Neither is exercised by looking at the live site: as of
// 2026-08-16 `risk_scores` holds 1,683 rows and **zero** failed ones, so every
// history entry ever served has been an `ok`, and `lastRunStatus` has never once
// been `'failed'` in production.
//
// These test the mapping, not the SQL. Which rows come back and in what order is
// the query's job and needs a real Postgres (see the STENION_TEST_DATABASE_URL
// suite in CONTRIBUTING.md); what they look like on the wire is pure, and this is
// it.
//
// Run with: pnpm --filter @stenion/db test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  toHistoryEntry,
  toLeaderboardEntry,
  toProtocolDetail,
  type HistoryRow,
  type LeaderboardRow,
  type ProtocolDetailRow,
} from './store.ts';
import type { RiskFactorMap } from '@stenion/core';

const RUN_AT = new Date('2026-08-16T11:25:02.000Z');
const COMPUTED_AT = new Date('2026-08-16T11:25:01.000Z');

const FACTORS = {
  collateralSafety: { value: 70, weight: 0.2, detail: 'x' },
} as unknown as RiskFactorMap;

/** An `ok` risk_scores row as pg hands it back: numeric as string, timestamptz as Date. */
const okRow = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  status: 'ok',
  safety_score: '53',
  error: null,
  computed_at: COMPUTED_AT,
  run_at: RUN_AT,
  methodology_version: 2,
  ...over,
});

const failedRow = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  status: 'failed',
  safety_score: null,
  error: 'Blend: simulation of lastprice failed',
  computed_at: null,
  run_at: RUN_AT,
  methodology_version: null,
  ...over,
});

const detailRow = (over: Partial<ProtocolDetailRow> = {}): ProtocolDetailRow => ({
  id: 'blend',
  name: 'Blend',
  chain: 'stellar',
  adapter: 'BlendAdapter',
  safety_score: '53',
  computed_at: COMPUTED_AT,
  factors: FACTORS,
  methodology_version: 2,
  last_run_at: RUN_AT,
  last_run_status: 'ok',
  ...over,
});

// ---------------------------------------------------------------------------

describe('toHistoryEntry — the ok/failed discriminated union', () => {
  it('maps an ok row, coercing pg numeric and timestamptz to the wire types', () => {
    // pg returns `numeric` as a string and `timestamptz` as a Date; the contract
    // is a JSON number and an ISO string. A client doing `entry.safetyScore > 50`
    // silently breaks on "53".
    const entry = toHistoryEntry(okRow());
    assert.deepEqual(entry, {
      status: 'ok',
      safetyScore: 53,
      methodologyVersion: 2,
      computedAt: '2026-08-16T11:25:01.000Z',
      runAt: '2026-08-16T11:25:02.000Z',
    });
    assert.equal(typeof entry.safetyScore, 'number');
  });

  it('maps a failed row to the error arm', () => {
    const entry = toHistoryEntry(failedRow());
    assert.deepEqual(entry, {
      status: 'failed',
      error: 'Blend: simulation of lastprice failed',
      runAt: '2026-08-16T11:25:02.000Z',
    });
  });

  it('never gives a failed entry a score field — not even null', () => {
    // The single most important property here. A consumer that reads
    // `safetyScore` off every entry must get `undefined` and skip it; a null or
    // a 0 would plot as a real, catastrophic score. The chart's whole rule is
    // that a failed run is a gap, never a zero.
    const entry = toHistoryEntry(failedRow()) as Record<string, unknown>;
    assert.ok(!('safetyScore' in entry), 'failed entries must not carry safetyScore at all');
    assert.ok(!('methodologyVersion' in entry));
    assert.ok(!('computedAt' in entry));
    assert.notEqual(entry.safetyScore, 0);
  });

  it('keeps runAt on both arms, so every run is placeable in time', () => {
    assert.equal(toHistoryEntry(okRow()).runAt, RUN_AT.toISOString());
    assert.equal(toHistoryEntry(failedRow()).runAt, RUN_AT.toISOString());
  });

  it('carries the methodology version through on ok rows', () => {
    // A v1 row and a v2 row are not comparable; the stamp is what lets the
    // chart break the line rather than draw a step change through it.
    const v1 = toHistoryEntry(okRow({ methodology_version: 1 }));
    assert.equal(v1.status === 'ok' && v1.methodologyVersion, 1);
  });

  it('handles a fractional or zero score without losing it', () => {
    for (const [raw, expected] of [
      ['0', 0],
      ['100', 100],
      ['53.0', 53],
    ] as const) {
      const entry = toHistoryEntry(okRow({ safety_score: raw }));
      assert.equal(entry.status === 'ok' && entry.safetyScore, expected);
    }
  });
});

describe('toProtocolDetail — staleness and the never-scored case', () => {
  it('maps a healthy protocol', () => {
    const detail = toProtocolDetail(detailRow(), [okRow()]);
    assert.equal(detail.safetyScore, 53);
    assert.equal(detail.methodologyVersion, 2);
    assert.equal(detail.lastRunStatus, 'ok');
    assert.equal(detail.history.length, 1);
    assert.equal(detail.factors, FACTORS);
  });

  it('keeps the last good score visible when the newest run failed', () => {
    // THE STALENESS MODEL. `safetyScore` is the latest *ok* run; `lastRunAt` /
    // `lastRunStatus` describe the newest run of any status. A failed cycle must
    // leave the score standing and flag it stale — blanking it would put a hole
    // in the registry every time RPC hiccups.
    const failedAt = new Date('2026-08-16T11:30:00.000Z');
    const detail = toProtocolDetail(
      detailRow({ last_run_at: failedAt, last_run_status: 'failed' }),
      [failedRow({ run_at: failedAt }), okRow()],
    );

    assert.equal(detail.safetyScore, 53, 'the last good score survives a failed cycle');
    assert.equal(detail.computedAt, COMPUTED_AT.toISOString());
    assert.equal(detail.lastRunStatus, 'failed');
    assert.equal(detail.lastRunAt, failedAt.toISOString());
    assert.notEqual(
      detail.lastRunAt,
      detail.computedAt,
      'a stale entry is exactly one whose last run is newer than its score',
    );
  });

  it('returns nulls, not zeros, for a protocol that has never scored', () => {
    // A brand-new adapter whose every run has failed. Zero here would rank it
    // as the least safe protocol on the board rather than as unscored.
    const detail = toProtocolDetail(
      detailRow({
        safety_score: null,
        computed_at: null,
        factors: null,
        methodology_version: null,
        last_run_status: 'failed',
      }),
      [failedRow()],
    );
    assert.equal(detail.safetyScore, null);
    assert.equal(detail.computedAt, null);
    assert.equal(detail.factors, null);
    assert.equal(detail.methodologyVersion, null);
    assert.notEqual(detail.safetyScore, 0);
  });

  it('reports a protocol with no runs at all as fully null', () => {
    const detail = toProtocolDetail(
      detailRow({
        safety_score: null,
        computed_at: null,
        factors: null,
        methodology_version: null,
        last_run_at: null,
        last_run_status: null,
      }),
      [],
    );
    assert.equal(detail.lastRunAt, null);
    assert.equal(detail.lastRunStatus, null);
    assert.deepEqual(detail.history, []);
  });

  it('preserves the order the query returned, without re-sorting', () => {
    // Ordering is the SQL's job (`ORDER BY run_at DESC`). If the mapper ever
    // starts sorting, two sources of truth exist and they will disagree.
    const t = (min: number) => new Date(Date.parse('2026-08-16T11:00:00.000Z') + min * 60_000);
    const detail = toProtocolDetail(detailRow(), [
      okRow({ run_at: t(30), safety_score: '55' }),
      failedRow({ run_at: t(20) }),
      okRow({ run_at: t(10), safety_score: '51' }),
    ]);
    assert.deepEqual(
      detail.history.map((h) => [h.status, h.runAt]),
      [
        ['ok', t(30).toISOString()],
        ['failed', t(20).toISOString()],
        ['ok', t(10).toISOString()],
      ],
    );
  });

  it('maps a mixed history one entry at a time', () => {
    const detail = toProtocolDetail(detailRow(), [okRow(), failedRow(), okRow()]);
    assert.deepEqual(
      detail.history.map((h) => h.status),
      ['ok', 'failed', 'ok'],
    );
  });
});

describe('toLeaderboardEntry', () => {
  const row = (over: Partial<LeaderboardRow> = {}): LeaderboardRow => ({
    id: 'blend',
    name: 'Blend',
    chain: 'stellar',
    safety_score: '53',
    computed_at: COMPUTED_AT,
    last_run_at: RUN_AT,
    last_run_status: 'ok',
    ...over,
  });

  it('maps a scored protocol to the documented shape', () => {
    assert.deepEqual(toLeaderboardEntry(row()), {
      id: 'blend',
      name: 'Blend',
      chain: 'stellar',
      safetyScore: 53,
      computedAt: COMPUTED_AT.toISOString(),
      lastRunAt: RUN_AT.toISOString(),
      lastRunStatus: 'ok',
    });
  });

  it('keeps a never-scored protocol as null rather than 0', () => {
    // The board ranks on safetyScore; a 0 would sort an unscored protocol below
    // every real one instead of into the nulls-last bucket the SQL puts it in.
    const entry = toLeaderboardEntry(row({ safety_score: null, computed_at: null }));
    assert.equal(entry.safetyScore, null);
    assert.equal(entry.computedAt, null);
  });

  it('surfaces a stale entry via lastRunStatus without disturbing the score', () => {
    const entry = toLeaderboardEntry(row({ last_run_status: 'failed' }));
    assert.equal(entry.safetyScore, 53);
    assert.equal(entry.lastRunStatus, 'failed');
  });
});
