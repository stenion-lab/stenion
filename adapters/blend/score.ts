// Everything derived from already-fetched raw state: the five scored factors,
// their shared helpers, and the pool-status mapping behind the live ungraded
// `operationalState`.
//
// Pure functions of `BlendRawData` — no RPC, no clock, no instance state — so
// every rule in METHODOLOGY.md can be exercised from a fixture.

import {
  LENDING_FACTORS,
  PoolOperation,
  RiskFactorType,
  describePriceAges,
  describeWorst,
  excludedComponent,
  freshnessWindow,
  sizeReserves,
  toOperationalState,
  worstReserves,
} from '@stenion/core';
import type {
  ExcludedReserve,
  OperationalOrigin,
  OperationalState,
  WorstReserves,
  RiskFactor,
  RiskFactorMap,
} from '@stenion/core';

import { SCALAR_7, SCALAR_12 } from './types.ts';
import type { BlendRawData, BlendReserveRaw } from './types.ts';

// ---------------------------------------------------------------------------
// Pool status -> shared operational state
//
// `PoolConfig.status` is a u32 with seven meanings, and this table is the whole
// mapping. It was built by reading the contract, not the docs: the public
// documentation names the states (Setup / Active / On-Ice / Frozen) but publishes
// no numeric mapping, and a web search returns a partial and partly wrong one.
// The two functions that define every value are in blend-contracts-v2:
//
//   pool/src/pool/status.rs   execute_set_pool_status (admin) and
//                             execute_update_pool_status (permissionless)
//   pool/src/pool/pool.rs     require_action_allowed, which is the gate itself:
//
//     if (status > 1 && (action == 4 || action == 9))       // Borrow, DeleteLiquidationAuction
//     || (status > 3 && (action == 2 || action == 0))       // SupplyCollateral, Supply
//     { panic!(InvalidPoolStatus) }
//
// RequestType numbering is from pool/src/pool/actions.rs: 0 Supply, 1 Withdraw,
// 2 SupplyCollateral, 3 WithdrawCollateral, 4 Borrow, 5 Repay, 6-8 auction fills,
// 9 DeleteLiquidationAuction.
//
// TWO THINGS THAT FALL OUT OF THAT GATE, both load-bearing here:
//
// 1. **Blend never blocks withdrawals, repayments or liquidation fills at any
//    status.** Only action 9 — *cancelling* an in-flight liquidation auction — is
//    blocked, which is a wind-down-safely posture rather than a restriction on
//    users. So no Blend status can produce `ExitDisabled`, and that is a fact
//    about Blend rather than a gap in this table. K2's pause does block exits,
//    which is exactly why the shared representation is built on which operations
//    are blocked instead of on either protocol's own vocabulary.
// 2. **Even/odd is nearly an origin signal and is not one.** 0/2/4 are settable
//    only by the admin and 1/5 only by the permissionless backstop path, but 3 is
//    settable by both (`execute_set_pool_status` accepts 0, 2, 3 and 4). Reading
//    parity as "who did this" would therefore be right six times in seven and
//    wrong on the one value where it matters most, so status 3 reports
//    `indeterminate`.
//
// Status 6 (Setup) is the pool's state at deployment, before its configuration
// is timelocked (`config.rs` requires a timelock only when `status != 6`). It
// supersedes everything: the permissionless update path panics rather than
// moving a Setup pool. Every Setup pool found in the 2026-08-22 factory survey
// (issue #65) held exactly $0.00 and is excluded by the market-size floor
// regardless — this row exists so that if one is ever pointed at, it reads as
// "never opened" rather than as a market that restricted its users.
interface BlendStatusMeaning {
  /** Blend's own name for the state, as its documentation uses it */
  name: string;
  blocked: readonly PoolOperation[];
  origin: OperationalOrigin;
  neverOpened?: true;
  /**
   * Set on the RESTRICTED states the backstop's own update path can produce (3
   * and 5), never on status 1.
   *
   * Deliberately a flag rather than `origin === 'protocol'`, which is what it
   * was first written as and which was wrong on live data: status 1 is also
   * permissionless, but it is the state the backstop sets when it is HEALTHY.
   * Deriving the note from origin appended "the backstop can set this when
   * deposits fall below the threshold" to the Blend Fixed pool's perfectly
   * ordinary Active reading — a stress explanation attached to a healthy pool.
   */
  backstopDriven?: true;
  /** what a user can still do, phrased for someone deciding whether to care */
  effect: string;
}

