import { CircleCheck, CircleSlash, TriangleAlert } from 'lucide-react';
import { cn } from '../app/lib/cn';
import { stalenessLabel } from '../app/lib/format';
import type { RunStatus } from '../app/lib/contract';

/**
 * Freshness indicator. The displayed score is always the latest *ok* run; this
 * pill surfaces whether the newest run of any status succeeded, so a stale
 * number is never presented as current without a flag.
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
  const { text, tone } = stalenessLabel(lastRunStatus, hasScore);

  const styles =
    tone === 'ok'
      ? 'border-safe/25 bg-safe/10 text-safe'
      : tone === 'warn'
        ? 'border-danger/25 bg-danger/10 text-danger'
        : 'border-line bg-surface-2 text-faint';

  const Icon = tone === 'ok' ? CircleCheck : tone === 'warn' ? TriangleAlert : CircleSlash;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium',
        styles,
        className,
      )}
    >
      {tone === 'ok' && (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-safe opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-safe" />
        </span>
      )}
      {tone !== 'ok' && <Icon className="h-3.5 w-3.5" strokeWidth={2} />}
      {text}
    </span>
  );
}
