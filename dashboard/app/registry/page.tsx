import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, ServerCrash, ShieldCheck } from 'lucide-react';
import { getProtocols, type LeaderboardEntry } from '../lib/api';
import { bandColor, bandTextClass, formatTimestamp, scoreBand } from '../lib/format';
import { StatusPill } from '../../components/status-pill';
import { Reveal, RevealGroup, RevealItem } from '../../components/reveal';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Protocol registry',
  description:
    'Every protocol Stenion tracks, ranked purely by on-chain safety score. Free, public, payment-blind.',
};

export default async function RegistryPage() {
  let protocols: LeaderboardEntry[] | null = null;
  let errored = false;
  try {
    protocols = await getProtocols();
  } catch {
    errored = true;
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-14">
      <Reveal>
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs text-muted">
          <ShieldCheck className="h-3.5 w-3.5 text-accent" />
          Ranked by safety score · payment-blind
        </span>
        <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
          Protocol registry
        </h1>
        <p className="mt-3 max-w-2xl text-muted">
          Every protocol Stenion tracks, ordered by its live safety score — higher is safer. Ranking
          is derived purely from on-chain data; no protocol can pay to move up. Open a protocol to
          see the full factor breakdown behind its number.
        </p>
      </Reveal>

      {errored ? (
        <ErrorState />
      ) : !protocols || protocols.length === 0 ? (
        <EmptyState />
      ) : (
        <Reveal delay={0.05} className="mt-10">
          {/* header row (desktop) */}
          <div className="hidden grid-cols-[3rem_1fr_8rem_10rem_9rem] gap-4 border-b border-line px-4 pb-3 text-xs uppercase tracking-wider text-faint md:grid">
            <span>#</span>
            <span>Protocol</span>
            <span>Chain</span>
            <span>Safety score</span>
            <span>Freshness</span>
          </div>

          <RevealGroup className="divide-y divide-line-soft" stagger={0.05}>
            {protocols.map((p, i) => (
              <RevealItem key={p.id}>
                <ProtocolRow entry={p} rank={i + 1} />
              </RevealItem>
            ))}
          </RevealGroup>
        </Reveal>
      )}
    </div>
  );
}

function ProtocolRow({ entry, rank }: { entry: LeaderboardEntry; rank: number }) {
  const band = scoreBand(entry.safetyScore);
  const hasScore = entry.safetyScore !== null;
  const pct = hasScore ? entry.safetyScore! : 0;

  return (
    <Link
      href={`/protocol/${entry.id}`}
      className="group grid grid-cols-1 gap-3 px-4 py-5 transition-colors hover:bg-surface/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg md:grid-cols-[3rem_1fr_8rem_10rem_9rem] md:items-center md:gap-4"
    >
      <div className="tnum hidden text-sm text-faint md:block">{String(rank).padStart(2, '0')}</div>

      <div className="flex items-center gap-2">
        <span className="tnum mr-1 text-sm text-faint md:hidden">
          {String(rank).padStart(2, '0')}
        </span>
        <span className="font-display text-lg font-semibold text-ink">{entry.name}</span>
        <ArrowUpRight className="h-4 w-4 text-faint transition-colors group-hover:text-accent" />
      </div>

      <div className="text-sm text-muted">
        <span className="text-xs uppercase tracking-wider text-faint md:hidden">Chain: </span>
        {entry.chain}
      </div>

      <div>
        <div className="flex items-baseline gap-2">
          <span className={`tnum text-2xl font-semibold ${bandTextClass(band)}`}>
            {hasScore ? entry.safetyScore : '—'}
          </span>
          <span className="text-xs text-faint">/ 100</span>
        </div>
        {hasScore ? (
          <div className="mt-1.5 h-1 w-full max-w-[9rem] overflow-hidden rounded-full bg-line-soft">
            <div
              className="h-full rounded-full"
              style={{ width: `${pct}%`, background: bandColor(band) }}
            />
          </div>
        ) : (
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-faint">
            <span className="inline-block h-1 w-full max-w-[9rem] overflow-hidden rounded-full bg-line-soft">
              <span className="block h-full w-full rounded-full bg-line-soft/50" />
            </span>
            <span className="shrink-0 italic">Unscored</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <StatusPill lastRunStatus={entry.lastRunStatus} hasScore={hasScore} />
        <span className="text-xs text-faint md:hidden">{formatTimestamp(entry.lastRunAt)}</span>
      </div>
    </Link>
  );
}
function EmptyState() {
  return (
    <div className="mt-10 rounded-xl border border-line surface-lit p-10 text-center">
      <ShieldCheck className="mx-auto h-8 w-8 text-faint" />
      <h2 className="mt-4 font-display text-lg font-semibold text-ink">No protocols scored yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        The indexer hasn&apos;t published a run yet. Once it does, protocols will appear here ranked
        by safety score.
      </p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="mt-10 rounded-xl border border-danger/25 bg-danger/5 p-10 text-center">
      <ServerCrash className="mx-auto h-8 w-8 text-danger" />
      <h2 className="mt-4 font-display text-lg font-semibold text-ink">
        Couldn&apos;t reach the Stenion API
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        The registry is served from the Stenion API, which appears to be unavailable right now. This
        is a data-availability issue, not a scoring change — try again shortly.
      </p>
    </div>
  );
}
