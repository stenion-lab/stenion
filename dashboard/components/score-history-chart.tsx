'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useMemo, useRef, useState } from 'react';
import type { HistoryEntry } from '../app/lib/contract';
import {
  bandColor,
  bandLabel,
  formatDuration,
  formatUtcDay,
  formatUtcRange,
  formatUtcTime,
  scoreBand,
} from '../app/lib/format';
import { buildScoreSeries, timeTicks, type SeriesPoint } from '../app/lib/score-series';

const EASE = [0.16, 1, 0.3, 1] as const;

// A fixed viewBox rather than a measured container width: the SVG scales with
// `w-full h-auto`, so it needs no ResizeObserver, reserves its exact height on
// first paint, and renders identically before hydration. That removes the whole
// class of "chart pops in after measuring" layout shift.
const VW = 760;
const VH = 260;
const PAD = { top: 18, right: 16, bottom: 30, left: 36 };
const X0 = PAD.left;
const X1 = VW - PAD.right;
const Y0 = PAD.top;
const Y1 = VH - PAD.bottom;

// The y-axis is pinned to the full 0–100 scale, never fitted to the data.
// Auto-scaling would make a 53→54 blip look as violent as a 21→46 swing and
// would collapse entirely on a protocol whose score hasn't moved. 0–100 is a
// methodology invariant; the axis reflects it. Gridlines sit on the band
// boundaries from `scoreBand` so the axis labels teach the colour ramp.
const Y_TICKS = [0, 34, 67, 100];
const BANDS = [
  { from: 0, to: 34, color: 'var(--color-danger)' },
  { from: 34, to: 67, color: 'var(--color-warn)' },
  { from: 67, to: 100, color: 'var(--color-safe)' },
];

