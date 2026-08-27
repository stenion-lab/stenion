// "This entry is a market on someone else's contracts."
//
// WHY IT EXISTS. Every entry in the registry used to be an independent protocol,
// so a row's name was the whole story. The YieldBlox pool breaks that: it runs
// Blend's V2 pool contract byte-for-byte (identical wasm hash to Blend's own
// Fixed pool), and listing it unqualified beside Blend and Kinetic would tell a
// reader the ecosystem has three independent lending protocols when it has two
// protocols and three markets. Stenion refused to build a standalone YieldBlox
// adapter for exactly that reason, so this label is not decoration — it is the
// condition on which the entry is allowed to exist at all.
//
// COLOUR IS DELIBERATELY NEUTRAL. Not a score band, because this says nothing
// about risk: a pool on Blend's contracts is neither safer nor more dangerous
// for being one, and a green or amber pill would assert otherwise. Not accent
// either — the dashboard already spends accent on freshness ("our data is old"),
// and a second accent-toned marker on the same row would blur a distinction that
// took work to draw. Identity gets its own quiet register: hairline border,
// muted text, no fill that competes with the score.
//
// It renders nothing when `deployedOn` is null, which is the normal case. There
// is no "independent" badge to go with it: labelling the ordinary state would
// turn the exception into noise, and absence already means the entry runs on its
// own contracts (never "unknown" — see ProtocolDeployment).

import { Layers } from 'lucide-react';

import { cn } from '../app/lib/cn';
import type { ProtocolDeployment } from '../app/lib/contract';

export interface DeploymentBadgeProps {
  deployedOn: ProtocolDeployment | null;
  className?: string;
}

/**
 * The compact form: one pill, scannable in a registry row or a card.
 *
 * `label` is rendered verbatim rather than composed here ("Pool on " + host)
 * because the phrasing is a per-market fact the adapter owns — "Blend V2 pool"
 * is right for YieldBlox and would be wrong for a deployment that isn't a pool.
 * The UI's job is to make sure it is SEEN, not to write it.
 */
export function DeploymentBadge({ deployedOn, className }: DeploymentBadgeProps) {
  if (deployedOn === null) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted',
        className,
      )}
      // The visible text says "Blend V2 pool", which is complete but terse. The
      // title spells out the relationship for anyone who hovers, without
      // spending a second line of the row on it.
      title={`Not an independent protocol — this entry is a ${deployedOn.label}, running ${deployedOn.host}'s contracts.`}
      aria-label={`Deployment: ${deployedOn.label}, running on ${deployedOn.host}'s contracts`}
    >
      <Layers className="h-3 w-3 shrink-0" aria-hidden="true" />
      {deployedOn.label}
    </span>
  );
}

/**
 * The full form for a protocol's own page, where there is room to say the whole
 * thing once rather than compress it into a pill.
 *
 * Placed directly under the hero, above the factor breakdown, because a reader
 * has to know WHAT they are looking at before any number means anything: a
 * `contractId` that resolves to a Blend pool is only checkable if you already
 * know it is supposed to.
 *
 * What it deliberately does NOT say: anything evaluative. It doesn't call the
 * arrangement good or bad, and it doesn't imply the host protocol endorses or is
 * responsible for this market. Both of those would be claims we can't make from
 * the chain — what we can read is whose code it runs, and that is all it states.
 */
export function DeploymentNotice({
  deployedOn,
  name,
  className,
}: {
  deployedOn: ProtocolDeployment | null;
  /** the market's own display name, e.g. "YieldBlox" */
  name: string;
  className?: string;
}) {
  if (deployedOn === null) return null;
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border border-line surface-lit p-5',
        className,
      )}
    >
      <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted" strokeWidth={2} aria-hidden="true" />
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">
          {name} is a {deployedOn.label}, not an independent protocol
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          It runs {deployedOn.host}&rsquo;s contract code rather than its own, so Stenion scores it
          with the same adapter. It gets its own entry because everything the score is computed from
          — the reserves, the oracle configuration, the admin — belongs to this market and not to{' '}
          {deployedOn.host}, and those differ enough to produce a different number.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-faint">
          Being a {deployedOn.label} is not itself a risk finding, and it is not scored. It is
          stated so this entry is not read as a third protocol where the chain has a second market.
        </p>
      </div>
    </div>
  );
}