const BLEND_POOL_STATUS: Record<number, BlendStatusMeaning> = {
  0: {
    name: 'Admin Active',
    blocked: [],
    origin: 'admin',
    effect: 'all operations available',
  },
  1: {
    name: 'Active',
    blocked: [],
    origin: 'protocol',
    effect: 'all operations available',
  },
  2: {
    name: 'Admin On-Ice',
    blocked: [PoolOperation.Borrow],
    origin: 'admin',
    effect: 'borrowing is disabled; supplying, withdrawing and repaying still work',
  },
  3: {
    name: 'On-Ice',
    blocked: [PoolOperation.Borrow],
    origin: 'indeterminate',
    backstopDriven: true,
    effect: 'borrowing is disabled; supplying, withdrawing and repaying still work',
  },
  4: {
    name: 'Admin Frozen',
    blocked: [PoolOperation.Supply, PoolOperation.Borrow],
    origin: 'admin',
    effect: 'borrowing and supplying are disabled; withdrawals and repayments still work',
  },
  5: {
    name: 'Frozen',
    blocked: [PoolOperation.Supply, PoolOperation.Borrow],
    origin: 'protocol',
    backstopDriven: true,
    effect: 'borrowing and supplying are disabled; withdrawals and repayments still work',
  },
  6: {
    name: 'Setup',
    blocked: [PoolOperation.Supply, PoolOperation.Borrow],
    origin: 'indeterminate',
    neverOpened: true,
    effect: 'the pool has never been opened — borrowing and supplying are disabled',
  },
};

/**
 * How a RESTRICTED status could have come about, appended to the detail of the
 * two values (3 and 5) the backstop's own update path can impose.
 *
 * Not status 1: that is permissionless too, but it is what the backstop sets
 * when it is healthy, so this clause would read as a stress warning on a pool
 * with nothing wrong with it. See BlendStatusMeaning.backstopDriven.
 *
 * The update path sets 3 and 5 off two readable conditions: the pool's backstop deposits falling under
 * the required threshold, or `q4w_pct` — the share of backstop capital queued
 * for withdrawal — crossing 30%/60%/75%. Naming the mechanism is worth a clause
 * because "On-Ice" alone reads as a choice somebody made, and for these values it
 * may well not be.
 *
 * Stated as what the mechanism *can* do, not as a diagnosis of what happened:
 * this adapter does not read backstop data, so it cannot say which condition
 * fired, and pretending otherwise would be a fabricated finding.
 */
const BACKSTOP_DRIVEN =
  " Blend's backstop can impose this restriction on its own — when the pool's " +
  'backstop deposits fall below the required threshold, or when a large share of ' +
  'them is queued for withdrawal — and it can also be set deliberately. Which ' +
  'happened here is not readable from the status alone.';

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

/** Map v from [a,b] linearly onto [0,100], clamped. Descending if a>b. */
function lerp01(v: number, a: number, b: number): number {
  if (a === b) return v >= a ? 100 : 0;
  return clamp(((v - a) / (b - a)) * 100);
}

/** Underlying supplied/borrowed for a reserve, in human units (asset decimals applied). */
function reserveTotals(r: BlendReserveRaw): { supplied: number; borrowed: number } {
  const denom = Number(SCALAR_12) * 10 ** r.config.decimals;
  const supplied = Number(r.data.bSupply * r.data.bRate) / denom;
  const borrowed = Number(r.data.dSupply * r.data.dRate) / denom;
  return { supplied, borrowed };
}

/** First 6 chars of a contract address, for detail strings. */
const shortAsset = (a: string): string => `${a.slice(0, 6)}…`;

/**
 * Is the aggregator's deviation check actually active for this asset?
 *
 * Mirrors the contract's own condition in oracle-aggregator/src/price_data.rs:
 * `if config.max_dev > 0 && config.max_dev < 100`. Outside that range the check
 * is skipped entirely and the aggregator just returns the latest price, however
 * far it moved.
 */
const deviationBounded = (maxDevPercent: number): boolean =>
  maxDevPercent > 0 && maxDevPercent < 100;

/**
 * Score every reserve on one sub-signal and keep the worst — and every reserve
 * tied with it. The selection rule and the phrasing both live in core
 * (`worstReserves`/`describeWorst`) so the two adapters cannot drift into
 * describing the same situation differently.
 *
 * Blend is the clearest case for reporting ties: all reserves are priced from a
 * single aggregator publish round, so their ages are identical and they always
 * tie. Naming one of them was pure iteration order.
 */
