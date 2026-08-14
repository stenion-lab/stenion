'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { bandColor, bandTextClass, scoreBand } from '../app/lib/format';
import type { RiskFactor } from '../app/lib/contract';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * One factor row on the detail page: name + weight, the value, the animated
 * fill bar (grades against the 0–100 safety scale), and — the actual product —
 * the real `detail` string explaining why the number is what it is.
 */
export function FactorCard({
  label,
  factor,
  index = 0,
}: {
  label: string;
  factor: RiskFactor | null;
  index?: number;
}) {
  const reduce = useReducedMotion();

  if (factor === null) {
    return (
      <div className="surface-lit rounded-xl border border-line-soft p-5">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-medium text-ink">{label}</span>
          <span className="tnum text-sm text-faint">N/A</span>
        </div>
        <p className="mt-3 text-sm italic text-faint">Not applicable to this protocol.</p>
      </div>
    );
  }

  const band = scoreBand(factor.value);
  const pct = Math.max(0, Math.min(100, factor.value));

  return (
    <div className="surface-lit rounded-xl border border-line p-5 transition-colors hover:border-line/80">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium text-ink">
          {label}
          <span className="ml-2 text-xs font-normal text-faint">
            weight {Math.round(factor.weight * 100)}%
          </span>
        </span>
        <span className={`tnum text-lg font-semibold ${bandTextClass(band)}`}
          aria-label={`${label}: ${factor.value} out of 100`}>{factor.value}</span>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
        <motion.div
          className="h-full rounded-full"
          style={{ background: bandColor(band) }}
          initial={{ width: reduce ? `${pct}%` : 0 }}
          whileInView={{ width: `${pct}%` }}
          viewport={{ once: true }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.05 * index }}
        />
      </div>

      <p className="mt-3 text-sm leading-relaxed text-muted">{factor.detail}</p>
    </div>
  );
}
