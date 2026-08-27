'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ExternalLink, RefreshCw } from 'lucide-react';
import { cn } from '../lib/cn';

// ---------------------------------------------------------------------------
// Types — mirrors the HealthBody shape from api/_health, declared locally so
// this client component never imports a server-only module. The API route
// returns this exact JSON.
// ---------------------------------------------------------------------------

type HealthStatus = 'healthy' | 'degraded' | 'down';

interface HealthProtocol {
  id: string;
  lastSuccessfulRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
  staleMinutes: number | null;
}

interface HealthResponse {
  status: HealthStatus;
  thresholdMinutes: number;
  protocols: HealthProtocol[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Status → theme colour token class. */
function statusColorClass(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'text-safe';
    case 'degraded':
      return 'text-warn';
    case 'down':
      return 'text-danger';
  }
}

/** Status → background tint class for the hero banner. */
function statusBgClass(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'border-safe/25 bg-safe/10';
    case 'degraded':
      return 'border-warn/25 bg-warn/10';
    case 'down':
      return 'border-danger/25 bg-danger/10';
  }
}

/** Status → human-readable summary sentence. */
function statusSummary(status: HealthStatus, threshold: number): string {
  switch (status) {
    case 'healthy':
      return `All protocols scored successfully within the last ${threshold} minutes.`;
    case 'degraded':
      return 'Some protocols are behind — at least one adapter is not producing current data.';
    case 'down':
      return 'No protocols are producing current data. The indexer may be stopped.';
  }
}

/** Format an ISO timestamp as a relative time string ("4 minutes ago"). */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

/** Format an ISO timestamp for the title/tooltip. */
function formatIso(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toUTCString();
}

/** Whether a protocol is current given the threshold. */
function isCurrent(p: HealthProtocol, threshold: number): boolean {
  return p.staleMinutes !== null && p.staleMinutes <= threshold;
}

/** Staleness → colour class for the staleness number. */
function stalenessClass(staleMinutes: number | null, threshold: number): string {
  if (staleMinutes === null) return 'text-danger';
  if (staleMinutes <= threshold) return 'text-safe';
  return 'text-danger';
}

