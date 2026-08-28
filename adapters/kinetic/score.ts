// Everything derived from already-fetched raw state: the five scored factors,
// their shared helpers, and the flag reading behind the live ungraded
// `operationalState`.
//
// Pure functions of `KineticRawData` — no RPC, no clock, no instance state — so
// every rule in METHODOLOGY.md can be exercised from a fixture.

import {
  LENDING_FACTORS,
  PoolOperation,
  RiskFactorType,
  describePriceAges,
  describeWorst,
  excludedComponent,
  freshnessWindow,
  mostRestrictive,
  sizeReserves,
  toOperationalState,
  worstReserves,
} from '@stenion/core';
import type {
  ExcludedReserve,
  OperationalState,
  WorstReserves,
  RiskFactor,
  RiskFactorMap,
} from '@stenion/core';

import { OPTIMAL_UTIL } from './types.ts';
import type { KineticRawData, KineticReserveRaw } from './types.ts';

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

/** Map v from [a,b] linearly onto [0,100], clamped. Descending if a>b. */
function lerp01(v: number, a: number, b: number): number {
  if (a === b) return v >= a ? 100 : 0;
  return clamp(((v - a) / (b - a)) * 100);
}

/** First 6 chars of a contract address, for detail strings. */
const shortAsset = (a: string): string => `${a.slice(0, 6)}…`;

/**
 * Score every reserve on one sub-signal and keep the worst — and every reserve
 * tied with it. Selection and phrasing both live in core, identical to Blend.
 *
 * K2 is why this matters for more than tidiness: with USDC and PYUSD both pinned
 * at freshness 0, naming only one of them made `oracleSafety` look like it hinged
 * on a $4.00 dust reserve when a reserve thirteen times larger was equally dead.
 */
function worstBy(
  reserves: KineticReserveRaw[],
  score: (r: KineticReserveRaw) => { score: number; note: string },
): WorstReserves {
  return worstReserves(reserves.map((r) => ({ asset: r.asset, ...score(r) })));
}

/** Underlying supplied/borrowed for a reserve, in human units (asset decimals applied). */
function reserveTotals(r: KineticReserveRaw): { supplied: number; borrowed: number } {
  const denom = 10 ** r.decimals;
  return {
    supplied: Number(r.suppliedRaw) / denom,
    borrowed: Number(r.borrowedRaw) / denom,
  };
}

/** USD value of supplied liquidity for a reserve, or null if no price. */
function suppliedUsd(r: KineticReserveRaw, priceDecimals: number): number | null {
  if (!r.price) return null;
  const { supplied } = reserveTotals(r);
  const priceFloat = Number(r.price.value) / 10 ** priceDecimals;
  return supplied * priceFloat;
}

export async function computeKineticRiskFactors(raw: KineticRawData): Promise<RiskFactorMap> {
  return {
    [RiskFactorType.CollateralSafety]: collateralSafety(raw),
    [RiskFactorType.OracleSafety]: oracleSafety(raw),
    [RiskFactorType.AdminKeySafety]: adminKeySafety(raw),
    [RiskFactorType.LiquiditySafety]: liquiditySafety(raw),
    [RiskFactorType.UtilizationSafety]: utilizationSafety(raw),
  };
}

/**
 * `router.is_paused()` plus the per-reserve gating flags → the shared
 * operational state. Not scored; see METHODOLOGY.md.
 *
 * TWO LEVELS, because K2 has two. The router's global pause halts the whole
 * market, and each reserve additionally carries its own active/frozen/
 * borrowingEnabled/paused bits. A market open in USDC and halted in PYUSD is a
 * state K2 can actually be in, so both are read and `mostRestrictive` picks the
 * binding one — the same worst-reserve convention every factor uses. The
 * router's reading is placed FIRST so that when a global pause and a reserve
 * pause classify the same, the published `source` names the router, which is
 * the more informative of two true statements.
 *
 * WHAT THIS DELIBERATELY DOES NOT INCLUDE: the price oracle's own `is_paused()`
 * (captured in `oracleConfig.paused`). A paused oracle is an oracle condition,
 * and `oracleSafety` already grades the prices the pool actually runs on —
 * folding it in here would report the same fact twice, in a field whose whole
 * definition is "which operations the market refuses". It stays captured and
 * unused, as it was.
 *
 * K2 publishes no "never opened" state — there is no analogue of Blend's Setup
 * — so `neverOpened` is false on every path. That is a fact about K2, not an
 * omission.
 */
