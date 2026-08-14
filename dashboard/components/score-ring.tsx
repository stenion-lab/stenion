'use client';

import { animate, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { cn } from '../app/lib/cn';
import { bandColor, scoreBand } from '../app/lib/format';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The product's hero number, rendered as a radial gauge that visibly "computes"
 * on mount — the arc sweeps and the figure counts up. That motion is the pitch
 * in miniature: the score is live and derived, not a static badge. Honors
 * prefers-reduced-motion (renders the final state, no animation).
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

  const [display, setDisplay] = useState(reduce || score === null ? target : 0);

  useEffect(() => {
    if (reduce || score === null) {
      setDisplay(target);
      return;
    }
    const controls = animate(0, target, {
      duration: 1.1,
      ease: EASE,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [target, reduce, score]);

  const scoreLabel =
    score !== null
      ? \`\${Math.round(score)} out of 100, higher is safer\`
      : 'Safety score not yet available';

  return (
    <div
      className={cn('relative inline-grid place-items-center', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={scoreLabel}
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
            initial={{ strokeDashoffset: reduce ? c * (1 - pct) : c }}
            animate={{ strokeDashoffset: c * (1 - pct) }}
            transition={{ duration: 1.1, ease: EASE }}
            style={{ filter: `drop-shadow(0 0 6px ${color}40)` }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center" aria-hidden="true">
        <div>
          <div
            className="tnum font-display font-semibold leading-none"
            style={{ color, fontSize: size * 0.3 }}
          >
            {score === null ? '—' : Math.round(display)}
          </div>
          {label && (
            <div className="mt-1 text-[0.7rem] uppercase tracking-wider text-faint">{label}</div>
          )}
        </div>
      </div>
    </div>
  );
}
