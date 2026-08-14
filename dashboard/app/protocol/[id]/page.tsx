import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Boxes } from 'lucide-react';
import {
  FACTOR_ORDER,
  getProtocolDetail,
  type HistoryEntry,
  type ProtocolDetail,
} from '../../lib/api';
import { formatTimestamp } from '../../lib/format';
import { ScoreRing } from '../../../components/score-ring';
import { StatusPill } from '../../../components/status-pill';
import { FactorCard } from '../../../components/factor-bar';
import { Reveal, RevealGroup, RevealItem } from '../../../components/reveal';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getProtocolDetail(id).catch(() => null);
  // An unknown id makes the page component below throw notFound(), which renders
  // app/not-found.tsx — and that file supplies its own title. Anything returned
  // here for a missing protocol is discarded, so don't pretend to set one.
  if (!detail) return {};
  const score = detail.safetyScore ?? '—';
  return {
    title: `${detail.name} — safety ${score}`,
    description: `Live Stenion safety score and factor breakdown for ${detail.name} on ${detail.chain}.`,
  };
}

export default async function ProtocolDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getProtocolDetail(id);
  // Real 404 status, not just the 404 UI. This only works because there is NO
  // Suspense boundary above this route — no loading.tsx here, and the homepage's
  // one is scoped to the (home) route group. Any enclosing boundary lets Next
  // flush the 200 shell before this throws, which renders the not-found page
  // under a 200 (a soft-404 that search engines index as a real page).
  // DO NOT add a loading.tsx to this route without re-checking the status code.
  if (!detail) notFound();

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <Reveal>
        <Link
          href="/registry"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Registry
        </Link>
      </Reveal>

      <Hero detail={detail} />

      <section className="mt-14">
        <Reveal>
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-accent" />
            <h2 className="font-display text-xl font-semibold text-ink">Factor breakdown</h2>
          </div>
          <p className="mt-1 text-sm text-muted">
            Why the score is what it is — each factor on a 0–100 scale, higher is safer.
          </p>
        </Reveal>

        {detail.factors === null ? (
          <div className="mt-6 rounded-xl border border-line surface-lit p-8 text-center text-sm text-muted">
            No factor breakdown yet — this protocol has no successful score run.
          </div>
        ) : (
          <RevealGroup className="mt-6 grid gap-3 sm:grid-cols-2" stagger={0.06}>
            {FACTOR_ORDER.map(({ key, label }, i) => (
              <RevealItem key={key}>
                <FactorCard label={label} factor={detail.factors![key]} index={i} />
              </RevealItem>
            ))}
          </RevealGroup>
        )}
      </section>

      <History history={detail.history} />
    </div>
  );
}

function Hero({ detail }: { detail: ProtocolDetail }) {
  const hasScore = detail.safetyScore !== null;
  return (
    <Reveal delay={0.05} className="mt-6">
      <div className="flex flex-col items-start gap-8 rounded-2xl border border-line surface-lit p-8 sm:flex-row sm:items-center">
        <ScoreRing score={detail.safetyScore} size={176} />

        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl font-semibold tracking-tight text-ink">
            {detail.name}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="capitalize">{detail.chain}</span>
            <span className="text-faint">·</span>
            <span>
              adapter{' '}
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">
                {detail.adapter}
              </code>
            </span>
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <StatusPill
              lastRunStatus={detail.lastRunStatus}
              hasScore={hasScore}
            />
            <span className="text-sm text-muted">
              {detail.computedAt
                ? `Scored ${formatTimestamp(detail.computedAt)}`
                : 'Not yet scored'}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-faint">
            Last run {formatTimestamp(detail.lastRunAt)} · updated on every indexer cycle
          </p>
          {!hasScore && (
            <p className="mt-2 text-sm text-faint">
              This protocol doesn’t have a score yet. Scoring has not succeeded on any run
              so far — a missing score and a low score are not the same thing.
            </p>
          )}
        </div>
      </div>
    </Reveal>
  );
}

function History({ history }: { history: HistoryEntry[] }) {
  return (
    <section className="mt-14">
      <Reveal>
        <h2 className="font-display text-xl font-semibold text-ink">Recent runs</h2>
        <p className="mt-1 text-sm text-muted">
          {history.length > 0
            ? `The last ${history.length} scoring ${history.length === 1 ? 'run' : 'runs'}, newest first.`
            : 'No scoring runs recorded yet.'}
        </p>
      </Reveal>
      {history.length === 0 ? (
        <Reveal delay={0.05} className="mt-5 rounded-xl border border-dashed border-line bg-surface/30 p-8 text-center text-sm text-faint">
          The indexer hasn’t run a scoring cycle for this protocol yet. Once a run completes,
          its result will appear here.
        </Reveal>
      ) : (
        <Reveal delay={0.05} className="mt-5 overflow-hidden rounded-xl border border-line">
          <ul className="divide-y divide-line-soft">
            {history.map((h, i) => (
              <li key={i} className="flex items-center gap-3 bg-surface/40 px-4 py-3 text-sm">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    h.status === 'ok' ? 'bg-safe' : 'bg-danger'
                  }`}
                />
                <span className="tnum w-40 shrink-0 text-muted">{formatTimestamp(h.runAt)}</span>
                {h.status === 'ok' ? (
                  <span className="text-ink">
                    scored <span className="tnum font-semibold">{h.safetyScore}</span>
                  </span>
                ) : (
                  <span className="truncate text-danger">failed — {h.error}</span>
                )}
              </li>
            ))}
          </ul>
        </Reveal>
      )}
    </section>
  );
}
