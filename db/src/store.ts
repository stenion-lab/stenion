// Typed writes into the Stenion schema. The RunRecord shape below is the exact
// discriminated union the indexer already produces (step 4) — copied verbatim,
// not redesigned. This package now owns the persisted contract so both the
// indexer (writing) and the API (reading, step 6) agree on one definition.

import type {
  FactorMap,
  OperationalState,
  ProtocolCategory,
  ProtocolDeployment,
  ProtocolMetadata,
} from '@stenion/core';
import type { Pool } from 'pg';

/**
 * One indexer run outcome. Mirrors what the indexer emits per cycle:
 * `ok` carries the score/factors/computedAt; `failed` carries an error. The
 * DB's risk_scores_shape CHECK enforces this same split.
 */
export type RunRecord =
  | {
      protocolId: string;
      status: 'ok';
      safetyScore: number;
      /**
       * The factor breakdown behind `safetyScore`, keyed by whichever factors
       * `category` below scores.
       *
       * `FactorMap`, NOT `RiskFactorMap`, AND THE DIFFERENCE IS THE POINT.
       * `RiskFactorMap` is *lending's* map — `Record<RiskFactorType, …>`, its five
       * keys required — and this column has never held anything else because
       * lending was the only category with an adapter. `dex` scores two keys and
       * neither of them is four of lending's five, so a `dex` run could not be
       * written through a `RiskFactorMap`-typed field at all: that was the
       * deliberate compile error left standing here rather than cast past while
       * the dex adapter was being built.
       *
       * The runtime never needed the change. `recordRun` writes
       * `JSON.stringify(record.factors)` into a `$4::jsonb` column and nothing in
       * the write or read path inspects a key, so a two-key map already stored and
       * returned byte-for-byte. What was wrong was the *declared* type, which
       * claimed a key set the column does not enforce and the rulebook does not
       * promise.
       *
       * WHICH KEYS ARE VALID IS STILL FIXED — by `CATEGORY_FACTORS` in
       * `@stenion/core`, per category, not by this type. Widening here is not a
       * licence to invent factor keys per adapter; it is this layer declining to
       * repeat a declaration it is not the source of.
       */
      factors: FactorMap;
      /**
       * The rulebook this score was computed under, stamped with the version
       * below and frozen with it. Together they are the identifier of a
       * rulebook; the version alone is not, because every category's counter
       * starts at 1. See migration 0008 for why this is stamped per run rather
       * than joined from `protocols`.
       *
       * On the `ok` arm only, like `methodologyVersion` and for the same reason:
       * a failed run scored nothing, so there is no rulebook to attribute it to.
       */
      category: ProtocolCategory;
      /**
       * The METHODOLOGY_VERSIONS entry this score was computed under. Stamped by
       * the indexer from @stenion/core from the target's own category, not
       * chosen per adapter — one rulebook applies to every protocol in a
       * category. Scores with different versions are not comparable, and neither
       * are scores from different categories; see migrations 0002 and 0008.
       */
      methodologyVersion: number;
      /**
       * Which operations the market's own gating logic was refusing when this
       * run's inputs were read — published beside the score and never graded
       * (METHODOLOGY.md, "Operational state is published, never scored").
       *
       * On the `ok` arm only, and required there: an adapter that produced a
       * score also produced a state, because both come from the same raw read.
       * The `failed` arm has none, for the same reason it has no factors.
       */
      operationalState: OperationalState;
      computedAt: string;
      runAt: string;
    }
  | {
      protocolId: string;
      status: 'failed';
      error: string;
      runAt: string;
    };

/**
 * One protocol on the leaderboard (GET /api/v1/protocols). `safetyScore`/`computedAt`
 * come from the latest *ok* run (null if the protocol has never scored
 * successfully); `lastRunAt`/`lastRunStatus` describe the most recent run of any
 * status, so a stale score (last run failed) is visible without another call.
 */
