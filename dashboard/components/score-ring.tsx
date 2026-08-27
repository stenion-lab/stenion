'use client';

import { animate, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { cn } from '../app/lib/cn';
import { bandColor, scoreBand } from '../app/lib/format';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Viewport trigger, matching `Reveal`'s exactly (see components/reveal.tsx) so a
 * card's fade-in and its ring's sweep are driven by the same threshold and fire
 * together rather than a beat apart.
 */
const VIEWPORT = { once: true, margin: '-60px' } as const;

/**
 * The product's hero number, rendered as a radial gauge that visibly "computes"
 * — the arc sweeps and the figure counts up. That motion is the pitch in
 * miniature: the score is live and derived, not a static badge.
 *
 * IT ANIMATES ON VIEW, NOT ON MOUNT, and the distinction is the whole point.
 * These rings sit inside cards partway down the homepage. Animating on mount
 * meant the sweep ran while the card was still below the fold and had long
 * finished by the time anyone scrolled to it — the reader saw a static number
 * and none of the motion that argues it was computed. Gated on the viewport,
 * the ring is drawn at zero and only counts up once it is actually looked at.
 *
 * Honors prefers-reduced-motion by rendering the final state with no animation.
 */
export function ScoreRing({
  score,
  size = 168,
  stroke = 10,
  className,
  label = '/ 100 safety',
}: {
  score: number | null;
  size?: number;
  stroke?: number;
  className?: string;
  label?: string | null;
}) {
  const reduce = useReducedMotion();
  const band = scoreBand(score);
  const color = bandColor(band);
  const target = score ?? 0;

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, target)) / 100;

  // Settled up front for reduced-motion and for a null score (there is nothing
  // to count up to); otherwise it starts at zero and waits to be seen.
  const settled = reduce || score === null;
  const [display, setDisplay] = useState(settled ? target : 0);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (settled) {
      setDisplay(target);
      return;
    }
    if (!seen) return;
    const controls = animate(0, target, {
      duration: 1.1,
      ease: EASE,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [target, settled, seen]);

  return (
    // The arc animates declaratively with `whileInView`, but the count-up is an
    // imperative animate() on a number, so it needs the crossing as an event.
    // `onViewportEnter` here is the SAME observer `whileInView` uses, on the
    // same element and the same viewport config, so both halves fire together.
    //
    // Deliberately not `useInView`: that hook reported false for these rings
    // inside the homepage's staggered RevealGroup cards even when they were on
    // screen, leaving the arc swept and the figure frozen at 0, while the
    // motion component's own viewport detection was correct on every page. One
    // observer, already proven in this codebase, beats two that disagree.
    <motion.div
      className={cn('relative inline-grid place-items-center', className)}
      style={{ width: size, height: size }}
      viewport={VIEWPORT}
      onViewportEnter={() => setSeen(true)}
      role="meter"
      aria-label={
        score === null
          ? 'Safety score: not yet scored'
          : `Safety score: ${score} out of 100 (${band} band). Scale 0 to 100, higher is safer.`
      }
      aria-valuenow={score ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={score === null ? 'Not scored' : `${score} out of 100`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={stroke}
        />
        {score !== null && (
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            // Fully retracted until seen; `whileInView` sweeps it to the real
            // value on the same threshold the count-up uses. Reduced motion
            // starts at the final offset so there is nothing to animate.
            initial={{ strokeDashoffset: reduce ? c * (1 - pct) : c }}
            whileInView={{ strokeDashoffset: c * (1 - pct) }}
            viewport={VIEWPORT}
            transition={{ duration: 1.1, ease: EASE }}
            style={{ filter: `drop-shadow(0 0 6px ${color}40)` }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center" aria-hidden="true">
        <div>
          <div
            className="score-num font-semibold leading-none"
            style={{ color, fontSize: size * 0.3 }}
          >
            {score === null ? '—' : Math.round(display)}
          </div>
          {label && (
            <div className="mt-1 text-[0.7rem] uppercase tracking-wider text-faint">{label}</div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
