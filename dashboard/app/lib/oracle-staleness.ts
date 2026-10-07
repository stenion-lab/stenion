import type { HistoryEntry, RiskFactorComponent } from './contract';

export interface OracleStalenessSummary {
  /** Total runs with a valid factor breakdown in the historical set */
  assessedRuns: number;
  /** Number of runs where the oracle was detected as stale (score < 50 or priceFreshness < 50) */
  staleRuns: number;
  /** Percentage of observed runs where the oracle was stale (0–100) */
  stalePercentage: number;
  /** Total runs evaluated in history */
  totalRuns: number;
}

/**
 * Derives oracle staleness metrics across historical runs.
 *
 * Reuses the canonical oracleSafety factor from each historical run:
 * A run's oracle is considered stale when:
 * 1. An 'ok' run evaluates oracleSafety with a value < 50, OR
 * 2. The priceFreshness component sub-score is < 50.
 *
 * Runs that don't assess oracleSafety (e.g. Dex protocols without an oracle) are safely excluded.
 */
export function calculateOracleStaleness(history: HistoryEntry[]): OracleStalenessSummary {
  let assessedRuns = 0;
  let staleRuns = 0;
  for (const entry of history) {
    if (entry.status !== 'ok') continue;

    const oracleFactor = entry.factors?.oracleSafety;
    if (!oracleFactor) continue;

    assessedRuns += 1;

    // Check if the priceFreshness component sub-score or overall factor score is degraded (< 50)
    const freshnessComp = oracleFactor.components?.find(
      (c: RiskFactorComponent) => c.id === 'priceFreshness',
    );
    const isFreshnessStale =
      freshnessComp && freshnessComp.value !== null ? freshnessComp.value < 50 : false;
    const isOverallFactorStale = oracleFactor.value < 50;

    if (isFreshnessStale || isOverallFactorStale) {
      staleRuns += 1;
    }
  }

  const stalePercentage = assessedRuns > 0 ? Math.round((staleRuns / assessedRuns) * 100) : 0;

  return {
    assessedRuns,
    staleRuns,
    stalePercentage,
    totalRuns: history.length,
  };
}