export interface LeaderboardEntry {
  id: string;
  name: string;
  chain: string;
  /**
   * Which rulebook produced `safetyScore` — see ProtocolCategory.
   *
   * ON THE BOARD, for the same reason `deployedOn` and `operationalState` are:
   * it is part of what the row IS, not verification detail a reader looks up
   * afterwards. Two rows' scores mean the same thing only when this agrees, so a
   * consumer ranking these entries must scope the ranking to one category. The
   * array's order carries no cross-category claim — API.md says so in the terms
   * clients read, and `dashboard/app/lib/registry-query.ts` enforces it.
   */
  category: ProtocolCategory;
  /**
   * Root-relative path to a logo the dashboard hosts, or null when the protocol
   * publishes no usable mark. Null is a supported, rendered state (an initials
   * tile) — never a broken image. See ProtocolMetadata.logo.
   *
   * The board carries `logo` but NOT `contractId`/`site`/`docs`: a logo is what
   * makes a row scannable, and the rest is verification detail nobody acts on
   * from a list. They stay on the detail response rather than being repeated
   * across every row of every leaderboard fetch.
   */
  logo: string | null;
  /**
   * Set when this entry is a market on another protocol's contracts (see
   * ProtocolDeployment), null when it runs on its own — which is the normal
   * case, and never means "unknown".
   *
   * This one DOES belong on the board, unlike contractId/site/docs above, and
   * for the reason those don't: it is not verification detail a reader looks up
   * after deciding to care, it is part of what the row IS. A row that reads
   * "YieldBlox · 24" next to "Blend · 54" tells a scanner there are two
   * protocols here; the whole point of the label is that it is legible at scan
   * time, which means it has to travel with every row of every leaderboard
   * fetch rather than waiting on the detail call.
   */
  deployedOn: ProtocolDeployment | null;
  safetyScore: number | null;
  computedAt: string | null;
  /**
   * The market's live operational state as of its latest **ok** run — which user
   * operations its own contracts were refusing, and nothing about how bad that
   * is. Null when the protocol has never scored, or when its latest ok run
   * predates the column (migration 0007); null is therefore "not read", never
   * "nothing restricted".
   *
   * ON THE BOARD, like `deployedOn` and unlike `contractId`/`site`/`docs`. It is
   * not verification detail a reader looks up after deciding to care — it is
   * part of what the row IS. A market whose withdrawals are halted and a market
   * that is fully open can publish the same number, and a reader who scans the
   * registry and leaves must not have been shown only the number. That is the
   * entire reason publishing was chosen over scoring: the flag has to
   * travel with every row of every leaderboard fetch, or the decision not to
   * score becomes a decision to hide.
   */
  operationalState: OperationalState | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
}

/**
 * One currently scored registry row for export.
 *
 * This is deliberately the leaderboard's current-state shape plus the score
 * payload the board omits (`factors` and `methodologyVersion`). It is still a
 * snapshot of the latest **ok** score, not history, and it still carries
 * `lastRunAt`/`lastRunStatus` from the latest run of any status so a stale score
 * remains visible when a newer attempt failed.
 */
export interface CurrentRegistryExportEntry {
  id: string;
  name: string;
  chain: string;
  category: ProtocolCategory;
  logo: string | null;
  deployedOn: ProtocolDeployment | null;
  safetyScore: number;
  computedAt: string;
  methodologyVersion: number;
  factors: FactorMap;
  operationalState: OperationalState | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
}

/**
 * One row of a protocol's recent score history (GET /api/v1/protocol/:id). A
 * discriminated union on `status` mirroring the persisted RunRecord: `ok` rows
 * carry the score, its factor breakdown and the timestamps; `failed` rows carry
 * the error.
 *
 * `factors` was withheld here at first and is now returned, because the
 * alternative was worse than the payload it saves. Every run's map was already
 * in the `risk_scores` jsonb, and a consumer that wanted a past run's breakdown
 * had no way to reach it but a per-row request — 50 of them for one page. It is
 * the SAME shape as the detail's top-level `factors`, read under the rulebook
 * named by that row's own `methodologyVersion`: a breakdown from a run stamped
 * with an older version was computed by different rules and is not comparable
 * with a newer one, exactly as the score isn't.
 */
export type HistoryEntry =
  | {
      status: 'ok';
      safetyScore: number;
      /** methodology version this point was scored under — see migration 0002 */
      methodologyVersion: number;
      /**
       * The breakdown behind `safetyScore`, as that run computed it. Non-null on
       * an `ok` row by the `risk_scores_shape` CHECK — a scored run without a
       * factor map cannot be written.
       *
       * `FactorMap`: the keys are the ones the rulebook named by this row's own
       * `methodologyVersion` **and category** scored. See `RunRecord.factors`.
       */
      factors: FactorMap;
      computedAt: string;
      runAt: string;
    }
  | { status: 'failed'; error: string; runAt: string };

/**
 * Full detail for one protocol (GET /api/v1/protocol/:id). Top-level
 * `safetyScore`/`computedAt`/`factors` describe the latest *ok* run (all null if
 * never scored); `lastRunAt`/`lastRunStatus` describe the newest run of any
 * status; `history` is the recent run rows, newest first.
 */