export function kineticOperationalState(raw: KineticRawData): OperationalState<'lending'> {
  const asOf = new Date(raw.fetchedAt * 1000);

  const global = toOperationalState({
    // The global pause is checked at the top of validate_supply,
    // validate_withdraw, validate_borrow, validate_repay and
    // validate_liquidation, and again in prepare_liquidation /
    // execute_liquidation / the flash-loan entry points. It stops everything,
    // withdrawals included — which is the sharpest difference between K2's
    // pause and any Blend status, and the reason this list is spelled out
    // rather than abbreviated to "all".
    blocked: raw.paused
      ? [
          PoolOperation.Supply,
          PoolOperation.Withdraw,
          PoolOperation.Borrow,
          PoolOperation.Repay,
          PoolOperation.Liquidate,
        ]
      : [],
    neverOpened: false,
    source: `router.is_paused() = ${raw.paused}`,
    // Either the pool admin or the emergency admin can pause; only the pool
    // admin can unpause (emergency.rs, audit fix M-04). Both are admins, so
    // the origin is `admin` — but the flag carries no reason, and nothing here
    // may imply one.
    origin: raw.paused ? 'admin' : 'indeterminate',
    detail: raw.paused
      ? 'the router is globally paused — every operation is halted, including ' +
        'withdrawals, repayments and liquidations, so deposited funds cannot ' +
        'leave the market while it holds'
      : 'the router is not paused',
    asOf,
  });

  const perReserve = raw.reserves.map((r) => reserveOperationalState(r, asOf));
  return mostRestrictive([global, ...perReserve]);
}

/** One reserve's flags → an operational reading. See KineticReserveFlags for the gating. */
function reserveOperationalState(r: KineticReserveRaw, asOf: Date): OperationalState<'lending'> {
  const { active, frozen, borrowingEnabled, paused } = r.flags;
  const label = shortAsset(r.asset);
  const halted = paused || !active;

  const blocked = halted
    ? [
        PoolOperation.Supply,
        PoolOperation.Withdraw,
        PoolOperation.Borrow,
        PoolOperation.Repay,
        PoolOperation.Liquidate,
      ]
    : frozen
      ? [PoolOperation.Supply, PoolOperation.Borrow]
      : borrowingEnabled
        ? []
        : [PoolOperation.Borrow];

  const detail = halted
    ? `reserve ${label} is ${paused ? 'paused' : 'inactive'} — every operation on ` +
      'it is halted, withdrawals included'
    : frozen
      ? `reserve ${label} is frozen — supplying and borrowing it are disabled; ` +
        'withdrawals and repayments still work'
      : borrowingEnabled
        ? `reserve ${label} is active with no restrictions`
        : `reserve ${label} has borrowing disabled; supplying and withdrawing still work`;

  return toOperationalState({
    blocked,
    neverOpened: false,
    source:
      `ReserveConfiguration(${label}) active=${active} frozen=${frozen} ` +
      `borrowing_enabled=${borrowingEnabled} paused=${paused}`,
    // Reserve flags are set through the router's admin surface and carry no
    // origin of their own, so nothing stronger than `admin` is claimable —
    // and only where a restriction is actually in force.
    origin: blocked.length > 0 ? 'admin' : 'indeterminate',
    detail,
    asOf,
  });
}

// ---------------------------------------------------------------------------
// The five factors.
//
// Each reads K2-specific raw state, and each takes its weight from
// `LENDING_FACTORS` in @stenion/core rather than from a literal — the same
// declarations blend/score.ts reads, so the two adapters cannot come to weight
// the same factor differently. See core/src/weights.ts.
// ---------------------------------------------------------------------------

