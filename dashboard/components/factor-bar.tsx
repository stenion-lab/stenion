'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '../app/lib/cn';
import { bandColor, bandTextClass, scoreBand } from '../app/lib/format';
import type { RiskFactor, RiskFactorComponent } from '../app/lib/contract';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * One factor row on the detail page: name + weight, the value, the animated
 * fill bar (grades against the 0–100 safety scale), and — the actual product —
 * the real `detail` string explaining why the number is what it is.
 *
 * `featured` is for a factor that publishes a `components` breakdown. Those
 * carry several times the content of a bare factor, so the detail page gives
 * them the full page width and lays their sub-signals out side by side rather
 * than as one tall stack. See FactorBreakdown in the protocol page.
 */
export function FactorCard({
  label,
  factor,
  index = 0,
  featured = false,
}: {
  label: string;
  factor: RiskFactor | null;
  index?: number;
  featured?: boolean;
}) {
  const reduce = useReducedMotion();

  if (factor === null) {
    return (
      <article
        className="surface-lit h-full rounded-xl border border-line-soft p-5"
        aria-label={`${label}: Not applicable to this protocol`}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-medium text-ink">{label}</span>
          <span className="tnum text-sm text-faint" aria-label="Not applicable">
            N/A
          </span>
        </div>
        <p className="mt-3 text-sm italic text-faint">Not applicable to this protocol.</p>
      </article>
    );
  }

  const band = scoreBand(factor.value);
  const pct = Math.max(0, Math.min(100, factor.value));

  return (
    <article
      className="surface-lit h-full rounded-xl border border-line p-5 transition-colors hover:border-line/80"
      aria-label={`${label} factor: score ${factor.value} out of 100, weight ${Math.round(factor.weight * 100)}%`}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium text-ink">
          {label}
          <span className="ml-2 text-xs font-normal text-faint">
            weight {Math.round(factor.weight * 100)}%
          </span>
        </span>
        <span
          className={`score-num text-lg font-semibold ${bandTextClass(band)}`}
          aria-label={`Score ${factor.value} out of 100`}
        >
          {factor.value}
        </span>
      </div>

      <div
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line-soft"
        role="progressbar"
        aria-label={`${label} safety score`}
        aria-valuenow={factor.value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${factor.value} out of 100`}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ background: bandColor(band) }}
          initial={{ width: reduce ? `${pct}%` : 0 }}
          whileInView={{ width: `${pct}%` }}
          viewport={{ once: true }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.05 * index }}
        />
      </div>

      {/* `adapter-prose`: this string is composed by an adapter from values the
          protocol publishes, so it can contain a contract address or a label
          with no break opportunity. See the rule in globals.css. */}
      <p className="adapter-prose mt-3 text-sm leading-relaxed text-muted">{factor.detail}</p>

      {factor.components && factor.components.length > 0 && (
        <FactorComponents components={factor.components} featured={featured} />
      )}
    </article>
  );
}

/**
 * A factor's sub-signals, split the way METHODOLOGY.md §2c/§2d split them: the
 * scored components the value was computed from, then the disclosures
 * (`value: null`) that are published but deliberately not graded. Rendering
 * them as one flat list made a disclosure look like a component that had simply
 * failed to produce a number, which is the opposite of what a null means here.
 */
function FactorComponents({
  components,
  featured,
}: {
  components: RiskFactorComponent[];
  featured: boolean;
}) {
  const scored = components.filter((c) => c.value !== null);
  const disclosures = components.filter((c) => c.value === null);

  return (
    <div className="mt-4 border-t border-line-soft pt-3.5">
      {scored.length > 0 && (
        <ul
          className={cn(
            'space-y-2.5',
            // Side by side only when featured (full page width) and there's more
            // than one — two short sub-signals in a narrow card would wrap badly.
            featured && scored.length > 1 && 'grid gap-x-8 gap-y-3 space-y-0 sm:grid-cols-2',
          )}
        >
          {scored.map((c) => (
            <ComponentRow key={c.id} component={c} />
          ))}
        </ul>
      )}

      {disclosures.length > 0 && (
        <ul
          className={cn(
            'space-y-2.5',
            scored.length > 0 && 'mt-3.5 border-t border-line-soft pt-3.5',
          )}
        >
          {disclosures.map((c) => (
            <ComponentRow key={c.id} component={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ComponentRow({ component: c }: { component: RiskFactorComponent }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted">{c.label}</span>
        {c.value === null ? (
          // A null component is a deliberate disclosure, not missing data —
          // say so rather than rendering a bare dash the reader must guess at.
          <span
            className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint"
            aria-label={`${c.label}: not scored disclosure`}
          >
            not scored
          </span>
        ) : (
          <span
            className={`score-num shrink-0 text-sm font-semibold ${bandTextClass(scoreBand(c.value))}`}
            aria-label={`${c.label} sub-score: ${c.value} out of 100`}
          >
            {c.value}
          </span>
        )}
      </div>
      {/* Same rule as the factor detail above, and this is the one that
          actually broke: the `priceAges` disclosure lists a label PER RESERVE,
          so a protocol that labels its feeds by address puts one unbreakable
          token here for every reserve in the pool. */}
      <p className="adapter-prose mt-1 text-xs leading-relaxed text-faint">{c.detail}</p>
    </li>
  );
}
