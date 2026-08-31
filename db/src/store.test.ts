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
  toDeployedOn,
  toCurrentRegistryExportEntry,
  toHistoryEntry,
  toLeaderboardEntry,
  toProtocolDetail,
  toRunHealthEntry,
  type CurrentRegistryExportRow,
  type HistoryRow,
  type LeaderboardRow,
  type ProtocolDetailRow,
  type RunHealthRow,
} from './store.ts';
import { OperationalLevel, PoolOperation } from '@stenion/core';
import type { OperationalState, RiskFactorMap } from '@stenion/core';

const RUN_AT = new Date('2026-08-16T11:25:02.000Z');
const COMPUTED_AT = new Date('2026-08-16T11:25:01.000Z');

const FACTORS = {
  collateralSafety: { value: 70, weight: 0.2, detail: 'x' },
} as unknown as RiskFactorMap;

/** A restricted state, so a mapping that drops the field can't pass by matching a default. */
const OPERATIONAL_STATE: OperationalState = {
  level: OperationalLevel.EntryDisabled,
  source: 'PoolConfig.status = 4',
  blocked: [PoolOperation.Supply, PoolOperation.Borrow],
  origin: 'admin',
  detail: 'pool status 4 (Admin Frozen)',
  asOf: '2026-08-16T11:25:01.000Z',
};

/** An `ok` risk_scores row as pg hands it back: numeric as string, timestamptz as Date. */
const okRow = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  status: 'ok',
  safety_score: '53',
  error: null,
  factors: FACTORS,
  computed_at: COMPUTED_AT,
  run_at: RUN_AT,
  methodology_version: 1,
  ...over,
});

const failedRow = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  status: 'failed',
  safety_score: null,
  error: 'Blend: simulation of lastprice failed',
  factors: null,
  computed_at: null,
  run_at: RUN_AT,
  methodology_version: null,
  ...over,
});

