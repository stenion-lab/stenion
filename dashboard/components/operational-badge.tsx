// "This market is currently refusing some of what a user would want to do."
//
// WHY IT EXISTS. Both adapters have always read a pause/frozen signal and
// neither ever fed it into a score, so a halted market and a fully open one
// published the same number with nothing to tell them apart. Issue #15 resolved
// that by publishing the state rather than grading it — because nothing on chain
// separates an admin freezing a pool to contain a threat from an admin
// abandoning it, and because the two protocols' restricted states are not the
// same shape (Blend never blocks a withdrawal at any status; K2's pause blocks
// all of them). Grading either into one number would assert an equivalence that
// is not true.
//
// THAT DECISION IS ONLY HONEST IF THIS IS SEEN. The whole objection to a
// display-only flag is the reader who looks at the number and ignores the label,
// so this is not a footnote on a detail page: it rides every registry row and
// every home-page card, beside the score, exactly like <DeploymentBadge>. A flag
// nobody scans is a decision to hide.
//
// COLOUR IS NOT A BAND, AND MUST NOT BECOME ONE. `safe`/`warn`/`danger` mean
// risk level in this dashboard, and this marker is precisely the thing that is
// published WITHOUT a risk judgement — the same rule <StatusPill> follows for
// freshness, for the same reason. Prominence comes from weight instead of hue;
// see `operationalPillClass`, which owns that choice and is tested.
//
// It renders nothing when the level is `active`, on the deployment badge's
// reasoning: labelling the ordinary state turns the exception into noise, and an
// "all operations available" pill would read as a safety endorsement. It also
// renders nothing when `operationalState` is null, which means the state was not
// read (never scored, or a run predating the field) — never that the market is
// unrestricted.

import { AlertTriangle, CircleSlash, Lock, PauseCircle } from 'lucide-react';

import { cn } from '../app/lib/cn';
import { operationalLabel, operationalPillClass } from '../app/lib/format';
import type { OperationalLevel, OperationalState } from '../app/lib/contract';

/** Icon per level. Wording and colour live in `format.ts`, so they can be tested. */
const ICONS: Record<Exclude<OperationalLevel, 'active'>, typeof Lock> = {
  borrowingDisabled: PauseCircle,
  entryDisabled: AlertTriangle,
  // The one that traps capital.
  exitDisabled: Lock,
  notOperational: CircleSlash,
};

export interface OperationalBadgeProps {
  operationalState: OperationalState | null;
  className?: string;
}

/** The compact form: one pill, scannable in a registry row or a card. */
export function OperationalBadge({ operationalState, className }: OperationalBadgeProps) {
  if (operationalState === null || operationalState.level === 'active') return null;
  const Icon = ICONS[operationalState.level];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium',
        operationalPillClass(operationalState.level),
        className,
      )}
      // The pill is terse by necessity; the title carries the protocol's own
      // reading and the plain-language consequence, so hovering answers "says
      // who?" without spending another line of the row.
      title={`${operationalState.detail} (read from ${operationalState.source}). Not scored — see the methodology.`}
      aria-label={`Operational status: ${operationalLabel(operationalState.level)}. ${operationalState.detail}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {operationalLabel(operationalState.level)}
    </span>
  );
}

/**
 * The full form for a protocol's own page, where there is room to say the whole
 * thing once rather than compress it into a pill.
 *
 * Placed under the hero with <DeploymentNotice>, above the factor breakdown, for
 * the same reason: a reader has to know what they are looking at before the
 * number means anything. Here that matters more than for a deployment label,
 * because this is the one piece of published state the score deliberately does
 * not reflect — so the notice has to say so explicitly rather than leaving a
 * reader to assume the number already accounts for it.
 */
export function OperationalNotice({
  operationalState,
  name,
  className,
}: {
  operationalState: OperationalState | null;
  /** the market's own display name */
  name: string;
  className?: string;
}) {
  if (operationalState === null || operationalState.level === 'active') return null;
  const Icon = ICONS[operationalState.level];
  const { level, blocked, origin, source, detail, asOf } = operationalState;

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border border-line surface-lit p-5',
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" strokeWidth={2} aria-hidden="true" />
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">
          {name}: {operationalLabel(level).toLowerCase()}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{detail}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Operations currently refused:{' '}
          <span className="text-ink">{blocked.length === 0 ? 'none' : blocked.join(', ')}</span>.
          Read from <code className="text-ink">{source}</code> at{' '}
          <time dateTime={asOf}>{asOf}</time>.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-faint">
          {/* The ambiguity, stated rather than smoothed over. This is the part a
              reader most needs and the part a score could not have carried. */}
          {origin === 'protocol'
            ? 'The protocol’s own mechanism can produce this state without an admin acting. '
            : origin === 'admin'
              ? 'Only an admin could have set this state. '
              : 'The chain does not say whether an admin or the protocol’s own mechanism set this. '}
          Nothing here says whether that is good or bad, and{' '}
          <strong className="font-medium text-muted">it is not scored</strong>: a pause can mean an
          admin containing a threat or a market being abandoned, and no on-chain data tells the two
          apart. The score above reflects the same five factors it always does — read it alongside
          this, not through it.
        </p>
      </div>
    </div>
  );
}
