'use client';

import { useEffect, useState } from 'react';
import { cn } from '../app/lib/cn';
import { interpretHealthResponse, type HealthStatus } from '../app/lib/health-fetch';

/**
 * The live status pill beside the footer's "Status" link.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS FETCHED RATHER THAN JUST BEING GREEN
 *
 * A hardcoded green pulse is the cheap version of this, and it is the one thing
 * this component must not be. A pulsing green dot next to the word "Status", on
 * every page of the site, is read as a claim — "the pipeline is live" — and it
 * would go on making that claim, most convincingly, during exactly the outage it
 * appears to rule out. That is the same failure `/api/v1/health` was built to
 * catch: scoring stops, nothing goes red, and the site keeps looking fine.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PULSE MEANS, AND WHAT THE COLOUR MEANS
 *
 * They are two different signals and it matters that they stay separate:
 *
 *   the PULSE says "this is a live reading, taken just now"
 *   the COLOUR and the LABEL say what the reading was
 *
 * So every state we actually measured pulses, in its own colour — a stopped
 * pipeline pulses red. Motion is not a verdict, and withholding it from the bad
 * states would make "no pulse" ambiguous between "down" and "we never got an
 * answer", which are the two things this pill exists to tell apart.
 *
 * `unknown` is therefore the ONE state that does not pulse: there is no reading
 * behind it. It is also never rendered in `safe` — an optimistic default is how
 * a status indicator quietly becomes decoration.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT POLL
 *
 * The status page polls every 30s; this does not, and fetches once per mount.
 * The footer is in the root layout, so it is on every page — polling here would
 * multiply a rate-limited endpoint's traffic across the whole site to animate a
 * 6px dot. Someone who wants a live reading is one click away from the page that
 * does poll, which is what the pill is attached to.
 *
 * Failure is silent by design: this is an ambient indicator, not an alert
 * surface. A footer that renders an error message because a background fetch
 * failed is worse than a footer showing "unknown".
 */

/** What we know about the pipeline. `unknown` covers both "not yet" and "could not". */
type DotState = HealthStatus | 'unknown';

/** State → pill chrome. Mirrors StatusPill's tone classes so the two match. */
function pillClass(state: DotState): string {
  switch (state) {
    case 'healthy':
      return 'border-safe/25 bg-safe/10 text-safe-ink';
    case 'degraded':
      return 'border-warn/25 bg-warn/10 text-warn-ink';
    case 'down':
      return 'border-danger/25 bg-danger/10 text-danger-ink';
    case 'unknown':
      return 'border-line bg-surface-2 text-faint';
  }
}

/** State → dot colour. `unknown` is deliberately the muted token, never `safe`. */
function dotClass(state: DotState): string {
  switch (state) {
    case 'healthy':
      return 'bg-safe';
    case 'degraded':
      return 'bg-warn';
    case 'down':
      return 'bg-danger';
    case 'unknown':
      return 'bg-faint';
  }
}

/**
 * The visible word.
 *
 * Colour alone is not a status: three of the four states are distinguished only
 * by hue on a 6px dot, so the label is the real signal and the colour is the
 * shorthand. "Live" rather than "Healthy" because it is what the pulse beside it
 * is asserting, and it reads as a statement about our pipeline rather than a
 * verdict on any protocol.
 */
function dotLabel(state: DotState): string {
  switch (state) {
    case 'healthy':
      return 'Live';
    case 'degraded':
      return 'Degraded';
    case 'down':
      return 'Down';
    case 'unknown':
      return 'Unknown';
  }
}

/** The full sentence, for the hover title and assistive tech. */
function dotTitle(state: DotState): string {
  switch (state) {
    case 'healthy':
      return 'Indexer healthy — every protocol scored recently';
    case 'degraded':
      return 'Indexer degraded — some protocols are not producing current data';
    case 'down':
      return 'Indexer down — no protocol is producing current data';
    case 'unknown':
      return 'Indexer status unavailable — could not reach the health endpoint';
  }
}

export function FooterStatusPill({ className }: { className?: string }) {
  const [state, setState] = useState<DotState>('unknown');

  useEffect(() => {
    // Guard against setting state after the layout unmounts on navigation.
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch('/api/v1/health', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload: unknown = await res.json().catch(() => null);

        // Shared with the status page on purpose. `degraded` and `down` arrive
        // as HTTP 503 WITH a body, so anything branching on `res.ok` would show
        // "unknown" for the two states this pill most needs to report.
        const result = interpretHealthResponse(res.status, payload);
        if (result.kind === 'data') setState(result.body.status);
      } catch {
        // Aborted, offline, or unreachable — stays `unknown`, which is the truth.
      }
    })();

    return () => controller.abort();
  }, []);

  return (
    <span
      title={dotTitle(state)}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none',
        pillClass(state),
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {/* Every measured state pulses, in its own colour — see the header on
            why motion is not the verdict. A reader who asked for reduced motion
            gets the same dot, static, rather than a different layout. */}
        {state !== 'unknown' && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none',
              dotClass(state),
            )}
          />
        )}
        <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', dotClass(state))} />
      </span>
      {dotLabel(state)}
      <span className="sr-only">{dotTitle(state)}</span>
    </span>
  );
}