function worstBy(
  reserves: BlendReserveRaw[],
  score: (r: BlendReserveRaw) => { score: number; note: string },
): WorstReserves {
  return worstReserves(reserves.map((r) => ({ asset: r.asset, ...score(r) })));
}

/** USD value of supplied liquidity for a reserve, or null if no price. */
function suppliedUsd(r: BlendReserveRaw, oracleDecimals: number): number | null {
  if (!r.price) return null;
  const { supplied } = reserveTotals(r);
  const priceFloat = Number(r.price.value) / 10 ** oracleDecimals;
  return supplied * priceFloat;
}

export async function computeBlendRiskFactors(raw: BlendRawData): Promise<RiskFactorMap> {
  return {
    [RiskFactorType.CollateralSafety]: collateralSafety(raw),
    [RiskFactorType.OracleSafety]: oracleSafety(raw),
    [RiskFactorType.AdminKeySafety]: adminKeySafety(raw),
    [RiskFactorType.LiquiditySafety]: liquiditySafety(raw),
    [RiskFactorType.UtilizationSafety]: utilizationSafety(raw),
  };
}

/**
 * `PoolConfig.status` → the shared operational state. Not scored; see
 * BLEND_POOL_STATUS above for the mapping and where it came from.
 *
 * Blend gates at the POOL level only — `require_action_allowed` reads
 * `self.config.status` and nothing per-reserve — so there is exactly one
 * reading here and no `mostRestrictive` reduction to do. (K2 does gate per
 * reserve, which is why that helper exists.)
 *
 * An unrecognised status is reported as unrecognised rather than guessed at.
 * Values outside 0-6 cannot be produced by the deployed contract — both setter
 * paths reject them — so reaching this branch means the pool is running code
 * this mapping was not read from, and the honest output is to say so, name the
 * number, and claim nothing about what it blocks. `blocked: []` here is not
 * "nothing is restricted": the level is unknowable, and `detail` says exactly
 * that rather than letting an empty list read as a clean bill of health.
 */
export function blendOperationalState(raw: BlendRawData): OperationalState<'lending'> {
  const asOf = new Date(raw.fetchedAt * 1000);
  const source = `PoolConfig.status = ${raw.status}`;
  const meaning = BLEND_POOL_STATUS[raw.status];

  if (!meaning) {
    return toOperationalState({
      blocked: [],
      neverOpened: false,
      source,
      origin: 'indeterminate',
      detail:
        `pool reports status ${raw.status}, which is not one of Blend V2's seven ` +
        'defined values (0-6) — what it restricts cannot be determined from the ' +
        'contract this mapping was read from, so nothing is claimed about it',
      asOf,
    });
  }

  const backstop = meaning.backstopDriven ? BACKSTOP_DRIVEN : '';
  return toOperationalState({
    blocked: meaning.blocked,
    neverOpened: meaning.neverOpened ?? false,
    source,
    origin: meaning.origin,
    detail: `pool status ${raw.status} (${meaning.name}) — ${meaning.effect}.${backstop}`,
    asOf,
  });
}

// ---------------------------------------------------------------------------
// The five factors.
//
// Each reads Blend-specific raw state, and each takes its weight from
// `LENDING_FACTORS` in @stenion/core rather than from a literal. A weight is
// part of the shared rulebook, not a per-adapter choice: with the number
// written out here and again in kinetic/score.ts, a drift between the two would
// have produced two plausible scores from two different weightings and failed
// nothing. See core/src/weights.ts.
// ---------------------------------------------------------------------------

// Concentration of supplied value across reserves, via a normalized HHI.
// Rationale: a pool whose value sits in one asset is far more exposed to a
// single de-peg/liquidation cascade than a balanced one. HHI = Σ(share²);
// for n reserves it ranges [1/n, 1]. We map 1/n → 100 (safest, even split)
// and 1 → 0 (all in one asset). Pure on-chain supplied USD, no assumptions.
function collateralSafety(raw: BlendRawData): RiskFactor {
  const weight = LENDING_FACTORS.collateralSafety.weight;
  const values = raw.reserves
    .map((r) => suppliedUsd(r, raw.oracleDecimals))
    .filter((v): v is number => v !== null && v > 0);

  if (values.length === 0) {
    return {
      value: 0,
      weight,
      detail: 'no priced supplied value available to assess concentration',
    };
  }
  const n = values.length;
  if (n === 1) {
    return { value: 0, weight, detail: 'single priced reserve — fully concentrated' };
  }
  const total = values.reduce((a, b) => a + b, 0);
  const hhi = values.reduce((acc, v) => acc + (v / total) ** 2, 0);
  const minHhi = 1 / n;
  const value = clamp(((1 - hhi) / (1 - minHhi)) * 100);
  const topShare = Math.max(...values) / total;
  return {
    value: Math.round(value),
    weight,
    detail: `top reserve holds ${(topShare * 100).toFixed(0)}% of supplied value across ${n} reserves (HHI ${hhi.toFixed(2)})`,
  };
}