export function ScoreHistoryChart({ history }: { history: HistoryEntry[] }) {
  const reduce = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const series = useMemo(() => buildScoreSeries(history), [history]);
  const { points, failures, segments, breaks, domain, medianIntervalMs } = series;

  const span = domain.end - domain.start;
  const scaleX = (t: number) => X0 + ((t - domain.start) / span) * (X1 - X0);
  const scaleY = (s: number) => Y1 - (Math.max(0, Math.min(100, s)) / 100) * (Y1 - Y0);

  const ticks = useMemo(() => timeTicks(domain.start, domain.end), [domain.start, domain.end]);

  if (history.length === 0) {
    return (
      <div className="rounded-xl border border-line surface-lit p-8 text-center text-sm text-muted">
        No runs recorded yet — the score history appears once this protocol has been indexed.
      </div>
    );
  }

  const latest = points[points.length - 1];
  const activePoint = active === null ? null : (points[active] ?? null);
  const shown = activePoint ?? latest ?? null;

  const scores = points.map((p) => p.score);
  const lo = scores.length > 0 ? Math.min(...scores) : null;
  const hi = scores.length > 0 ? Math.max(...scores) : null;

  const summary =
    points.length === 0
      ? `Safety score history: ${failures.length} runs, all failed, no score to plot.`
      : `Safety score over time on a fixed 0 to 100 axis. ${points.length} scored ` +
        `${points.length === 1 ? 'run' : 'runs'} between ${formatUtcRange(
          new Date(domain.start).toISOString(),
          new Date(domain.end).toISOString(),
        )}, ranging ${lo} to ${hi}, latest ${latest.score}.` +
        (failures.length > 0 ? ` ${failures.length} failed runs are shown as gaps.` : '') +
        (breaks.some((b) => b.kinds.includes('methodology'))
          ? ' The line is broken where the scoring methodology changed.'
          : '');

  function moveActive(delta: number) {
    if (points.length === 0) return;
    setActive((prev) => {
      const from = prev ?? points.length - 1;
      return Math.max(0, Math.min(points.length - 1, from + delta));
    });
  }

  function handlePointer(e: React.PointerEvent) {
    const el = svgRef.current;
    if (!el || points.length === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    // The viewBox maps linearly onto the rendered width, so pointer x converts
    // to a user-space x without any measurement of the plot itself.
    const userX = ((e.clientX - rect.left) / rect.width) * VW;
    const t = domain.start + ((userX - X0) / (X1 - X0)) * span;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.t - t);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setActive(best);
  }

  return (
    <figure className="m-0">
      <div
        tabIndex={0}
        role="group"
        aria-label="Safety score history chart. Use the left and right arrow keys to step through runs."
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            moveActive(-1);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            moveActive(1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            setActive(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            setActive(points.length - 1);
          } else if (e.key === 'Escape') {
            setActive(null);
          }
        }}
        onBlur={() => setActive(null)}
        className="relative rounded-xl border border-line surface-lit p-2 outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VW} ${VH}`}
          className="h-auto w-full touch-none"
          role="img"
          aria-label={summary}
          onPointerMove={handlePointer}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            {/* Hatching marks stretches where no run exists at all — visually
                distinct from a low score, which is the whole point. */}
            <pattern
              id="stenion-gap-hatch"
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--color-line)" strokeWidth="1.5" />
            </pattern>
          </defs>

          {/* Band tint. This reuses the semantic score ramp, which globals.css
              reserves for encoding data — legitimate here because that is
              exactly what it is doing: showing which band a score sits in. */}
          {BANDS.map((b) => (
            <rect
              key={b.from}
              x={X0}
              y={scaleY(b.to)}
              width={X1 - X0}
              height={scaleY(b.from) - scaleY(b.to)}
              fill={b.color}
              opacity={0.05}
            />
          ))}

          {Y_TICKS.map((v) => (
            <g key={v}>
              <line
                x1={X0}
                y1={scaleY(v)}
                x2={X1}
                y2={scaleY(v)}
                stroke="var(--color-line)"
                strokeWidth={1}
                opacity={v === 0 ? 1 : 0.55}
              />
              <text
                x={X0 - 8}
                y={scaleY(v) + 3.5}
                textAnchor="end"
                className="score-num"
                fontSize={11}
                fill="var(--color-faint)"
              >
                {v}
              </text>
            </g>
          ))}

          {ticks.map(({ t, step }, i) => {
            const x = scaleX(t);
            const prev = ticks[i - 1];
            const dayChanged =
              prev === undefined || new Date(prev.t).getUTCDate() !== new Date(t).getUTCDate();
            const label =
              step >= 86_400_000
                ? formatUtcDay(t)
                : dayChanged
                  ? `${formatUtcDay(t)} ${formatUtcTime(t)}`
                  : formatUtcTime(t);
            const anchor = x < X0 + 34 ? 'start' : x > X1 - 34 ? 'end' : 'middle';
            return (
              <g key={t}>
                <line
                  x1={x}
                  y1={Y0}
                  x2={x}
                  y2={Y1}
                  stroke="var(--color-line-soft)"
                  strokeWidth={1}
                />
                <text
                  x={anchor === 'start' ? X0 : anchor === 'end' ? X1 : x}
                  y={Y1 + 16}
                  textAnchor={anchor}
                  className="tnum"
                  fontSize={11}
                  fill="var(--color-faint)"
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* Stretches with no data, hatched rather than bridged. */}
          {breaks
            .filter((b) => b.kinds.includes('gap') || b.kinds.includes('failure'))
            .map((b) => (
              <rect
                key={`gap-${b.at}`}
                x={scaleX(b.from)}
                y={Y0}
                width={Math.max(2, scaleX(b.to) - scaleX(b.from))}
                height={Y1 - Y0}
                fill="url(#stenion-gap-hatch)"
                opacity={0.5}
              />
            ))}

          {/* Methodology break: the brand accent, and deliberately the ONLY
              accent-coloured thing in this chart. It annotates the rulebook —
              it is not a safety reading, so it must not come from the score
              ramp. The score line itself is neutral for the same reason in
              reverse: the accent marks, it never encodes a data value. */}
          {breaks
            .filter((b) => b.kinds.includes('methodology'))
            .map((b) => (
              <g key={`mv-${b.at}`}>
                <line
                  x1={scaleX(b.at)}
                  y1={Y0 - 4}
                  x2={scaleX(b.at)}
                  y2={Y1}
                  stroke="var(--color-accent)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  opacity={0.85}
                />
                <text
                  x={scaleX(b.at)}
                  y={Y0 - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill="var(--color-accent-ink)"
                >
                  v{b.fromVersion}→v{b.toVersion}
                </text>
              </g>
            ))}

          {/* Failed runs sit on the baseline as a marker, never at y=0 on the
              score scale — "we don't know" must not look like "scored zero". */}
          {failures.map((f) => (
            <g key={`f-${f.runAt}`}>
              <line
                x1={scaleX(f.t)}
                y1={Y1}
                x2={scaleX(f.t)}
                y2={Y1 - 12}
                stroke="var(--color-danger)"
                strokeWidth={1.5}
              />
              <circle cx={scaleX(f.t)} cy={Y1} r={2.5} fill="var(--color-danger)" />
            </g>
          ))}

          {segments.map((seg, i) =>
            seg.length === 1 ? (
              // A lone point is not a path — `M x y` with no line-to draws
              // nothing at all. Render the dot instead.
              <circle
                key={`s-${i}`}
                cx={scaleX(seg[0].t)}
                cy={scaleY(seg[0].score)}
                r={3.5}
                fill="var(--color-muted)"
              />
            ) : (
              <motion.path
                key={`s-${i}`}
                d={seg
                  .map((p, j) => `${j === 0 ? 'M' : 'L'}${scaleX(p.t)},${scaleY(p.score)}`)
                  .join(' ')}
                fill="none"
                stroke="var(--color-muted)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 1.1, ease: EASE, delay: 0.05 * i }}
              />
            ),
          )}

          {/* Latest point, in its band colour — the same reading as the hero
              ring, and (with the band tints behind it) what actually carries
              the score reading now that the line itself is neutral. */}
          {latest && (
            <circle
              cx={scaleX(latest.t)}
              cy={scaleY(latest.score)}
              r={4}
              fill={bandColor(scoreBand(latest.score))}
              stroke="var(--color-bg)"
              strokeWidth={1.5}
              style={{ filter: `drop-shadow(0 0 5px ${bandColor(scoreBand(latest.score))}60)` }}
            />
          )}

          {activePoint && (
            <g>
              <line
                x1={scaleX(activePoint.t)}
                y1={Y0}
                x2={scaleX(activePoint.t)}
                y2={Y1}
                stroke="var(--color-ink)"
                strokeWidth={1}
                opacity={0.28}
              />
              <circle
                cx={scaleX(activePoint.t)}
                cy={scaleY(activePoint.score)}
                r={4.5}
                fill="var(--color-ink)"
                stroke="var(--color-bg)"
                strokeWidth={1.5}
              />
            </g>
          )}

          {points.length === 0 && (
            <text
              x={(X0 + X1) / 2}
              y={(Y0 + Y1) / 2}
              textAnchor="middle"
              fontSize={13}
              fill="var(--color-muted)"
            >
              No successful runs to plot
            </text>
          )}
        </svg>

        {shown && (
          <Tooltip
            point={shown}
            x={scaleX(shown.t)}
            y={scaleY(shown.score)}
            pinned={!activePoint}
          />
        )}

        <div aria-live="polite" className="sr-only">
          {activePoint
            ? `${formatUtcRange(activePoint.runAt, activePoint.runAt)}, score ${
                activePoint.score
              }, methodology version ${activePoint.methodologyVersion}.`
            : ''}
        </div>
      </div>

      <Legend
        hasFailures={failures.length > 0}
        hasMethodologyBreak={breaks.some((b) => b.kinds.includes('methodology'))}
        hasGap={breaks.some((b) => b.kinds.includes('gap'))}
      />

      <figcaption className="mt-3 text-xs leading-relaxed text-faint">
        {points.length > 0 && (
          <>
            {/* Derived from the rows actually returned, never asserted. The 50-row
                cap spans ~4h at the current 5-minute cadence, but it has spanned
                three days across an indexer outage — so the window is measured. */}
            Showing {history.length} {history.length === 1 ? 'run' : 'runs'} ·{' '}
            {formatUtcRange(
              new Date(domain.start).toISOString(),
              new Date(domain.end).toISOString(),
            )}{' '}
            · {formatDuration(domain.end - domain.start)}
            {medianIntervalMs !== null && (
              <> · typically every {formatDuration(medianIntervalMs)}</>
            )}
          </>
        )}
      </figcaption>
    </figure>
  );
}

function Tooltip({
  point,
  x,
  y,
  pinned,
}: {
  point: SeriesPoint;
  x: number;
  y: number;
  pinned: boolean;
}) {
  const frac = x / VW;
  const shift = frac < 0.18 ? '-8%' : frac > 0.82 ? '-92%' : '-50%';
  // Flip below the point near the top of the plot, otherwise a high score pushes
  // the tooltip out through the top of the card.
  const high = y < Y0 + (Y1 - Y0) * 0.25;
  return (
    <div
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-line bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-lg"
      style={{
        left: `${frac * 100}%`,
        top: `${(y / VH) * 100}%`,
        transform: `translate(${shift}, ${high ? '30%' : '-130%'})`,
        opacity: pinned ? 0.85 : 1,
      }}
    >
      <span
        className="score-num font-semibold"
        style={{ color: bandColor(scoreBand(point.score)) }}
      >
        {point.score}
      </span>
      <span className="ml-1.5 text-faint">{bandLabel(scoreBand(point.score))}</span>
      <div className="tnum mt-0.5 text-faint">
        {formatUtcDay(point.t)} {formatUtcTime(point.t)} UTC · methodology v
        {point.methodologyVersion}
      </div>
    </div>
  );
}

function Legend({
  hasFailures,
  hasMethodologyBreak,
  hasGap,
}: {
  hasFailures: boolean;
  hasMethodologyBreak: boolean;
  hasGap: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-4 rounded-full bg-muted" /> safety score
      </span>
      {hasFailures && (
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-0.5 rounded-full bg-danger" /> failed run — no score, not a zero
        </span>
      )}
      {hasGap && (
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border border-line bg-line/40" /> no data
        </span>
      )}
      {hasMethodologyBreak && (
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-0.5 rounded-full" style={{ background: 'var(--color-accent)' }} />{' '}
          methodology change — scores either side aren&rsquo;t comparable
        </span>
      )}
    </div>
  );
}
