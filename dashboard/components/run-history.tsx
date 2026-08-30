'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';

import type { HistoryEntry } from '../app/lib/contract';
import { formatTimestamp } from '../app/lib/format';
import { FactorBreakdown } from './factor-breakdown';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The last 50 runs, newest first, each `ok` row expandable to the factor
 * breakdown that run computed.
 *
 * WHY THE BREAKDOWN IS HERE AT ALL. The page already shows the CURRENT score's
 * factors, so the run list could only say a score moved, never which factor
 * moved it. The breakdowns were always stored — `risk_scores.factors` — they
 * were just not returned. They are returned on the history rows now, and this
 * renders them. It is the same `FactorBreakdown` the current score uses, on that run's
 * own map: nothing here recomputes or re-grades anything.
 *
 * PER-ROW STATE, NOT AN ACCORDION. Expanding one row must not collapse another
 * — the entire reason to open two is to compare them, and an accordion makes
 * the one comparison this list is for impossible. So the open set is a Set of
 * indices, not a single index.
 *
 * COLLAPSED BY DEFAULT. Fifty expanded breakdowns is not a list any more, and
 * the row's own line (time, status, score) is what the list is scanned for.
 *
 * WHY THIS IS A CLIENT COMPONENT while the rest of the page is not: the open
 * set is interaction state. It takes `HistoryEntry[]` — plain JSON off the
 * Store — so the server component above it stays a server component.
 */
export function RunHistory({ history }: { history: HistoryEntry[] }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const reduce = useReducedMotion();

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <ul className="divide-y divide-line-soft">
      {history.map((h, i) => {
        // History is newest-first, so the row *after* this one is older. When
        // its methodology version is lower, the rules changed between them —
        // mark it, so a step in the score doesn't read as a move in risk.
        const older = history[i + 1];
        const breakAfter =
          h.status === 'ok' &&
          older?.status === 'ok' &&
          older.methodologyVersion < h.methodologyVersion;

        // A failed run has no factors — not an empty map, no key at all — so
        // there is nothing to expand and no control to offer. See the history
        // union in lib/contract.
        const expandable = h.status === 'ok';
        const isOpen = expandable && open.has(i);
        const panelId = `run-${i}-factors`;

        const summary = (
          <div className="flex items-center gap-3 px-4 py-3 text-sm">
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${
                h.status === 'ok' ? 'bg-safe' : 'bg-danger'
              }`}
            />
            <span className="tnum w-40 shrink-0 text-muted">{formatTimestamp(h.runAt)}</span>
            {h.status === 'ok' ? (
              <span className="text-ink">
                scored <span className="score-num font-semibold">{h.safetyScore}</span>
              </span>
            ) : (
              <span className="truncate text-danger">failed — {h.error}</span>
            )}
            {expandable && (
              // Rotated by framer-motion rather than a conditional `rotate-90`
              // class, for the same reason the panel below is: it is the same
              // open/close transition and it should run on the same curve and
              // duration. It also keeps the rotation off Tailwind's JIT — a
              // utility that appears nowhere else in the app is one the
              // scanner has to find in a template literal to emit at all.
              <motion.span
                aria-hidden="true"
                className="ml-auto shrink-0 text-faint"
                animate={{ rotate: isOpen ? 90 : 0 }}
                initial={false}
                transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
              >
                <ChevronRight className="h-4 w-4" />
              </motion.span>
            )}
          </div>
        );

        return (
          <li key={i}>
            {expandable ? (
              // The whole row is the trigger, not just the chevron: the chevron
              // is a 16px target on a full-width row, and the row carries no
              // other interactive content to compete with the click.
              <button
                type="button"
                onClick={() => toggle(i)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                aria-label={`Run on ${formatTimestamp(h.runAt)}: scored ${
                  h.safetyScore
                } out of 100. ${isOpen ? 'Hide' : 'Show'} the factor breakdown for this run`}
                // `cursor-pointer` explicitly: Tailwind v4's preflight sets
                // `cursor: default` on <button>, so a row that is plainly
                // clickable does not look it without this. Same reason
                // code-block.tsx carries it.
                className="w-full cursor-pointer bg-surface/40 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                {summary}
              </button>
            ) : (
              <div
                className="bg-surface/40"
                aria-label={`Run on ${formatTimestamp(h.runAt)}: failed with error ${
                  h.status === 'failed' ? h.error : ''
                }`}
              >
                {summary}
              </div>
            )}

            <AnimatePresence initial={false}>
              {isOpen && h.status === 'ok' && (
                <motion.div
                  id={panelId}
                  key="panel"
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: EASE }}
                  className="overflow-hidden border-t border-line-soft bg-surface-2/30"
                >
                  <div className="px-4 py-4">
                    <p className="mb-3 text-xs text-faint">
                      The breakdown this run computed, under methodology v{h.methodologyVersion}.
                      Not a re-score — these are the numbers stored at{' '}
                      {formatTimestamp(h.computedAt)}.
                    </p>
                    {/* `trigger="mount"`: this subtree appears from a click,
                        long after any in-view observer would have fired and
                        stopped. See FactorBreakdown's note on the prop. */}
                    <FactorBreakdown factors={h.factors} trigger="mount" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {breakAfter && (
              <div className="border-t border-dashed border-line bg-surface-2/60 px-4 py-2.5 text-xs leading-relaxed text-faint">
                <span className="font-medium text-muted">
                  Methodology v{(older as { methodologyVersion: number }).methodologyVersion} → v
                  {(h as { methodologyVersion: number }).methodologyVersion}.
                </span>{' '}
                Scoring rules changed here, so scores above and below this line are not comparable.
                Earlier runs cannot be recomputed — only scores are stored, not the on-chain inputs
                behind them.{' '}
                <Link
                  href="/methodology"
                  className="rounded-sm underline hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  What changed
                </Link>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