export interface ProtocolDetail {
  id: string;
  name: string;
  chain: string;
  /** which rulebook scores this protocol — see LeaderboardEntry.category */
  category: ProtocolCategory;
  adapter: string;
  /** see LeaderboardEntry.logo — same value, same null-is-fine contract */
  logo: string | null;
  /**
   * The Soroban contract the score was derived from, or null if unknown. A raw
   * C-address, deliberately NOT an explorer URL — the consumer picks the
   * explorer. This is the field that lets a reader check a score against the
   * chain instead of trusting it.
   */
  contractId: string | null;
  /**
   * The protocol's own site and documentation, null when it publishes none.
   *
   * Listed as the subject's own properties, not as a recommendation: a link
   * here is not endorsement, partnership, or any relationship with Stenion, and
   * any UI rendering them must say so. The dashboard uses
   * `rel="noopener noreferrer nofollow"` so a link cannot pass ranking signal
   * or hand the destination a window handle back into the page.
   */
  site: string | null;
  docs: string | null;
  /** see LeaderboardEntry.deployedOn — same value, same null-means-independent contract */
  deployedOn: ProtocolDeployment | null;
  safetyScore: number | null;
  computedAt: string | null;
  factors: FactorMap | null;
  /**
   * The market's live operational state as of its latest **ok** run — which user
   * operations its own contracts were refusing, and nothing about how bad that
   * is. Null when the protocol has never scored, or when its latest ok run
   * predates the column (migration 0007); null is therefore "not read", never
   * "nothing restricted".
   *
   * ON THE BOARD, like `deployedOn` and unlike `contractId`/`site`/`docs`. It is
   * not verification detail a reader looks up after deciding to care — it is
   * part of what the row IS. A market whose withdrawals are halted and a market
   * that is fully open can publish the same number, and a reader who scans the
   * registry and leaves must not have been shown only the number. That is the
   * entire reason publishing was chosen over scoring: the flag has to
   * travel with every row of every leaderboard fetch, or the decision not to
   * score becomes a decision to hide.
   */
  operationalState: OperationalState | null;

  /**
   * Methodology version behind the current score (null if never scored). History
   * points carry their own, so a client can see where the rules changed rather
   * than reading a step change as a real move in risk.
   */
  methodologyVersion: number | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
  history: HistoryEntry[];
}

/** How many recent history rows GET /api/v1/protocol/:id returns. */
export const DETAIL_HISTORY_LIMIT = 50;

/**
 * One run's status and error, newest-first, for the indexer's consecutive-failure
 * check. Deliberately narrower than `HistoryEntry`: the streak logic needs only
 * whether a run failed, what it said, and when — never a score or a factor map.
 */
export interface RecentRun {
  status: 'ok' | 'failed';
  /** the failure message on a failed run; null on an ok one */
  error: string | null;
  runAt: string;
}

/**
 * One protocol's run freshness, for `GET /api/v1/health`.
 *
 * Deliberately the narrowest row in this file: no score, no factors, no error
 * text. A health probe answers "is the pipeline producing data", and the answer
 * must not depend on reading a score — an endpoint that has to pull the factor
 * jsonb to tell you the indexer is alive is one more thing that can be slow or
 * broken while the thing it reports on is fine.
 *
 * The two timestamps are NOT redundant, and the difference between them is the
 * whole point of the endpoint:
 *
 *   `lastSuccessfulRunAt` — the newest **ok** run. This is what staleness is
 *     measured from, because a failed run produced no data. Null means this
 *     protocol has never scored successfully; that is never-current, not
 *     "unknown", and the health policy treats it as such.
 *   `lastRunAt`/`lastRunStatus` — the newest run of **any** status. These say
 *     whether the indexer is still *reaching* this protocol at all. A fresh
 *     `lastRunAt` with a stale `lastSuccessfulRunAt` is a broken adapter (the
 *     cron is firing, the scoring is failing); both stale together is the cron
 *     itself not arriving. Flattening them into one field would erase exactly
 *     the distinction an operator needs to know where to look.
 */
export interface RunHealthEntry {
  id: string;
  lastSuccessfulRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
}

