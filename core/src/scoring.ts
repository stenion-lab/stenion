/**
 * Shared rulebook pieces that must not differ between adapters.
 *
 * METHODOLOGY.md ground rule 1 is that a factor's formula and thresholds are
 * identical for every protocol; only *where the raw inputs are read* differs per
 * adapter. Anything in this file is a piece of that shared formula, kept in one
 * place so two adapters can't quietly drift apart. Per-protocol input reading
 * stays in the adapters — this file never reaches for chain data.
 */

import type { RiskFactorMap, RiskScoreResult } from './types';

/**
 * The overall score: a weighted mean of the five factors, renormalized over
 * whichever are non-null.
 *
 * This is METHODOLOGY.md's "Score model" formula and it is emphatically **not**
 * per-protocol — ground rule 1 is that one rulebook applies to every adapter.
 * It lives here, and adapters call it, so two protocols cannot drift onto two
 * different weighted means. Do not reimplement it in an adapter.
 *
 * Renormalizing by the *observed* total weight (rather than dividing by a fixed
 * 1.0) is what makes a null factor genuinely excluded: a protocol for which one
 * factor doesn't apply is graded on the factors that do apply, instead of being
 * dragged toward zero by a missing one.
 *
 * No non-null factors at all → 0, not NaN: with nothing measured we report the
 * unsafe end rather than a division by zero, matching how the individual
 * factors treat "can't assess" (METHODOLOGY.md §1).
 */
export function scoreFactors(factors: RiskFactorMap): RiskScoreResult {
  let weighted = 0;
  let totalWeight = 0;
  for (const factor of Object.values(factors)) {
    if (!factor) continue;
    weighted += factor.value * factor.weight;
    totalWeight += factor.weight;
  }
  const score = totalWeight === 0 ? 0 : Math.round(weighted / totalWeight);
  return { score, factors, computedAt: new Date() };
}

/**
 * Upper bound on the "price is effectively dead" threshold, in seconds.
 *
 * `oracleSafety` anchors freshness to each protocol's own configured max price
 * age (see `freshnessWindow`). That anchoring is deliberately *capped* rather
 * than taken at face value: a protocol that configures a very loose max age —
 * K2's per-asset value is 43200s (12 hours) — would otherwise score better for
 * tolerating staler prices, which is the wrong incentive for a platform
 * protocols are ranked by.
 *
 * The cap is an **unvalidated v1 judgment call**, retained deliberately and
 * flagged as such in METHODOLOGY.md §2. There is no external framework fixing
 * it at one hour; it is the one Stenion-chosen constant left in this factor.
 */
export const STALE_CEILING_SECONDS = 3600;

/**
 * The freshness grading window for one reserve.
 *
 * - `fresh`: the protocol's own publish/refresh interval. A price younger than
 *   one interval is as current as that feed can be, so it scores 100.
 * - `dead`: the protocol's own declared max acceptable price age, capped at
 *   `STALE_CEILING_SECONDS`.
 *
 * Both inputs are the protocol's own on-chain parameters, the same anchoring
 * pattern `utilizationSafety` uses. Which parameter each resolves to is a
 * documented per-protocol fact (METHODOLOGY.md §2), not a per-protocol rule.
 *
 * Degenerate configs are handled rather than trusted: a missing or nonsensical
 * value collapses to a window that still orders newer prices above older ones.
 */
export function freshnessWindow(
  resolutionSeconds: number,
  protocolMaxAgeSeconds: number,
): { fresh: number; dead: number } {
  const fresh = Number.isFinite(resolutionSeconds) && resolutionSeconds > 0 ? resolutionSeconds : 0;
  const declared =
    Number.isFinite(protocolMaxAgeSeconds) && protocolMaxAgeSeconds > 0
      ? protocolMaxAgeSeconds
      : STALE_CEILING_SECONDS;
  const dead = Math.min(declared, STALE_CEILING_SECONDS);
  // A feed whose publish interval is at or beyond its own staleness limit gives
  // no usable range; widen by one interval so the score still degrades with age
  // instead of collapsing to a step function.
  return dead > fresh ? { fresh, dead } : { fresh, dead: fresh + Math.max(1, fresh) };
}
