'use client';

import { ActivitySquare, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { HistoryEntry } from '../app/lib/contract';
import { calculateOracleStaleness } from '../app/lib/oracle-staleness';
import { cn } from '../app/lib/cn';

export interface OracleStalenessViewProps {
  history: HistoryEntry[];
  className?: string;
}

/**
 * Historical oracle-staleness view.
 *
 * Displays how often a protocol's oracle feeds have been stale over the
 * observed run history (percentage of runs stale, stale vs assessed counts,
 * and a status tone indicating frequency of stale periods).
 *
 * Visually distinct from the current-state status pill / badge:
 * this component represents the historical aggregate behavior over time.
 */
export function OracleStalenessView({ history, className }: OracleStalenessViewProps) {
  const summary = calculateOracleStaleness(history);

  // If no runs assessed oracle safety (e.g. Dex without oracle, or zero history), omit component cleanly
  if (summary.assessedRuns === 0) {
    return null;
  }

  const { assessedRuns, staleRuns, stalePercentage } = summary;

  // Stale frequency severity thresholds
  const isHighStale = stalePercentage >= 50;
  const isModerateStale = stalePercentage > 0 && stalePercentage < 50;
  const isClean = stalePercentage === 0;

  return (
    <div
      className={cn(
        'mt-4 rounded-xl border border-line surface-lit p-4 transition-colors',
        isHighStale && 'border-warn/40 bg-warn/5',
        className,
      )}
      aria-label={`Historical oracle staleness: ${stalePercentage}% of runs stale`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {isHighStale ? (
            <AlertTriangle className="h-4 w-4 text-warn" aria-hidden="true" />
          ) : isModerateStale ? (
            <ActivitySquare className="h-4 w-4 text-accent" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-safe" aria-hidden="true" />
          )}
          <span className="font-medium text-sm text-ink">Historical oracle staleness</span>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              'score-num font-semibold text-sm',
              isHighStale ? 'text-warn' : isModerateStale ? 'text-accent' : 'text-safe',
            )}
          >
            {stalePercentage}% stale
          </span>
          <span className="text-xs text-muted">
            ({staleRuns} of {assessedRuns} observed runs)
          </span>
        </div>
      </div>

      <div className="mt-3">
        {/* Visual progress bar representing the proportion of historical runs stale */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              isHighStale ? 'bg-warn' : isModerateStale ? 'bg-accent' : 'bg-safe',
            )}
            style={{ width: `${Math.max(4, stalePercentage)}%` }}
            role="progressbar"
            aria-valuenow={stalePercentage}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Oracle staleness percentage"
          />
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-faint">
        {isClean
          ? 'Oracle prices remained fresh across all evaluated historical runs.'
          : isHighStale
            ? `Oracle prices were stale in ${staleRuns} of the last ${assessedRuns} runs (${stalePercentage}% of time). Persistent staleness indicates feed refresh gaps or unaligned TTLs.`
            : `Oracle prices experienced intermittent staleness in ${staleRuns} of ${assessedRuns} runs (${stalePercentage}%).`}
      </p>
    </div>
  );
}
