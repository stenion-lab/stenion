'use client';

import { cn } from '../app/lib/cn';
import { factorRows, type RiskFactor } from '../app/lib/contract';
import { FactorCard } from './factor-bar';
import { RevealGroup, RevealItem, type RevealTrigger } from './reveal';

/**
 * A factor map, laid out by how much each factor actually has to say.
 *
 * A factor that publishes a `components` breakdown carries several times the
 * content of one that doesn't — `oracleSafety` always does, with three
 * sub-signals and roughly six times the text of any other factor, and
 * `liquiditySafety`/`utilizationSafety` do whenever the minimum-size filter
 * excluded a reserve they then have to disclose. In a uniform two-column grid
 * that forced its row partner to stretch to match, leaving a tall empty gap
 * beside it (and, with five cards in two columns, an orphan on the last row).
 * Factors with a breakdown get the full width instead; the rest fill an even
 * grid.
 *
 * This is a presentation choice, not a ranking one — the registry still ranks
 * purely on `safetyScore`, and giving a factor more room says nothing about its
 * value. It's keyed off having a breakdown rather than hardcoding `oracleSafety`
 * so a factor that gains components later is laid out correctly without a change
 * here. Note it does reorder the display: featured factors lead, and the rest
 * follow in FACTOR_ORDER.
 *
 * ONE COMPONENT FOR BOTH PLACES. This renders the current score's breakdown on
 * the protocol page and a past run's breakdown in the run history, from the
 * same props, because they are the same thing measured at different times.
 * A second implementation of this layout would be free to drift into showing a
 * historical run under rules the current one no longer uses.
 *
 * Which rows it draws comes from the MAP, via `factorRows` — not from
 * FACTOR_ORDER alone. See that function for why: a historical run stored the
 * factor set its own rulebook published, and a future category's set is not
 * lending's five.
 */
export function FactorBreakdown({
  factors,
  trigger = 'in-view',
  className,
}: {
  factors: Record<string, RiskFactor | null>;
  /**
   * Must be `'mount'` anywhere this can appear from an interaction rather than
   * from a page load — inside an expandable row, for instance. Under
   * `'in-view'` the RevealGroups below stop observing after their one fire, and
   * a child mounting later sits at `opacity: 0`, rendered and invisible. See
   * the note on RevealGroup; this is that hazard, not a style knob.
   */
  trigger?: RevealTrigger;
  className?: string;
}) {
  const rows = factorRows(factors);
  const hasBreakdown = (factor: RiskFactor | null) => (factor?.components?.length ?? 0) > 0;
  const featured = rows.filter((r) => hasBreakdown(r.factor));
  const compact = rows.filter((r) => !hasBreakdown(r.factor));

  return (
    <div className={cn('space-y-3', className)}>
      {featured.length > 0 && (
        <RevealGroup className="space-y-3" stagger={0.06} trigger={trigger}>
          {featured.map(({ key, label, factor }, i) => (
            <RevealItem key={key}>
              <FactorCard label={label} factor={factor} index={i} featured />
            </RevealItem>
          ))}
        </RevealGroup>
      )}

      {compact.length > 0 && (
        <RevealGroup className="grid gap-3 sm:grid-cols-2" stagger={0.06} trigger={trigger}>
          {compact.map(({ key, label, factor }, i) => (
            <RevealItem key={key} className="h-full">
              <FactorCard label={label} factor={factor} index={featured.length + i} />
            </RevealItem>
          ))}
        </RevealGroup>
      )}
    </div>
  );
}