// Can this pool's prices be trusted? Two things must both hold: the price is
// current, AND a single update can't move it arbitrarily far. An age-only
// oracle factor scores a fresh-but-manipulated price 100 — exactly the
// YieldBlox failure mode. See METHODOLOGY.md §2.
//
// Both sub-signals take the worst reserve, and the factor takes the binding
// constraint (the lower of the two) — a bounded stale price and a fresh
// unbounded price are both untrustworthy, for different reasons.
function oracleSafety(raw: BlendRawData): RiskFactor {
  const weight = LENDING_FACTORS.oracleSafety.weight;

  // Base assets are the aggregator's unit of account: `lastprice` returns a
  // hardcoded 1.0 at the current ledger time for them, never reading an
  // upstream feed. There is no oracle price to grade, so they are excluded
  // from both sub-signals — scoring them 0 for "no deviation bound" would be
  // measuring the absence of a mechanism that doesn't apply. (Their peg
  // holding is a real risk, but it is a collateral/peg question, not an
  // oracle-robustness one — see METHODOLOGY.md §2.)
  const baseAssets = new Set(raw.oracleConfig.baseAssets);
  const graded = raw.reserves.filter((r) => !baseAssets.has(r.asset));
  const excluded = raw.reserves.length - graded.length;
  if (graded.length === 0) {
    return {
      value: 0,
      weight,
      detail: 'every reserve is an oracle base asset — no oracle-derived price to assess',
    };
  }

  // Freshness anchors are the aggregator's own: `resolution` is how often the
  // upstream feed publishes (a price younger than that is as fresh as the feed
  // can be), `max_age` is the age at which the aggregator itself refuses the
  // price. The STALE_CEILING cap is the one unvalidated judgment call here.
  const worstFresh = worstBy(graded, (r) => {
    if (!r.price) return { score: 0, note: 'no oracle price' };
    const age = Math.max(0, raw.fetchedAt - r.price.timestamp);
    const resolution = raw.oracleConfig.oracles[r.priceConfig?.oracleIndex ?? 0]?.resolution ?? 0;
    const { fresh, dead } = freshnessWindow(resolution, raw.oracleConfig.maxAge);
    return {
      score: lerp01(age, dead, fresh),
      note: `${age}s old (fresh<${fresh}s, dead>${dead}s)`,
    };
  });

  // The deviation bound is scored as a binary: is a bound configured at all?
  // `max_dev` of 0 (or >= 100) disables the aggregator's check outright — see
  // oracle-aggregator/src/price_data.rs — which is what permits an unbounded
  // single-step move. Its *tightness* is disclosed below but deliberately not
  // graded; see METHODOLOGY.md §2 on why.
  const worstBound = worstBy(graded, (r) => {
    const dev = r.priceConfig?.maxDev;
    if (dev === undefined)
      return { score: 0, note: 'no aggregator entry — asset cannot be priced' };
    return deviationBounded(dev)
      ? {
          score: 100,
          note: `bounded at ${dev}% per ${raw.oracleConfig.oracles[r.priceConfig!.oracleIndex]?.resolution ?? '?'}s step`,
        }
      : { score: 0, note: `max_dev ${dev} — deviation check disabled` };
  });

  const value = Math.min(worstFresh.score, worstBound.score);
  const bounds = graded
    .map((r) => `${shortAsset(r.asset)} ${r.priceConfig ? `${r.priceConfig.maxDev}%` : 'n/a'}`)
    .join(', ');
  const excludedNote =
    excluded > 0 ? ` ${excluded} base asset(s) excluded — priced 1:1, not oracle-derived.` : '';

  return {
    value: Math.round(value),
    weight,
    detail:
      worstBound.score === 0
        ? describeWorst(worstBound)
        : `${describeWorst(worstFresh)}; all reserves have a deviation bound`,
    components: [
      {
        id: 'priceFreshness',
        label: 'Price freshness',
        value: Math.round(worstFresh.score),
        detail: `${describeWorst(worstFresh)}; anchored to the aggregator's own resolution and max_age (${raw.oracleConfig.maxAge}s)`,
      },
      {
        id: 'deviationBound',
        label: 'Deviation bound',
        value: Math.round(worstBound.score),
        detail: describeWorst(worstBound),
      },
      {
        id: 'priceAges',
        label: 'Price age by feed (not scored)',
        value: null,
        // Blend's reserves are priced in one aggregator round, so these ages
        // are normally identical and this disclosure is unremarkable. It is
        // published anyway, on the same rule as every protocol: the value of
        // showing per-feed ages is that a divergence becomes visible when one
        // appears, and a disclosure that only exists where we already expect
        // trouble is one nobody can check against a healthy baseline.
        detail: describePriceAges(
          graded.map((r) => ({
            asset: r.asset,
            feed: r.priceConfig?.upstreamAsset ?? null,
            ageSeconds: r.price ? Math.max(0, raw.fetchedAt - r.price.timestamp) : null,
          })),
          raw.oracleConfig.maxAge,
        ),
      },
      {
        id: 'deviationTightness',
        label: 'Bound tightness (not scored)',
        value: null,
        detail: `per-reserve max_dev: ${bounds}.${excludedNote} Measured against the previous upstream record, so this bounds movement per publish interval. Reported, not graded — see METHODOLOGY.md §2.`,
      },
    ],
  };
}

