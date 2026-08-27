import { CircleSlash, RefreshCwOff } from 'lucide-react';
import { cn } from '../app/lib/cn';
import { freshness, freshnessPillClass } from '../app/lib/format';
import type { RunStatus } from '../app/lib/contract';

/**
 * Freshness indicator. The displayed score is always the latest *ok* run; this
 * pill surfaces whether the newest run of any status succeeded, so a stale
 * number is never presented as current without a flag.
 *
 * Colour comes from `freshnessPillClass`, NOT from the score bands — read the
 * note there before changing it. The pill is a label, not an alert: "update
 * failed" is a statement about our pipeline, and it must not read as a verdict
 * on the protocol.
 */
export function StatusPill({
  lastRunStatus,
  hasScore,
  className,
}: {
  lastRunStatus: RunStatus | null;
  hasScore: boolean;
  className?: string;
}) {
  const { label, tone } = freshness(lastRunStatus, hasScore);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium',
        freshnessPillClass(tone),
        className,
      )}
      aria-label={`Freshness status: ${label}`}
    >
      {tone === 'live' && (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          {/* The ping is the one piece of motion here; a reader who asked for
              none gets the same dot, static, rather than a different layout. */}
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-safe opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-safe" />
        </span>
      )}
      {tone === 'stale' && (
        <RefreshCwOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      )}
      {tone === 'unscored' && (
        <CircleSlash className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

/**
 * The full sentence behind the pill, revealed on hover or on keyboard focus of
 * an enclosing `group`.
 *
 * It is NOT a focusable trigger of its own on purpose: on the registry the
 * group is the row's `<Link>`, and a focusable element nested inside an anchor
 * is invalid HTML. Tying the reveal to the row instead means tabbing to the row
 * shows it, which is the keyboard equivalent of hovering it.
 *
 * The text is always in the DOM (only its opacity changes), so assistive tech
 * reads it as part of the row regardless of hover.
 */
export function FreshnessTooltip({ text, className }: { text: string; className?: string }) {
  return (
    <span
      role="note"
      className={cn(
        'pointer-events-none absolute left-0 top-full z-20 mt-2 w-64 rounded-lg border border-line bg-surface p-3 text-left text-xs font-normal leading-relaxed text-muted opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none',
        className,
      )}
    >
      {text}
    </span>
  );
}
