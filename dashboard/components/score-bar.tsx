'use client';

// The registry row's score bar.
//
// It was a plain div, drawn at its final width, while the same bar on a
// protocol page (FactorCard) animated its fill. That asymmetry was the wrong
// way round: the registry is the page that claims these numbers move, and it
// was the one page where nothing did.
//
// The animation is not decoration for its own sake — a bar that grows to its
// value makes the value legible as a POSITION ON A SCALE rather than as a
// coloured stripe, and doing it per row on a stagger is what makes a list of
// three protocols read as a ranking rather than a table.
//
// `useReducedMotion` is honoured by drawing the final width immediately, not by
// removing the bar: a reader who asked for no motion gets the same information
// in the same place, just without the travel.

import { motion, useReducedMotion } from 'framer-motion';

import { bandColor, scoreBand } from '../app/lib/format';

const EASE = [0.16, 1, 0.3, 1] as const;

export function ScoreBar({
  score,
  index = 0,
  className,
}: {
  /** null renders an empty track — a protocol with no score has no fill, not a zero-width one */
  score: number | null;
  /** row position, used only to stagger the fills down the list */
  index?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const pct = Math.max(0, Math.min(100, score ?? 0));
  const band = scoreBand(score);

  return (
    <div
      aria-hidden="true"
      className={`h-1.5 w-full overflow-hidden rounded-full bg-line-soft ${className ?? ''}`}
    >
      {score !== null && (
        <motion.div
          className="h-full rounded-full"
          style={{ background: bandColor(band) }}
          initial={{ width: reduce ? `${pct}%` : 0 }}
          animate={{ width: `${pct}%` }}
          // `animate`, not `whileInView`: these rows are re-rendered by search
          // and sort, and an in-view trigger that has already fired leaves a
          // newly mounted row's bar at zero width. Same rule as RevealGroup's.
          transition={{ duration: 0.9, ease: EASE, delay: reduce ? 0 : 0.06 * index }}
        />
      )}
    </div>
  );
}