export interface Store {
  /**
   * Insert-or-update the protocol row from adapter metadata. Idempotent.
   *
   * The adapter reference comes from `metadata.adapterRef` rather than a
   * separate argument so there is exactly one source for it — see
   * ProtocolMetadata.adapterRef for why it must be a literal.
   */
  upsertProtocol(metadata: ProtocolMetadata): Promise<void>;
  /** Append one run outcome to risk_scores. */
  insertRunRecord(record: RunRecord): Promise<void>;
  /** Every protocol with its latest-ok score, ranked by score desc (nulls last). */
  listProtocolsWithLatestScore(): Promise<LeaderboardEntry[]>;
  /**
   * Every currently scored protocol/market, one row per latest successful score.
   * Never-scored protocols are excluded rather than exported with fake scores.
   */
  listCurrentScoredRegistryState(): Promise<CurrentRegistryExportEntry[]>;
  /** One protocol's detail + recent history, or null if the id is unknown. */
  getProtocolDetail(id: string): Promise<ProtocolDetail | null>;
  /**
   * The newest `limit` runs for one protocol, newest first — status/error/runAt
   * only. This is what the indexer derives a consecutive-failure streak from
   * rather than persisting a counter: the history IS the streak, so the two
   * cannot disagree. An unknown protocol, or one with no runs yet, returns `[]`
   * — and an empty array must read as "no failures", never as "never succeeded".
   */
  listRecentRuns(protocolId: string, limit: number): Promise<RecentRun[]>;
  /**
   * Every protocol's last successful run, last run, and last run status — one
   * row per protocol, one query. Backs `GET /api/v1/health`.
   *
   * Ordered by id, NOT by anything score-derived. Health carries no ranking:
   * alphabetical is the one ordering that asserts nothing about which protocol
   * is doing better, which is correct for a list whose entries are only ever
   * "current" or "not".
   */
  listRunHealth(): Promise<RunHealthEntry[]>;
}

/**
 * The two deployment columns -> the public `deployedOn` object, or null.
 *
 * Both must be present. They are written as a pair from a `ProtocolDeployment`
 * (where both fields are required), so a half-populated row can only come from
 * a hand-edit or a partially-applied migration — and in that case null is the
 * honest answer. A `{ host: null, label: 'Blend V2 pool' }` on the public API
 * would be a shape no consumer was promised, published from data we know is
 * broken; omitting the claim is strictly better than half-making it.
 */
export function toDeployedOn(host: string | null, label: string | null): ProtocolDeployment | null {
  return host === null || label === null ? null : { host, label };
}

/** timestamptz comes back from pg as a Date; the API contract is ISO strings. */
function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** numeric comes back from pg as a string; the API contract is a number. */
function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------
// Row → response mapping
//
// Split out of the query methods and exported so the *shape* of the public API
// can be tested without a database. The SQL decides which rows come back and in
// what order; these decide what they look like on the wire — the discriminated
// union, the numeric/timestamp coercions, and the staleness fields. That second
// half is the part external consumers actually depend on.
// ---------------------------------------------------------------------------

/** A `risk_scores` row as pg returns it. */
export interface HistoryRow {
  status: 'ok' | 'failed';
  safety_score: string | null;
  error: string | null;
  factors: FactorMap | null;
  computed_at: Date | null;
  run_at: Date;
  methodology_version: number | null;
}

/**
 * One history row → one `HistoryEntry`.
 *
 * The `ok` and `failed` arms carry disjoint fields on purpose: a failed run has
 * no score, and must never be representable as one (a zero here would render as
 * a real, very bad score rather than as "unknown"). The non-null assertions on
 * the ok arm are backed by the `risk_scores_shape` CHECK constraint.
 */
export function toHistoryEntry(row: HistoryRow): HistoryEntry {
  return row.status === 'ok'
    ? {
        status: 'ok',
        // non-null on ok rows by the risk_scores_shape CHECK
        safetyScore: toNumber(row.safety_score) as number,
        // non-null on ok rows by risk_scores_methodology_version_shape
        methodologyVersion: row.methodology_version as number,
        // jsonb comes back parsed, so this passes straight through like the
        // detail's top-level factors; non-null on ok rows by risk_scores_shape.
        //
        // THE CAST ASSERTS NON-NULL AND NOTHING ELSE. It used to read
        // `as RiskFactorMap`, which additionally claimed the row held lending's
        // five keys — true of every row written before `dex` existed and a lie
        // about a `dex` row, whose map has two. A consumer reading
        // `.oracleSafety` off one would have got `undefined` with no error
        // anywhere. `FactorMap` is what the column actually guarantees: a map of
        // factor keys, whose key set belongs to the row's own category.
        factors: row.factors as FactorMap,
        computedAt: toIso(row.computed_at) as string,
        runAt: row.run_at.toISOString(),
      }
    : {
        status: 'failed',
        error: row.error as string,
        runAt: row.run_at.toISOString(),
      };
}