/** Last run status → pill classes. */
function runStatusPillClass(status: 'ok' | 'failed' | null): string {
  switch (status) {
    case 'ok':
      return 'border-safe/25 bg-safe/10 text-safe-ink';
    case 'failed':
      return 'border-accent/40 bg-accent/10 text-accent-ink';
    default:
      return 'border-line bg-surface-2 text-faint';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StatusPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHealth = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetch('/api/v1/health');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body: HealthResponse = await res.json();
      setData(body);
      setError(null);
      setLastChecked(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch health data');
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  // Initial fetch + polling interval.
  useEffect(() => {
    fetchHealth();
    intervalRef.current = setInterval(() => fetchHealth(), POLL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth]);

  // ---- Loading skeleton ----
  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
          System Status
        </span>
        <div className="mt-5 h-10 w-64 animate-pulse rounded-lg bg-surface-2" />
        <div className="mt-4 h-5 w-96 animate-pulse rounded bg-surface-2" />
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-line bg-surface-2"
            />
          ))}
        </div>
      </div>
    );
  }

  // ---- Error state ----
  if (error && !data) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
          System Status
        </span>
        <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
          Unable to load status
        </h1>
        <div className="mt-6 rounded-xl border border-danger/25 bg-danger/10 p-6">
          <p className="text-sm text-danger">Could not reach the health endpoint: {error}</p>
          <button
            type="button"
            onClick={() => fetchHealth(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent"
          >
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      {/* ---- Header ---- */}
      <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
        System Status
      </span>

      <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
        Indexer health
      </h1>
      <p className="mt-2 text-muted">
        Real-time freshness of Stenion&rsquo;s scoring pipeline, powered by{' '}
        <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-mono text-accent-ink">
          GET /api/v1/health
        </code>
      </p>

      {/* ---- Overall status banner ---- */}
      <div className={cn('mt-8 rounded-2xl border p-6 sm:p-8', statusBgClass(data.status))}>
        <div className="flex items-center gap-3">
          {/* Status indicator dot */}
          <span className="relative flex h-3.5 w-3.5">
            {data.status === 'healthy' && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-safe opacity-60 motion-reduce:animate-none" />
            )}
            <span
              className={cn(
                'relative inline-flex h-3.5 w-3.5 rounded-full',
                data.status === 'healthy' && 'bg-safe',
                data.status === 'degraded' && 'bg-warn',
                data.status === 'down' && 'bg-danger',
              )}
            />
          </span>
          <h2
            className={cn(
              'font-display text-2xl font-semibold capitalize',
              statusColorClass(data.status),
            )}
          >
            {data.status}
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {statusSummary(data.status, data.thresholdMinutes)}
        </p>
        <p className="mt-2 text-xs text-faint">
          Staleness threshold: {data.thresholdMinutes} minutes
        </p>
      </div>

      {/* ---- Per-protocol cards ---- */}
      <h2 className="mt-12 font-display text-xl font-semibold text-ink">Per-protocol freshness</h2>
      <p className="mt-1 text-sm text-muted">
        Each protocol&rsquo;s most recent indexer run and scoring status.
      </p>

      {data.protocols.length === 0 ? (
        <div className="mt-6 rounded-xl border border-line surface-lit p-8 text-center">
          <Activity className="mx-auto h-8 w-8 text-faint" strokeWidth={1.5} />
          <p className="mt-3 text-sm text-muted">
            No protocols registered. The indexer has not run yet.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {data.protocols.map((protocol) => {
            const current = isCurrent(protocol, data.thresholdMinutes);
            return (
              <div
                key={protocol.id}
                className="rounded-xl border border-line surface-lit p-5 transition-colors"
              >
                {/* Protocol ID + status pill */}
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display text-base font-semibold text-ink">{protocol.id}</h3>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium',
                      runStatusPillClass(protocol.lastRunStatus),
                    )}
                  >
                    {protocol.lastRunStatus === 'ok' && (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-safe opacity-60 motion-reduce:animate-none" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-safe" />
                      </span>
                    )}
                    {protocol.lastRunStatus ?? 'never run'}
                  </span>
                </div>

                {/* Detail rows */}
                <dl className="mt-4 space-y-2.5 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-muted">Last success</dt>
                    <dd
                      className="text-right font-mono text-xs text-ink"
                      title={formatIso(protocol.lastSuccessfulRunAt)}
                    >
                      {relativeTime(protocol.lastSuccessfulRunAt)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-muted">Last run</dt>
                    <dd
                      className="text-right font-mono text-xs text-ink"
                      title={formatIso(protocol.lastRunAt)}
                    >
                      {relativeTime(protocol.lastRunAt)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-muted">Staleness</dt>
                    <dd
                      className={cn(
                        'text-right font-mono text-xs font-semibold',
                        stalenessClass(protocol.staleMinutes, data.thresholdMinutes),
                      )}
                    >
                      {protocol.staleMinutes !== null
                        ? `${protocol.staleMinutes}m`
                        : 'never scored'}
                    </dd>
                  </div>
                </dl>

                {/* Current / stale indicator bar */}
                <div
                  className={cn(
                    'mt-4 rounded-md px-3 py-1.5 text-center text-xs font-medium',
                    current
                      ? 'border border-safe/20 bg-safe/8 text-safe-ink'
                      : 'border border-danger/20 bg-danger/8 text-danger-ink',
                  )}
                >
                  {current ? 'Current' : 'Stale'}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Footer metadata row ---- */}
      <div className="mt-10 flex flex-col gap-4 border-t border-line-soft pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => fetchHealth(true)}
            disabled={refreshing}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent disabled:opacity-50',
              refreshing && 'cursor-wait',
            )}
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            Refresh
          </button>
          {lastChecked && (
            <span className="text-xs text-faint">
              Last checked {relativeTime(lastChecked.toISOString())}
              {' · '}auto-refreshes every 30s
            </span>
          )}
        </div>
        <a
          href="/api/v1/health"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-accent-ink hover:underline"
        >
          View raw JSON <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}