const detailRow = (over: Partial<ProtocolDetailRow> = {}): ProtocolDetailRow => ({
  id: 'blend',
  name: 'Blend',
  chain: 'stellar',
  category: 'lending',
  adapter: 'BlendAdapter',
  logo: '/assets/protocols/blend.svg',
  contract_id: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  site_url: 'https://www.blend.capital',
  docs_url: 'https://docs.blend.capital',
  operational_state: OPERATIONAL_STATE,
  // NULL is the normal case — Blend runs on its own contracts. The YieldBlox
  // pool is the row that sets these; see the deployment suite below.
  deployment_host: null,
  deployment_label: null,
  safety_score: '53',
  computed_at: COMPUTED_AT,
  factors: FACTORS,
  methodology_version: 1,
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
      methodologyVersion: 1,
      factors: FACTORS,
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
    // Same rule, same reason: a failed run has no breakdown either, and an
    // empty object here would render as five factors that scored nothing.
    assert.ok(!('factors' in entry), 'failed entries must not carry factors at all');
    assert.notEqual(entry.safetyScore, 0);
  });

  it('carries the factor map that run stored, not the protocol current one', () => {
    // The point of surfacing factors per history row: a run's breakdown is
    // what THAT run computed. If this were sourced from the detail's top-level
    // factors instead, every row in the list would show today's numbers under
    // yesterday's date — which is worse than not showing them at all.
    const older = {
      collateralSafety: { value: 41, weight: 0.2, detail: 'as it was' },
    } as unknown as RiskFactorMap;

    const entry = toHistoryEntry(okRow({ factors: older, safety_score: '41' }));
    assert.equal(entry.status === 'ok' && entry.factors, older);
    assert.notEqual(entry.status === 'ok' && entry.factors, FACTORS);
  });

  it('keeps runAt on both arms, so every run is placeable in time', () => {
    assert.equal(toHistoryEntry(okRow()).runAt, RUN_AT.toISOString());
    assert.equal(toHistoryEntry(failedRow()).runAt, RUN_AT.toISOString());
  });

  it('carries the methodology version through on ok rows, whatever it is', () => {
    // Everything stored today is v1, but the mapping must not special-case that:
    // scores under different rulebooks are not comparable, and this stamp is what
    // lets the chart break the line rather than draw a step change through it.
    // Asserted against a hypothetical future bump so the path stays exercised
    // before there is any real second version to exercise it with.
    for (const version of [1, 2, 7]) {
      const entry = toHistoryEntry(okRow({ methodology_version: version }));
      assert.equal(entry.status === 'ok' && entry.methodologyVersion, version);
    }
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
    assert.equal(detail.methodologyVersion, 1);
    assert.equal(detail.lastRunStatus, 'ok');
    assert.equal(detail.history.length, 1);
    assert.equal(detail.factors, FACTORS);
  });

  it('carries protocol identity independently of scoring state', () => {
    // logo/contractId/site/docs describe the PROTOCOL, not a run, so they must
    // survive a protocol that has never scored — that is exactly when a reader
    // most wants the contract link, to see for themselves what the indexer
    // could not read. Coupling them to the latest-ok LATERAL join would blank
    // them on the never-scored case.
    const detail = toProtocolDetail(
      detailRow({
        safety_score: null,
        computed_at: null,
        factors: null,
        methodology_version: null,
      }),
      [],
    );

    assert.equal(detail.safetyScore, null);
    assert.equal(detail.logo, '/assets/protocols/blend.svg');
    assert.equal(detail.contractId, 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD');
    assert.equal(detail.site, 'https://www.blend.capital');
    assert.equal(detail.docs, 'https://docs.blend.capital');
  });

  it('maps absent identity columns to null, never to a placeholder', () => {
    // A protocol with no mark and no published docs. Each must arrive as null
    // so the UI can choose a deliberate rendering (initials tile / omit the
    // link) instead of emitting a dead href or a 404 image.
    const detail = toProtocolDetail(detailRow({ logo: null, docs_url: null }), [okRow()]);

    assert.equal(detail.logo, null);
    assert.equal(detail.docs, null);
    assert.equal(
      detail.site,
      'https://www.blend.capital',
      'one absent link does not blank another',
    );
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
    category: 'lending',
    logo: '/assets/protocols/blend.svg',
    deployment_host: null,
    deployment_label: null,
    operational_state: OPERATIONAL_STATE,
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
      // On the BOARD for the same reason operationalState is: two rows' scores
      // mean the same thing only when this agrees, so a consumer that ranks
      // these entries needs it on every row to scope the ranking.
      category: 'lending',
      logo: '/assets/protocols/blend.svg',
      deployedOn: null,
      safetyScore: 53,
      computedAt: COMPUTED_AT.toISOString(),
      // On the BOARD, not only on the detail response — see LeaderboardEntry.
      // A halted market and an open one can publish the same number, so a
      // reader who scans the registry and leaves has to have been shown this.
      operationalState: OPERATIONAL_STATE,
      lastRunAt: RUN_AT.toISOString(),
      lastRunStatus: 'ok',
    });
  });

  it('publishes null for a run predating the column, never a fabricated "active"', () => {
    // Migration 0007 added operational_state; rows written before it, or by a
    // deploy still running the previous indexer, have none. Null means "not
    // read". Defaulting to an unrestricted state here would publish a clean
    // bill of health for a market nobody looked at — the exact fabrication
    // METHODOLOGY.md ground rule 4 forbids.
    assert.equal(toLeaderboardEntry(row({ operational_state: null })).operationalState, null);
  });

  it('passes a missing logo through as null rather than a placeholder path', () => {
    // A protocol with no usable mark is a supported state the UI renders as an
    // initials tile. Defaulting to some '/assets/protocols/unknown.svg' here
    // would put a 404 in every such row — the exact layout-shifting broken
    // image the tile exists to avoid — and would hide the real answer from API
    // consumers, who cannot tell a placeholder from a real mark.
    assert.equal(toLeaderboardEntry(row({ logo: null })).logo, null);
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

describe('toCurrentRegistryExportEntry', () => {
  const row = (over: Partial<CurrentRegistryExportRow> = {}): CurrentRegistryExportRow => ({
    id: 'blend',
    name: 'Blend',
    chain: 'stellar',
    category: 'lending',
    logo: '/assets/protocols/blend.svg',
    deployment_host: null,
    deployment_label: null,
    safety_score: '53',
    computed_at: COMPUTED_AT,
    methodology_version: 1,
    factors: FACTORS,
    operational_state: OPERATIONAL_STATE,
    last_run_at: RUN_AT,
    last_run_status: 'ok',
    ...over,
  });

  it('maps a currently scored row with factors and methodologyVersion', () => {
    const entry = toCurrentRegistryExportEntry(row());
    assert.deepEqual(entry, {
      id: 'blend',
      name: 'Blend',
      chain: 'stellar',
      category: 'lending',
      logo: '/assets/protocols/blend.svg',
      deployedOn: null,
      safetyScore: 53,
      computedAt: '2026-08-16T11:25:01.000Z',
      methodologyVersion: 1,
      factors: FACTORS,
      operationalState: OPERATIONAL_STATE,
      lastRunAt: '2026-08-16T11:25:02.000Z',
      lastRunStatus: 'ok',
    });
  });

  it('keeps a stale latest-run status without disturbing the latest successful score', () => {
    const failedAt = new Date('2026-08-16T11:30:02.000Z');
    const entry = toCurrentRegistryExportEntry(
      row({ last_run_at: failedAt, last_run_status: 'failed' }),
    );
    assert.equal(entry.safetyScore, 53);
    assert.equal(entry.computedAt, COMPUTED_AT.toISOString());
    assert.equal(entry.lastRunStatus, 'failed');
    assert.equal(entry.lastRunAt, failedAt.toISOString());
  });

  it('preserves category-specific factor maps exactly', () => {
    const dexFactors = {
      adminKeySafety: { value: 10, weight: 0.55, detail: 'role posture' },
      assetControlSafety: { value: 40, weight: 0.45, detail: 'issuer controls' },
    };
    const entry = toCurrentRegistryExportEntry(
      row({ category: 'dex', factors: dexFactors, safety_score: '24' }),
    );
    assert.equal(entry.category, 'dex');
    assert.deepEqual(entry.factors, dexFactors);
    assert.deepEqual(Object.keys(entry.factors).sort(), ['adminKeySafety', 'assetControlSafety']);
  });

  it('passes a null operationalState through as not-read, not active', () => {
    assert.equal(
      toCurrentRegistryExportEntry(row({ operational_state: null })).operationalState,
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// The shape an EMPTY `risk_scores` table produces.
//
// WHY THIS EXISTS: both read queries LEFT JOIN LATERAL onto `risk_scores`, so
// wiping that table does not remove protocols from the API — it returns every
// protocol with every score-derived column null, including `last_run_at` and
// `last_run_status`, which the never-scored tests above still populate. That is
// a distinct row shape, it is what the site serves for the whole window between
// a history wipe and the next indexer run, and it is otherwise only reachable in
// production for a few minutes at a time. Pin it here rather than discover it
// there.
// ---------------------------------------------------------------------------

describe('an empty risk_scores table', () => {
  /** Exactly what the LATERAL joins yield when the table has no rows at all. */
  const wipedDetail = (): ProtocolDetailRow =>
    detailRow({
      safety_score: null,
      computed_at: null,
      factors: null,
      methodology_version: null,
      last_run_at: null,
      last_run_status: null,
    });

  it('still returns the protocol, rather than dropping or 404ing it', () => {
    // The API 404s on an unknown id. A known protocol with no scores is not
    // unknown, and must not become so — the detail route reads `!detail`, which
    // is only null when the `protocols` row itself is missing.
    const detail = toProtocolDetail(wipedDetail(), []);
    assert.equal(detail.id, 'blend');
    assert.equal(detail.name, 'Blend');
    assert.equal(detail.adapter, 'BlendAdapter');
  });

  it('nulls every score-derived field and empties the history', () => {
    const detail = toProtocolDetail(wipedDetail(), []);
    assert.deepEqual(
      {
        safetyScore: detail.safetyScore,
        computedAt: detail.computedAt,
        factors: detail.factors,
        methodologyVersion: detail.methodologyVersion,
        lastRunAt: detail.lastRunAt,
        lastRunStatus: detail.lastRunStatus,
        history: detail.history,
      },
      {
        safetyScore: null,
        computedAt: null,
        factors: null,
        methodologyVersion: null,
        lastRunAt: null,
        lastRunStatus: null,
        history: [],
      },
    );
  });

  it('keeps the verification links a reader needs precisely when there is no score', () => {
    // With no number to show, the contract link is the only thing on the page
    // that still lets someone check the protocol themselves.
    const detail = toProtocolDetail(wipedDetail(), []);
    assert.equal(detail.contractId, 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD');
    assert.equal(detail.site, 'https://www.blend.capital');
    assert.equal(detail.logo, '/assets/protocols/blend.svg');
  });

  it('produces a leaderboard entry the UI reads as "never run"', () => {
    // `lastRunStatus: null` is what drives freshness() to the "never run"
    // branch, and `safetyScore: null` is what makes ScoreRing render an em dash
    // instead of a zero. A wiped table must not look like a pool that scored 0.
    const entry = toLeaderboardEntry({
      id: 'blend',
      name: 'Blend',
      chain: 'stellar',
      category: 'lending',
      logo: '/assets/protocols/blend.svg',
      deployment_host: null,
      deployment_label: null,
      operational_state: null,
      safety_score: null,
      computed_at: null,
      last_run_at: null,
      last_run_status: null,
    });
    assert.equal(entry.safetyScore, null, 'null, never 0 — 0 means "scored, and unsafe"');
    assert.equal(entry.lastRunStatus, null);
    assert.equal(entry.computedAt, null);
    assert.equal(entry.name, 'Blend');
  });
});

// ---------------------------------------------------------------------------
// `deployedOn` — the label that stops one protocol's pool reading as a second
// protocol.
//
// WHY IT IS TESTED HERE and not left to the UI: this is the field on which
// registering the YieldBlox pool was made conditional. If it silently mapped to
// null, the registry would list a Blend market beside Blend and Kinetic with
// nothing to distinguish it, which is precisely the misrepresentation Stenion
// refused to publish when it declined to build a standalone YieldBlox adapter.
// A wrong number is visibly wrong; a missing label just reads as a third
// protocol.
// ---------------------------------------------------------------------------

describe('toDeployedOn — the two deployment columns as one published object', () => {
  it('maps a complete pair to the object the API publishes', () => {
    assert.deepEqual(toDeployedOn('Blend', 'Blend V2 pool'), {
      host: 'Blend',
      label: 'Blend V2 pool',
    });
  });

  it('maps both-null to null — an entry on its own contracts', () => {
    // The common case, and it must stay cheap and unambiguous: null here means
    // "independent", never "we did not check".
    assert.equal(toDeployedOn(null, null), null);
  });

  it('refuses a half-populated pair rather than publishing a partial claim', () => {
    // Unreachable from the adapter — ProtocolDeployment makes both fields
    // required, so a writer supplies the object or omits it — but reachable from
    // a hand-edited row or a half-applied migration. Emitting
    // `{ host: null, label: 'Blend V2 pool' }` would be a shape no consumer was
    // promised, built from data we already know is broken.
    assert.equal(toDeployedOn(null, 'Blend V2 pool'), null);
    assert.equal(toDeployedOn('Blend', null), null);
  });
});

describe('the deployment label on both public responses', () => {
  const yieldbloxDetail = detailRow({
    id: 'yieldblox',
    name: 'YieldBlox',
    // Same adapter as Blend, deliberately: one engine, two pools. This pairing —
    // a BlendAdapter row that is not named Blend — is exactly why the label has
    // to be present, so `adapter: 'BlendAdapter'` reads as the point rather than
    // as a bug.
    adapter: 'BlendAdapter',
    // Mirrors the real row rather than a plausible-looking one, so a reader
    // comparing this fixture against the live entry finds them agreeing. The
    // null-logo path has its own coverage on the leaderboard mapping above and
    // does not need to be smuggled in here.
    logo: '/assets/protocols/yieldblox.png',
    contract_id: 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS',
    site_url: 'https://www.yieldblox.xyz',
    docs_url: null,
    deployment_host: 'Blend',
    deployment_label: 'Blend V2 pool',
  });

  it('publishes it on the detail response', () => {
    const detail = toProtocolDetail(yieldbloxDetail, [okRow()]);
    assert.deepEqual(detail.deployedOn, { host: 'Blend', label: 'Blend V2 pool' });
  });

  it('publishes it on the leaderboard too, not only on the detail call', () => {
    // The board is where the misreading happens: a reader scanning three rows
    // and leaving never makes the detail request. Unlike contractId/site/docs,
    // this one has to survive the trip to every row.
    const entry = toLeaderboardEntry({
      id: 'yieldblox',
      name: 'YieldBlox',
      chain: 'stellar',
      category: 'lending',
      logo: null,
      deployment_host: 'Blend',
      deployment_label: 'Blend V2 pool',
      operational_state: OPERATIONAL_STATE,
      safety_score: '24',
      computed_at: COMPUTED_AT,
      last_run_at: RUN_AT,
      last_run_status: 'ok',
    });
    assert.deepEqual(entry.deployedOn, { host: 'Blend', label: 'Blend V2 pool' });
  });

  it('leaves an independent protocol null on both', () => {
    assert.equal(toProtocolDetail(detailRow(), [okRow()]).deployedOn, null);
  });

  it('survives a protocol with no score at all', () => {
    // Identity is not score-derived, so a market that has never scored — or
    // whose history was wiped — must still say what it is. This is the window in
    // which a reader is MOST likely to be looking at an unfamiliar entry.
    const detail = toProtocolDetail(
      detailRow({
        ...yieldbloxDetail,
        safety_score: null,
        computed_at: null,
        factors: null,
        methodology_version: null,
        last_run_at: null,
        last_run_status: null,
      }),
      [],
    );
    assert.equal(detail.safetyScore, null);
    assert.deepEqual(detail.deployedOn, { host: 'Blend', label: 'Blend V2 pool' });
  });
});

describe('toRunHealthEntry — the two timestamps GET /api/v1/health is built on', () => {
  // `last_successful_run_at` and `last_run_at` are separate columns because the
  // difference between them is the whole signal: a fresh last run beside a stale
  // last SUCCESS is one broken adapter, and both stale together is the cron not
  // arriving. Collapsing them would erase the distinction an operator needs.

  const healthRow = (over: Partial<RunHealthRow> = {}): RunHealthRow => ({
    id: 'blend',
    last_successful_run_at: RUN_AT,
    last_run_at: RUN_AT,
    last_run_status: 'ok',
    ...over,
  });

  it('maps a healthy protocol, coercing timestamptz to ISO strings', () => {
    assert.deepEqual(toRunHealthEntry(healthRow()), {
      id: 'blend',
      lastSuccessfulRunAt: '2026-08-16T11:25:02.000Z',
      lastRunAt: '2026-08-16T11:25:02.000Z',
      lastRunStatus: 'ok',
    });
  });

  it('keeps the last successful run visible when the newest run failed', () => {
    // The failing-adapter case. The success timestamp must NOT advance to the
    // failed run's — staleness is measured from it, and moving it would report a
    // protocol that fails every cycle as permanently fresh.
    const later = new Date('2026-08-16T11:30:02.000Z');
    const entry = toRunHealthEntry(healthRow({ last_run_at: later, last_run_status: 'failed' }));
    assert.equal(entry.lastSuccessfulRunAt, '2026-08-16T11:25:02.000Z');
    assert.equal(entry.lastRunAt, '2026-08-16T11:30:02.000Z');
    assert.equal(entry.lastRunStatus, 'failed');
  });

  it('maps a protocol that has never succeeded to nulls, not to an epoch', () => {
    const entry = toRunHealthEntry(
      healthRow({ last_successful_run_at: null, last_run_at: null, last_run_status: null }),
    );
    assert.equal(entry.lastSuccessfulRunAt, null);
    assert.equal(entry.lastRunAt, null);
    assert.equal(entry.lastRunStatus, null);
  });

  it('reports a protocol that has only ever failed', () => {
    // Runs exist, none of them ok: the indexer is reaching this protocol and
    // getting nothing usable. Distinct from the never-ran case above, and the
    // health policy has to be able to tell them apart.
    const entry = toRunHealthEntry(
      healthRow({ last_successful_run_at: null, last_run_status: 'failed' }),
    );
    assert.equal(entry.lastSuccessfulRunAt, null);
    assert.equal(entry.lastRunAt, '2026-08-16T11:25:02.000Z');
    assert.equal(entry.lastRunStatus, 'failed');
  });

  it('publishes ok/failed, the same vocabulary as the other routes', () => {
    // Not `success`/`failure`. One field name carrying two vocabularies across a
    // single API is a bug a consumer only finds in production.
    assert.equal(
      toRunHealthEntry(healthRow({ last_run_status: 'failed' })).lastRunStatus,
      'failed',
    );
    assert.equal(toRunHealthEntry(healthRow({ last_run_status: 'ok' })).lastRunStatus, 'ok');
  });

  it('carries no score, factors, or error text', () => {
    // A freshness probe must not be able to fail because a score was malformed,
    // and it should not republish an adapter's error string on an unauthenticated
    // endpoint. The row type is the enforcement; this pins the published keys.
    assert.deepEqual(Object.keys(toRunHealthEntry(healthRow())).sort(), [
      'id',
      'lastRunAt',
      'lastRunStatus',
      'lastSuccessfulRunAt',
    ]);
  });
});