/** A `protocols` row joined with its latest-ok score and newest run, as pg returns it. */
export interface ProtocolDetailRow {
  id: string;
  name: string;
  chain: string;
  /** NOT NULL as of migration 0008, defaulted for the pre-category writer */
  category: string;
  adapter: string;
  logo: string | null;
  contract_id: string | null;
  site_url: string | null;
  docs_url: string | null;
  deployment_host: string | null;
  deployment_label: string | null;
  safety_score: string | null;
  computed_at: Date | null;
  factors: FactorMap | null;
  operational_state: OperationalState | null;
  methodology_version: number | null;
  last_run_at: Date | null;
  last_run_status: 'ok' | 'failed' | null;
}

/**
 * Detail row + history rows → the `GET /api/v1/protocol/:id` body.
 *
 * The staleness model lives here: `safetyScore`/`computedAt`/`factors` describe
 * the latest **ok** run and are null when a protocol has never scored, while
 * `lastRunAt`/`lastRunStatus` describe the newest run of **any** status. They
 * come from two separate LATERAL joins precisely so a failed cycle leaves the
 * last good score visible and flags it as stale, rather than blanking the entry.
 */
export function toProtocolDetail(
  row: ProtocolDetailRow,
  historyRows: HistoryRow[],
): ProtocolDetail {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain,
    // Cast, like last_run_status above it: the column is `text` and the union
    // is enforced by what upsertProtocol writes, which is ProtocolMetadata's
    // already-typed `category`. Nothing else writes this table.
    category: row.category as ProtocolCategory,
    adapter: row.adapter,
    // Identity columns are nullable in the schema and pass straight through:
    // "this protocol has no published mark / no docs site" is a real answer the
    // UI renders deliberately, so there is nothing to coerce or default here.
    logo: row.logo,
    contractId: row.contract_id,
    site: row.site_url,
    docs: row.docs_url,
    deployedOn: toDeployedOn(row.deployment_host, row.deployment_label),
    safetyScore: toNumber(row.safety_score),
    computedAt: toIso(row.computed_at),
    factors: row.factors,
    // Passes straight through, like `factors`: jsonb comes back parsed, and a
    // row written before migration 0007 is null here — see LeaderboardEntry.
    operationalState: row.operational_state,
    methodologyVersion: row.methodology_version,
    lastRunAt: toIso(row.last_run_at),
    lastRunStatus: row.last_run_status,
    history: historyRows.map(toHistoryEntry),
  };
}

/** A `protocols` row joined with its latest-ok score, as pg returns it. */
export interface LeaderboardRow {
  id: string;
  name: string;
  chain: string;
  /** NOT NULL as of migration 0008, defaulted for the pre-category writer */
  category: string;
  logo: string | null;
  deployment_host: string | null;
  deployment_label: string | null;
  safety_score: string | null;
  computed_at: Date | null;
  operational_state: OperationalState | null;
  last_run_at: Date | null;
  last_run_status: 'ok' | 'failed' | null;
}

/** One leaderboard row → one `LeaderboardEntry`. Ranking is the SQL's job, not this. */
export function toLeaderboardEntry(row: LeaderboardRow): LeaderboardEntry {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain,
    /* see toProtocolDetail on the cast */
    category: row.category as ProtocolCategory,
    logo: row.logo,
    deployedOn: toDeployedOn(row.deployment_host, row.deployment_label),
    safetyScore: toNumber(row.safety_score),
    computedAt: toIso(row.computed_at),
    operationalState: row.operational_state,
    lastRunAt: toIso(row.last_run_at),
    lastRunStatus: row.last_run_status,
  };
}

/**
 * A scored export row as pg returns it. It is the leaderboard row plus the
 * latest-ok score payload, with non-null score fields because the query joins
 * only protocols that have a successful run.
 */
export interface CurrentRegistryExportRow {
  id: string;
  name: string;
  chain: string;
  category: string;
  logo: string | null;
  deployment_host: string | null;
  deployment_label: string | null;
  safety_score: string;
  computed_at: Date;
  methodology_version: number;
  factors: FactorMap;
  operational_state: OperationalState | null;
  last_run_at: Date | null;
  last_run_status: 'ok' | 'failed' | null;
}