// Admin key posture from Horizon. A single hot key that can reconfigure the
// pool is the sharpest centralization risk; multisig/high-threshold is safer.
// Recent admin-account activity ("AdminKeyActivity") lowers safety further —
// an actively-used admin key is a live lever. Contract-governed admins can't
// be introspected via Horizon, so they get a flagged neutral baseline.
function adminKeySafety(raw: BlendRawData): RiskFactor {
  const weight = LENDING_FACTORS.adminKeySafety.weight;
  const a = raw.admin;

  if (a.isContract || a.account === null) {
    return {
      value: 60,
      weight,
      detail: `admin is a contract (${a.address.slice(0, 6)}…) — not introspectable via Horizon; neutral baseline`,
    };
  }

  const { highThreshold, signerCount, recentOps, activityWindowDays } = a.account;
  // Structure: multisig (>1 signer AND high threshold >1) is materially safer
  // than a lone master key.
  const multisig = signerCount > 1 && highThreshold > 1;
  const base = multisig ? 90 : 40;
  // Activity: each recent op shaves safety, capped so structure still dominates.
  const activityPenalty = Math.min(30, recentOps * 3);
  const value = clamp(base - activityPenalty);
  return {
    value: Math.round(value),
    weight,
    detail: `${multisig ? 'multisig' : 'single-key'} admin (${signerCount} signer(s), high-threshold ${highThreshold}), ${recentOps} op(s) in ${activityWindowDays}d`,
  };
}

// Free liquidity as a share of supplied value (1 − utilization), worst reserve.
// This is the withdrawal/liquidation cushion: how much can leave before the
// pool is drained. Distinct from utilizationSpike below, which measures
// proximity to the *protocol-configured* cap rather than absolute headroom.
//
// Reserves below the shared minimum size are excluded before selection — see
// reserveSizing() and METHODOLOGY.md §4 — and disclosed rather than dropped.
function liquiditySafety(raw: BlendRawData): RiskFactor {
  const weight = LENDING_FACTORS.liquiditySafety.weight;
  const sizing = reserveSizing(raw);
  const excluded: ExcludedReserve[] = [];
  let worstRatio = 1;
  let worstAsset = '';
  let measured = 0;
  for (const [i, r] of raw.reserves.entries()) {
    const { supplied, borrowed } = reserveTotals(r);
    if (supplied <= 0) continue;
    const free = clamp(((supplied - borrowed) / supplied) * 100);
    // The size filter sits AHEAD of `measured++` on purpose: a pool where it
    // excludes everything then falls through to the can't-assess branch below
    // rather than reaching a separate path that could report the seed value.
    if (!sizing[i].scored) {
      excluded.push({ asset: r.asset, ...sizing[i], wouldHaveScored: Math.round(free) });
      continue;
    }
    measured++;
    if (free <= worstRatio * 100) {
      worstRatio = free / 100;
      worstAsset = r.asset;
    }
  }
  const components = excludedComponent(excluded, 'free liquidity');
  // METHODOLOGY.md §4 is a minimum over the reserves with supplied > 0. With
  // none, that minimum is undefined — NOT 100. Reporting the accumulator's
  // seed here would publish "maximally safe" derived from no data at all,
  // which ground rule 4 forbids; 0 (can't assess) matches collateralSafety's
  // treatment of the same situation.
  if (measured === 0) {
    return {
      value: 0,
      weight,
      detail:
        excluded.length > 0
          ? `every reserve with supplied value is below the minimum scorable size — free liquidity cannot be assessed`
          : 'no reserve has any supplied value — free liquidity cannot be assessed',
      ...components,
    };
  }
  return {
    value: Math.round(worstRatio * 100),
    weight,
    detail: `worst reserve (${worstAsset.slice(0, 6)}…) has ${(worstRatio * 100).toFixed(0)}% of supply as free liquidity`,
    ...components,
  };
}