// Concentration of supplied value across reserves, via a normalized HHI.
// Identical formula/anchors to Blend (METHODOLOGY.md §1): HHI = Σ(share²),
// mapped 1/n → 100 (even split) and 1 → 0 (all in one asset). Pure on-chain
// supplied USD.
function collateralSafety(raw: KineticRawData): RiskFactor {
  const weight = LENDING_FACTORS.collateralSafety.weight;
  const values = raw.reserves
    .map((r) => suppliedUsd(r, raw.oraclePriceDecimals))
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

// Same rule as Blend (METHODOLOGY.md §2): a price is trustworthy only if it is
// both current and bounded against a single large move. Worst reserve for each
// sub-signal; the factor takes the binding constraint of the two.
//
// The per-protocol anchors differ because the readable parameters differ —
// K2 has no publish-interval getter, so `fresh` anchors to its price cache TTL
// (the window inside which K2 itself considers a price current) and `dead` to
// the tighter of its per-asset max_age and its global staleness threshold.
function oracleSafety(raw: KineticRawData): RiskFactor {
  const weight = LENDING_FACTORS.oracleSafety.weight;
  const { maxPriceChangeBps, priceStalenessThreshold, priceCacheTtl } = raw.oracleConfig;

  const worstFresh = worstBy(raw.reserves, (r) => {
    if (!r.price) return { score: 0, note: 'no usable oracle price' };
    const age = Math.max(0, raw.fetchedAt - r.price.timestamp);
    // Both are K2's own numbers; taking the tighter of the two is not a
    // Stenion threshold, it's the binding one of two protocol-declared limits.
    const declared = Math.min(
      r.priceConfig?.maxAge ?? priceStalenessThreshold,
      priceStalenessThreshold,
    );
    const { fresh, dead } = freshnessWindow(priceCacheTtl, declared);
    return {
      score: lerp01(age, dead, fresh),
      note: `${age}s old (fresh<${fresh}s, dead>${dead}s)`,
    };
  });

  // Binary, as for Blend — but K2's breaker fails *open* where Blend's aggregator
  // fails closed: `validate_price_change` returns Ok when there is no stored
  // baseline, so a configured bound with no `get_last_price` is inert. Both
  // conditions must hold for the bound to count as armed.
  const worstBound = worstBy(raw.reserves, (r) => {
    if (maxPriceChangeBps <= 0)
      return { score: 0, note: 'max_price_change_bps 0 — circuit breaker disabled' };
    if (!r.priceConfig) return { score: 0, note: 'asset not whitelisted on the oracle' };
    const baseline = r.priceConfig.breakerBaseline;
    if (baseline === null || baseline === 0n) {
      return { score: 0, note: 'no circuit-breaker baseline — breaker passes any price' };
    }
    return {
      score: 100,
      note: `breaker armed at ${maxPriceChangeBps}bps against a stored baseline`,
    };
  });

  const value = Math.min(worstFresh.score, worstBound.score);
  const overridden = raw.reserves.filter((r) => r.priceConfig?.manualOverrideActive);
  const sources = raw.reserves
    .map((r) => `${shortAsset(r.asset)} ${r.priceConfig?.source ?? 'unconfigured'}`)
    .join(', ');

  return {
    value: Math.round(value),
    weight,
    detail:
      worstBound.score === 0
        ? describeWorst(worstBound)
        : `${describeWorst(worstFresh)}; circuit breaker armed on all reserves`,
    components: [
      {
        id: 'priceFreshness',
        label: 'Price freshness',
        value: Math.round(worstFresh.score),
        detail: `${describeWorst(worstFresh)}; anchored to K2's own cache TTL (${priceCacheTtl}s) and staleness threshold (${priceStalenessThreshold}s)`,
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
        // K2 is the case this disclosure exists for: one oracle and one
        // batchAdapter source serve some assets seconds-fresh and leave others
        // untouched for hours. `priceFreshness` grades only the worst of them,
        // so without this a reader sees a 0 and cannot tell whether the oracle
        // is down or two specific feeds are unmaintained.
        detail: describePriceAges(
          raw.reserves.map((r) => ({
            asset: r.asset,
            feed: r.priceConfig?.feedId ?? null,
            ageSeconds: r.price ? Math.max(0, raw.fetchedAt - r.price.timestamp) : null,
          })),
          priceStalenessThreshold,
        ),
      },
      {
        id: 'deviationTightness',
        label: 'Bound tightness (not scored)',
        value: null,
        detail: `max_price_change_bps ${maxPriceChangeBps} (${maxPriceChangeBps / 100}%), global. Measured against the last price the oracle served, so unlike Blend's per-publish-interval bound this has no fixed time spacing — the two are not comparable as numbers. Reported, not graded — see METHODOLOGY.md §2. Price sources: ${sources}.${overridden.length > 0 ? ` ADMIN PRICE OVERRIDE ACTIVE on ${overridden.map((r) => shortAsset(r.asset)).join(', ')}.` : ''}`,
      },
    ],
  };
}

// Admin key posture from Horizon — identical tier table to Blend
// (METHODOLOGY.md §3): contract-governed → flagged neutral 60; single key →
// 40; N-of-M multisig → 90; minus a capped activity penalty (−3/op, ≤−30).
// K2's admin (PADMIN) is expected to be a governance contract (C…), which
// Horizon can't introspect → neutral baseline, flagged in the detail.
function adminKeySafety(raw: KineticRawData): RiskFactor {
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
  const multisig = signerCount > 1 && highThreshold > 1;
  const base = multisig ? 90 : 40;
  const activityPenalty = Math.min(30, recentOps * 3);
  const value = clamp(base - activityPenalty);
  return {
    value: Math.round(value),
    weight,
    detail: `${multisig ? 'multisig' : 'single-key'} admin (${signerCount} signer(s), high-threshold ${highThreshold}), ${recentOps} op(s) in ${activityWindowDays}d`,
  };
}

// Free liquidity as a share of supplied value (1 − utilization), worst
// reserve. Identical to Blend (METHODOLOGY.md §4): the absolute withdrawal
// cushion, distinct from utilizationSafety's proximity-to-cap.
function liquiditySafety(raw: KineticRawData): RiskFactor {
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
    // Ahead of `measured++` deliberately: a pool where the filter excludes
    // everything must fall through to the can't-assess branch below, not into
    // a separate path that could report the accumulator's seed. Same
    // placement as Blend, for the same reason.
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
  // METHODOLOGY.md §4 is a minimum over reserves with supplied > 0; over none
  // it is undefined, not 100. Same rule and same reasoning as Blend.
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

// Proximity of live utilization to K2's protocol-configured utilization stress
// line. K2 is Aave-V3-style and has NO Blend-style per-reserve `max_util` hard
// cap; its configured danger line is the interest-rate kink at
// OPTIMAL_UTILIZATION_RATE = 80%, past which borrow rates steepen sharply.
// We anchor to that (same anchoring *pattern* as Blend's max_util — the
// protocol's own on-chain utilization parameter — see METHODOLOGY.md §5):
// headroom = (0.8 − util)/0.8, worst reserve wins.
function utilizationSafety(raw: KineticRawData): RiskFactor {
  const weight = LENDING_FACTORS.utilizationSafety.weight;
  const sizing = reserveSizing(raw);
  const excluded: ExcludedReserve[] = [];
  let worst = 100;
  let worstAsset = '';
  let worstUtil = 0;
  let measured = 0;
  for (const [i, r] of raw.reserves.entries()) {
    const { supplied, borrowed } = reserveTotals(r);
    if (supplied <= 0) continue;
    const util = borrowed / supplied;
    const headroom = clamp(((OPTIMAL_UTIL - util) / OPTIMAL_UTIL) * 100);
    // Ahead of `measured++`, as in liquiditySafety.
    if (!sizing[i].scored) {
      excluded.push({ asset: r.asset, ...sizing[i], wouldHaveScored: Math.round(headroom) });
      continue;
    }
    measured++;
    if (headroom <= worst) {
      worst = headroom;
      worstAsset = r.asset;
      worstUtil = util;
    }
  }
  // Only one "nothing to measure" case here, unlike Blend: K2's cap is the
  // OPTIMAL_UTILIZATION_RATE constant (0.8), so §5's `cap > 0` filter can
  // never exclude a reserve. There is deliberately no no-configured-cap branch
  // — it would be unreachable. If K2 ever exposes a readable per-reserve
  // optimal-util (see METHODOLOGY.md §5's second caveat), this needs Blend's
  // two-branch treatment.
  const components = excludedComponent(excluded, 'utilization headroom');
  if (measured === 0) {
    return {
      value: 0,
      weight,
      detail:
        excluded.length > 0
          ? `every reserve with supplied value is below the minimum scorable size — utilization headroom cannot be assessed`
          : 'no reserve has any supplied value — utilization headroom cannot be assessed',
      ...components,
    };
  }
  return {
    value: Math.round(worst),
    weight,
    detail: `worst reserve (${worstAsset.slice(0, 6)}…) at ${(worstUtil * 100).toFixed(0)}% util vs ${(OPTIMAL_UTIL * 100).toFixed(0)}% optimal-utilization kink`,
    ...components,
  };
}

/**
 * The §4/§5 minimum-size filter, resolved for K2.
 *
 * The rule is core's, identical to Blend's. What differs is only where its
 * absolute leg is read from — and K2 declares nothing to read it from, so the
 * leg is passed null and the relative floor alone applies.
 *
 * That is a verified absence, not an unchecked one: the router's instance
 * storage and every reserve's ReserveConfiguration bitmap were read looking
 * for a minimum-exposure parameter. What K2 exposes is MINSWAP (a slippage
 * bound), FLPREMMAX, HFLIQTH/PLIQHF (health-factor lines) and a supply/borrow
 * cap pair in `data_high` — all maxima or unrelated. There is no K2 equivalent
 * of Blend's `min_collateral`. If K2 ever ships one, wire it in here; until
 * then the relative floor is the only leg protecting a small-but-real K2
 * reserve, which METHODOLOGY.md §4 flags.
 */
function reserveSizing(raw: KineticRawData) {
  return sizeReserves(
    raw.reserves.map((r) => suppliedUsd(r, raw.oraclePriceDecimals)),
    null,
  );
}