/** One export row -> one current scored registry entry. */
export function toCurrentRegistryExportEntry(
  row: CurrentRegistryExportRow,
): CurrentRegistryExportEntry {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain,
    /* see toProtocolDetail on the cast */
    category: row.category as ProtocolCategory,
    logo: row.logo,
    deployedOn: toDeployedOn(row.deployment_host, row.deployment_label),
    // Non-null because the SQL joins an ok risk_scores row, whose shape CHECK
    // requires these fields on the ok arm.
    safetyScore: Number(row.safety_score),
    computedAt: row.computed_at.toISOString(),
    methodologyVersion: row.methodology_version,
    factors: row.factors,
    operationalState: row.operational_state,
    lastRunAt: toIso(row.last_run_at),
    lastRunStatus: row.last_run_status,
  };
}

/** A `protocols` row joined with its run-freshness timestamps, as pg returns it. */
export interface RunHealthRow {
  id: string;
  last_successful_run_at: Date | null;
  last_run_at: Date | null;
  last_run_status: 'ok' | 'failed' | null;
}

/**
 * One run-health row → one `RunHealthEntry`.
 *
 * Timestamps only, and deliberately no derived staleness. How old "too old" is
 * belongs to the request that asks, not to the row: it is a function of the
 * clock at read time and of a configurable threshold, and storing or
 * precomputing it would bake a decision into data that is only true for one
 * instant. See dashboard/app/api/_health.ts for the policy that consumes this.
 */
export function toRunHealthEntry(row: RunHealthRow): RunHealthEntry {
  return {
    id: row.id,
    lastSuccessfulRunAt: toIso(row.last_successful_run_at),
    lastRunAt: toIso(row.last_run_at),
    lastRunStatus: row.last_run_status,
  };
}

/**
 * The staleness join: the newest run of ANY status, per protocol.
 *
 * Extracted because it is the same join in every query that reports
 * `lastRunAt` / `lastRunStatus` — the leaderboard, the current-state export, the
 * detail row and the health probe. It was previously written out four times, and
 * four copies of the staleness model is four places to change when it moves and
 * three places to forget. The whole point of the pair is that a stale score
 * stays visible while a newer failure is reported beside it; a copy that drifts
 * doesn't announce itself, it just quietly reports a different freshness than
 * the route next to it.
 *
 * LEFT, always: a protocol with no runs at all still has to come back, with null
 * timestamps meaning "never run". An inner join here would silently drop a
 * newly-registered protocol from the board.
 *
 * Assumes the enclosing query aliases `protocols` as `p`, and exposes the join
 * as `latest`.
 */
const LATEST_RUN_LATERAL = `LEFT JOIN LATERAL (
             SELECT run_at, status
               FROM risk_scores
              WHERE protocol_id = p.id
              ORDER BY run_at DESC
              LIMIT 1
           ) latest ON true`;

/**
 * The current-score join: the newest SUCCESSFUL run, per protocol.
 *
 * The other half of the pair above, and extracted for the same reason — the
 * `status = 'ok' ORDER BY run_at DESC LIMIT 1` predicate is what "current score"
 * MEANS here, and it was written out four times. What legitimately varies per
 * caller is only which columns that row is asked for, so that is the parameter;
 * the predicate is not.
 *
 * `join` is the one other axis, and it is `'JOIN'` in exactly one place. The
 * export is a scored snapshot, so a protocol with no successful run has no
 * current score to export and is excluded by the join itself rather than
 * filtered out afterwards. Everywhere else the join is LEFT, because a
 * never-scored protocol is a row the caller still needs — as `safetyScore: null`
 * on the board, or as a 200 with an empty history on the detail route.
 *
 * `projection` is a SQL fragment, never caller input: every call site below
 * passes a hardcoded column list. Assumes `protocols` is aliased `p`, and
 * exposes the join as `ok`.
 */
function latestOkScoreLateral(
  projection: string,
  join: 'LEFT JOIN' | 'JOIN' = 'LEFT JOIN',
): string {
  return `${join} LATERAL (
             SELECT ${projection}
               FROM risk_scores
              WHERE protocol_id = p.id AND status = 'ok'
              ORDER BY run_at DESC
              LIMIT 1
           ) ok ON true`;
}