// Proximity of live utilization to the reserve's configured max_util cap.
// Blend throttles/pauses borrowing as utilization nears max_util, so nearing
// it is a concrete stress signal. headroom = (max_util − util)/max_util,
// worst reserve wins. util here is computed live (borrowed/supplied), not the
// config's target field.
function utilizationSafety(raw: BlendRawData): RiskFactor {
  const weight = LENDING_FACTORS.utilizationSafety.weight;
  const sizing = reserveSizing(raw);
  const excluded: ExcludedReserve[] = [];
  let worst = 100;
  let worstAsset = '';
  let worstUtil = 0;
  let worstCap = 0;
  // Two independent reasons a reserve is skipped, counted separately so the
  // "nothing to measure" case can say which one applied. They are genuinely
  // different findings: an empty pool is not the same problem as a pool whose
  // reserves hold real debt but declare no utilization ceiling.
  let withSupply = 0;
  let withCap = 0;
  for (const [i, r] of raw.reserves.entries()) {
    const { supplied, borrowed } = reserveTotals(r);
    if (supplied <= 0) continue;
    const util = borrowed / supplied;
    const cap = Number(r.config.maxUtil) / Number(SCALAR_7);
    // Ahead of `withSupply++` for the same reason as in liquiditySafety, and
    // so the no-cap message counts reserves this factor would actually have
    // scored rather than ones it had already set aside as too small.
    if (!sizing[i].scored) {
      excluded.push({
        asset: r.asset,
        ...sizing[i],
        wouldHaveScored: cap > 0 ? Math.round(clamp(((cap - util) / cap) * 100)) : null,
      });
      continue;
    }
    withSupply++;
    if (cap <= 0) continue;
    withCap++;
    const headroom = clamp(((cap - util) / cap) * 100);
    if (headroom <= worst) {
      worst = headroom;
      worstAsset = r.asset;
      worstUtil = util;
      worstCap = cap;
    }
  }
  const components = excludedComponent(excluded, 'utilization headroom');
  // METHODOLOGY.md §5 is a minimum over reserves with supplied > 0 AND
  // cap > 0. With none, that minimum is undefined — not the seed value of
  // 100. See the note in liquiditySafety.
  if (withCap === 0) {
    let detail: string;
    if (withSupply > 0) {
      detail = `no reserve has a configured utilization cap (max_util) — headroom cannot be assessed across ${withSupply} supplied reserve(s)`;
    } else if (excluded.length > 0) {
      detail = `every reserve with supplied value is below the minimum scorable size — utilization headroom cannot be assessed`;
    } else {
      detail = 'no reserve has any supplied value — utilization headroom cannot be assessed';
    }
    return { value: 0, weight, detail, ...components };
  }
  return {
    value: Math.round(worst),
    weight,
    detail: `worst reserve (${worstAsset.slice(0, 6)}…) at ${(worstUtil * 100).toFixed(0)}% util vs ${(worstCap * 100).toFixed(0)}% cap`,
    ...components,
  };
}

/**
 * The §4/§5 minimum-size filter, resolved for this pool.
 *
 * The rule is shared (core's `sizeReserves`); what is per-protocol is only
 * where its absolute leg is read from — Blend's own `min_collateral`, divided
 * out of the oracle's base-asset decimals into USD. Exactly the anchoring
 * pattern §5's `cap` uses.
 */
function reserveSizing(raw: BlendRawData) {
  const minPositionUsd =
    raw.minCollateral > 0n ? Number(raw.minCollateral) / 10 ** raw.oracleDecimals : null;
  return sizeReserves(
    raw.reserves.map((r) => suppliedUsd(r, raw.oracleDecimals)),
    minPositionUsd,
  );
}