export function createStore(pool: Pool): Store {
  return {
    async upsertProtocol(metadata) {
      // The identity columns are OVERWRITTEN on every cycle, like name/chain.
      // The adapter is the single source of truth for them, so a value edited
      // directly in the database is reverted within one indexer cycle (~5 min).
      //
      // That is the intended behaviour today — logos and links are
      // maintainer-managed, reviewed in a PR alongside the adapter — and it is
      // also the thing to know if protocol self-service ever ships: a
      // protocol-supplied mark MUST land in separate columns that take
      // precedence at read time, never as an edit to these. Widening this
      // statement to a COALESCE that preserves an existing value would be the
      // wrong fix: it would silently make the adapter unable to correct its own
      // metadata, which is exactly backwards for the case that matters (a
      // protocol supplying a mark that flatters, next to a score it dislikes).
      // See ProtocolMetadata.logo and CONTRIBUTING.md.
      await pool.query(
        `INSERT INTO protocols
           (id, name, chain, category, adapter, logo, contract_id, site_url, docs_url,
            deployment_host, deployment_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               chain = EXCLUDED.chain,
               category = EXCLUDED.category,
               adapter = EXCLUDED.adapter,
               logo = EXCLUDED.logo,
               contract_id = EXCLUDED.contract_id,
               site_url = EXCLUDED.site_url,
               docs_url = EXCLUDED.docs_url,
               deployment_host = EXCLUDED.deployment_host,
               deployment_label = EXCLUDED.deployment_label,
               updated_at = now()`,
        [
          metadata.id,
          metadata.name,
          metadata.chain,
          // Overwritten every cycle like every other identity column. A category
          // corrected in the adapter propagates within one cycle; a value edited
          // directly in the database is reverted by the next one.
          metadata.category,
          metadata.adapterRef,
          // `?? null` because these are optional on ProtocolMetadata: pg would
          // send `undefined` as NULL anyway, but being explicit keeps "the
          // adapter didn't set this" and "the column is NULL" the same thing.
          metadata.logo ?? null,
          metadata.contractId ?? null,
          metadata.links?.site ?? null,
          metadata.links?.docs ?? null,
          // Overwritten like every other identity column, including back to NULL:
          // if a market is ever migrated off a host protocol's contracts, the
          // adapter dropping `deployedOn` must clear the claim rather than leave
          // a stale one standing. That is the same reason this statement doesn't
          // COALESCE anything.
          metadata.deployedOn?.host ?? null,
          metadata.deployedOn?.label ?? null,
        ],
      );
    },

    async insertRunRecord(record) {
      // Map the discriminated union to the nullable columns the CHECK expects.
      // factors is passed as a JSON string and cast to jsonb ($4::jsonb) so the
      // parameter type is unambiguous regardless of pg's object coercion.
      const values =
        record.status === 'ok'
          ? [
              record.protocolId,
              'ok',
              record.safetyScore,
              JSON.stringify(record.factors),
              null,
              record.computedAt,
              record.runAt,
              record.methodologyVersion,
              // Same treatment as `factors`: serialized here and cast to jsonb
              // in the statement, so the parameter type is unambiguous.
              JSON.stringify(record.operationalState),
              record.category,
            ]
          : [
              record.protocolId,
              'failed',
              null,
              null,
              record.error,
              null,
              record.runAt,
              null,
              // A failed run read nothing, so it knows nothing about the
              // market's state. NULL, never a fabricated `active`.
              null,
              // Explicit NULL, not an omission: a failed run scored nothing, so
              // no rulebook produced it. Writing this rather than letting
              // migration 0008's DEFAULT fill it in is the precondition for
              // tightening risk_scores_category_shape to the full union later —
              // the same sequence 0002 -> 0004 followed for methodology_version.
              null,
            ];

      await pool.query(
        `INSERT INTO risk_scores
           (protocol_id, status, safety_score, factors, error, computed_at, run_at,
            methodology_version, operational_state, category)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10)`,
        values,
      );
    },

    async listProtocolsWithLatestScore() {
      // Two LATERAL subqueries per protocol, each an index-only walk of
      // (protocol_id, run_at DESC): `ok` is the latest successful score shown on
      // the board, `latest` is the newest run of any status for the staleness
      // flag. Rank by score desc, never-scored protocols (null score) last.
      const { rows } = await pool.query<LeaderboardRow>(
        `SELECT p.id, p.name, p.chain, p.category, p.logo,
                p.deployment_host, p.deployment_label,
                ok.safety_score, ok.computed_at, ok.operational_state,
                latest.run_at AS last_run_at, latest.status AS last_run_status
           FROM protocols p
           ${latestOkScoreLateral('safety_score, computed_at, operational_state')}
           ${LATEST_RUN_LATERAL}
          ORDER BY ok.safety_score DESC NULLS LAST, p.id`,
      );

      return rows.map(toLeaderboardEntry);
    },

    async listCurrentScoredRegistryState() {
      // Same latest-successful-score + latest-run semantics as the leaderboard,
      // but the ok side is an INNER LATERAL join because this export is a scored
      // snapshot: a protocol with no successful run has no current score or
      // factor map to export. This is one query, with no per-row detail fetches.
      const { rows } = await pool.query<CurrentRegistryExportRow>(
        `SELECT p.id, p.name, p.chain, p.category, p.logo,
                p.deployment_host, p.deployment_label,
                ok.safety_score, ok.computed_at, ok.methodology_version,
                ok.factors, ok.operational_state,
                latest.run_at AS last_run_at, latest.status AS last_run_status
           FROM protocols p
           ${latestOkScoreLateral(
             'safety_score, computed_at, methodology_version, factors, operational_state',
             'JOIN',
           )}
           ${LATEST_RUN_LATERAL}
          ORDER BY ok.safety_score DESC, p.id`,
      );

      return rows.map(toCurrentRegistryExportEntry);
    },

    async getProtocolDetail(id) {
      // Protocol row + latest-ok score/factors + newest-run staleness fields, in
      // one query. No row → unknown id → null (the API turns this into a 404).
      const { rows } = await pool.query<ProtocolDetailRow>(
        `SELECT p.id, p.name, p.chain, p.category, p.adapter,
                p.logo, p.contract_id, p.site_url, p.docs_url,
                p.deployment_host, p.deployment_label,
                ok.safety_score, ok.computed_at, ok.factors, ok.operational_state,
                ok.methodology_version,
                latest.run_at AS last_run_at, latest.status AS last_run_status
           FROM protocols p
           ${latestOkScoreLateral(
             'safety_score, computed_at, factors, operational_state, methodology_version',
           )}
           ${LATEST_RUN_LATERAL}
          WHERE p.id = $1`,
        [id],
      );

      const row = rows[0];
      if (!row) return null;

      const { rows: historyRows } = await pool.query<HistoryRow>(
        // `factors` is selected here rather than fetched per row on demand: the
        // breakdown is rendered from the same response the list already costs,
        // never from 50 follow-up requests. It is the only wide column in this
        // query, and the LIMIT is what keeps that bounded.
        `SELECT status, safety_score, error, factors, computed_at, run_at, methodology_version
           FROM risk_scores
          WHERE protocol_id = $1
          ORDER BY run_at DESC
          LIMIT $2`,
        [id, DETAIL_HISTORY_LIMIT],
      );

      return toProtocolDetail(row, historyRows);
    },

    async listRecentRuns(protocolId, limit) {
      // Same (protocol_id, run_at DESC) index the LATERAL joins above walk, with
      // a small LIMIT — this runs once per protocol per cycle, so it has to stay
      // an index walk rather than anything that touches the whole partition.
      const { rows } = await pool.query<{
        status: 'ok' | 'failed';
        error: string | null;
        run_at: Date;
      }>(
        `SELECT status, error, run_at
           FROM risk_scores
          WHERE protocol_id = $1
          ORDER BY run_at DESC
          LIMIT $2`,
        [protocolId, limit],
      );

      return rows.map((row) => ({
        status: row.status,
        error: row.error,
        runAt: row.run_at.toISOString(),
      }));
    },

    async listRunHealth() {
      // The SAME two LATERAL subqueries listProtocolsWithLatestScore uses, and
      // the same index walk of (protocol_id, run_at DESC) — the `ok` side just
      // selects run_at instead of the score, because health asks *when* the last
      // good run was, not what it said. That is the entire reason this needed no
      // schema change: the row that answers it was already one column away.
      //
      // ONE QUERY, and it has to stay one. A health endpoint that fans out per
      // protocol gets slower exactly as more protocols are added, which is to say
      // it degrades in proportion to how much there is to report on — and a probe
      // that times out under load is indistinguishable from the outage it exists
      // to detect.
      //
      // Nothing score-derived is selected. No safety_score, no factors jsonb: a
      // freshness probe must not be able to fail because a score was malformed.
      const { rows } = await pool.query<RunHealthRow>(
        `SELECT p.id,
                ok.run_at AS last_successful_run_at,
                latest.run_at AS last_run_at, latest.status AS last_run_status
           FROM protocols p
           ${latestOkScoreLateral('run_at')}
           ${LATEST_RUN_LATERAL}
          ORDER BY p.id`,
      );

      return rows.map(toRunHealthEntry);
    },
  };
}
