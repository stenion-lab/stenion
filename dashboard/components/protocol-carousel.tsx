'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeaderboardEntry } from '../app/lib/contract';
import { copiesPerSet, frameDelta, nextOffset, wrapOffset } from '../app/lib/carousel';
import { cn } from '../app/lib/cn';
import { ScoreRing } from './score-ring';
import { ProtocolLogo } from './protocol-logo';
import { DeploymentBadge } from './deployment-badge';
import { OperationalBadge } from './operational-badge';
import { StatusPill } from './status-pill';

/**
 * The homepage's live-score strip, as a continuously drifting marquee.
 *
 * IT SHOWS EVERY SCORED PROTOCOL, not the top three. The strip previously cut
 * the list at three and the cut was invisible — a reader had no way to tell a
 * truncated strip from a complete registry, which for a page whose whole claim
 * is coverage is the wrong thing to leave ambiguous. Scrolling removes the need
 * to choose.
 *
 * WHY THIS IS A rAF LOOP AND NOT A CSS `@keyframes translateX`. A keyframe
 * marquee is cheaper and pauses trivially, but the transform it animates is not
 * a scroll position: the moment the reader wants to drag the row themselves,
 * the animation and the drag become two independent sources of truth for where
 * the track sits, and reconciling them means reading the animation's current
 * transform and rebasing it on every interaction. Driving the container's own
 * `scrollLeft` instead means manual scrolling — wheel, trackpad, touch, drag,
 * keyboard — is just the browser doing what it already does, and the auto-drift
 * is one more writer of the same value. The cost is a `scrollLeft` write per
 * frame, which is a scroll, not a layout.
 *
 * The seam is arithmetic, and it lives in app/lib/carousel.ts with its tests.
 */

/** How long after the reader stops touching it before the drift resumes. */
const RESUME_MS = 900;
/** Pointer travel past which a mouse gesture is a drag, not a click. */
const DRAG_THRESHOLD_PX = 6;
/**
 * How far the live `scrollLeft` may sit from our own float before we conclude
 * the reader moved it. Above a frame's travel (~0.6px) so rounding can't be
 * mistaken for input; below anything a human gesture produces.
 */
const ADOPT_PX = 2;

export function ProtocolCarousel({ protocols }: { protocols: LeaderboardEntry[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLDivElement>(null);

  /**
   * Copies of the list inside ONE set — measured, not assumed. Starts at 1 so
   * the server's markup and the first client render agree; the effect below
   * raises it if one copy does not cover the viewport.
   */
  const [copies, setCopies] = useState(1);
  const [reduced, setReduced] = useState(false);

  const pausedRef = useRef(false);
  const resumeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The last offset WE wrote, so a scroll event can be attributed. */
  const writtenRef = useRef(-1);

  const resumeLater = useCallback(() => {
    if (resumeRef.current) clearTimeout(resumeRef.current);
    resumeRef.current = setTimeout(() => {
      pausedRef.current = false;
    }, RESUME_MS);
  }, []);

  const pause = useCallback(() => {
    if (resumeRef.current) clearTimeout(resumeRef.current);
    resumeRef.current = null;
    pausedRef.current = true;
  }, []);

  useEffect(
    () => () => {
      if (resumeRef.current) clearTimeout(resumeRef.current);
    },
    [],
  );

  // prefers-reduced-motion. Read on the client rather than in CSS because the
  // setting changes WHAT IS RENDERED here, not just whether it moves: with no
  // drift there is no seam to hide, so the duplicate set would only be a second
  // copy of the registry sitting in the DOM for a reader to scroll into.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Keep one set at least as wide as the viewport (see app/lib/carousel.ts).
  useEffect(() => {
    if (reduced) return;
    const scroller = scrollerRef.current;
    const set = setRef.current;
    if (!scroller || !set) return;
    const measure = () => {
      const base = set.offsetWidth / copies;
      const next = copiesPerSet(base, scroller.clientWidth);
      if (next !== copies) setCopies(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(set);
    return () => ro.disconnect();
  }, [copies, reduced, protocols.length]);

  // The drift.
  useEffect(() => {
    if (reduced) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let raf = 0;
    let last: number | null = null;
    // Our own float position. `scrollLeft` may be snapped to whole pixels by
    // the browser, and at 34px/sec a frame moves ~0.57px — round-tripping
    // through the DOM every frame could therefore round the entire step away
    // and leave the strip motionless. Keeping the float here and treating the
    // DOM as an output (except when the reader has moved it) is what makes the
    // speed independent of the device's scroll granularity.
    let pos: number | null = null;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = frameDelta(now, last);
      last = now;

      const setWidth = setRef.current?.offsetWidth ?? 0;
      if (setWidth <= 0) return;

      const actual = scroller.scrollLeft;
      if (pos === null || Math.abs(actual - pos) > ADOPT_PX) pos = actual;

      pos = pausedRef.current ? wrapOffset(pos, setWidth) : nextOffset(pos, dt, setWidth);

      // While paused, only ever write in order to wrap: writing the value it
      // already has is a no-op the browser can still treat as a scroll, which
      // is what kills touch momentum mid-flick.
      if (Math.abs(pos - actual) < 0.01) return;
      scroller.scrollLeft = pos;
      writtenRef.current = scroller.scrollLeft;
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  /**
   * Any scroll we did not cause is the reader browsing — wheel, trackpad, touch
   * fling, keyboard. Catching it here rather than only on pointer events is
   * what makes momentum work: each event of the fling pushes the resume timer
   * out, so the drift does not restart under a finger that has just let go.
   */
  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (Math.abs(scroller.scrollLeft - writtenRef.current) <= ADOPT_PX) return;
    pause();
    resumeLater();
  }, [pause, resumeLater]);

  // --- Mouse drag. Touch already drags natively; this gives the mouse the same
  // affordance without turning the row into a custom scroller.
  const dragRef = useRef<{ startX: number; startLeft: number; moved: boolean } | null>(null);
  /**
   * Set when a drag passed the threshold, so the click the browser emits at the
   * end of that drag can be swallowed before it reaches the card's <Link>.
   * Below the threshold nothing is set and the click navigates — a tap is a tap.
   */
  const suppressClickRef = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      suppressClickRef.current = false;
      pause();
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      dragRef.current = { startX: e.clientX, startLeft: scroller.scrollLeft, moved: false };
    },
    [pause],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag || !scroller) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      // Capture so the drag survives the pointer leaving the row, and kill text
      // selection for its duration only — a permanent `select-none` would make
      // the cards' text unselectable for everyone.
      scroller.setPointerCapture(e.pointerId);
      scroller.style.userSelect = 'none';
    }
    const setWidth = setRef.current?.offsetWidth ?? 0;
    scroller.scrollLeft = wrapOffset(drag.startLeft - dx, setWidth);
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      const scroller = scrollerRef.current;
      if (drag?.moved) {
        suppressClickRef.current = true;
        if (scroller?.hasPointerCapture(e.pointerId)) scroller.releasePointerCapture(e.pointerId);
      }
      if (scroller) scroller.style.userSelect = '';
      resumeLater();
    },
    [resumeLater],
  );

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Under reduced motion this is a plain horizontal list: one set, one copy.
  const setCount = reduced ? 1 : 2;
  const copyCount = reduced ? 1 : copies;

  return (
    <div
      className="edge-fade-x no-scrollbar overflow-x-auto overscroll-x-contain"
      ref={scrollerRef}
      onScroll={onScroll}
      onPointerEnter={pause}
      onPointerLeave={resumeLater}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={onClickCapture}
      onFocusCapture={pause}
      onBlurCapture={resumeLater}
      // Focusable and labelled: with the drift paused this is a real scroll
      // region, and a keyboard reader gets arrow keys on it for free.
      tabIndex={0}
      role="group"
      aria-label="Live protocol scores"
    >
      {/* `w-max` on both rows: a flex row inside a scroller would otherwise be
          sized to the scroller and wrap its children instead of overflowing.
          `py-2` leaves room for the cards' hover lift — a horizontal scroller
          clips vertically whether you ask it to or not. */}
      <div className="flex w-max py-2">
        {Array.from({ length: setCount }, (_, setIndex) => (
          <div
            key={setIndex}
            ref={setIndex === 0 ? setRef : undefined}
            className="flex w-max shrink-0"
            // The trailing set is the same cards again. They stay clickable —
            // they are on screen as much as the originals are — but they are
            // out of the tab order and out of the accessibility tree, so a
            // screen reader is read the registry once.
            aria-hidden={setIndex > 0 || undefined}
          >
            {Array.from({ length: copyCount }, (_, copyIndex) =>
              protocols.map((p, i) => (
                <CarouselCard
                  key={`${setIndex}-${copyIndex}-${p.id}`}
                  protocol={p}
                  // Spreads the border sheen around its loop so a row of
                  // synchronised lights does not read as a mechanism. Indexed
                  // by position in the strip, not by protocol, so neighbours
                  // always differ.
                  sheenDelay={(copyIndex * protocols.length + i) * -3}
                  duplicate={setIndex > 0}
                />
              )),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * TWO ROWS, not one axis. The shape is a consequence of the row scrolling.
 *
 * The card started as the three-up grid's landscape box — ring left, everything
 * else stacked to its right — and a queue of wide short cards drifting sideways
 * reads badly: a card that wide spends most of its travel only partly on
 * screen, so the reader is usually looking at a fragment rather than a card.
 * The opposite extreme, a fully stacked portrait card, fixes that and reads
 * worse: a 104px ring above a centered column leaves tall empty flanks and the
 * row turns into a picket fence.
 *
 * So: the ring and the identity sit SIDE BY SIDE (they are read together — a
 * number means nothing without the name), and the badges get their own
 * full-width row underneath (they are a footnote to both). That lands the card
 * near 3:2 — narrow enough to cross the strip mostly whole, wide enough that
 * the ring has something to sit beside.
 *
 * Everything else is deliberately untouched: same ring at the same 104px, same
 * logo, same chain label, same badge pills, same border / surface / sheen /
 * hover.
 */
function CarouselCard({
  protocol: p,
  sheenDelay,
  duplicate,
}: {
  protocol: LeaderboardEntry;
  sheenDelay: number;
  duplicate: boolean;
}) {
  return (
    // The gutter is padding on the wrapper rather than a flex `gap`, and that is
    // load-bearing: `gap` puts space BETWEEN items only, so the last card of a
    // set would butt straight against the first card of the next one and the
    // seam would be a visible tightening every lap. As padding, every card
    // contributes exactly `width` to the set, including the last.
    //
    // The width is FIXED, not content-derived: cards carry different numbers of
    // badges, and a shrink-to-fit width would make the row's rhythm depend on
    // which protocols happen to be deployed on someone else's contracts.
    <div className="w-[300px] shrink-0 pr-4 sm:w-[316px]">
      <Link
        href={`/protocol/${p.id}`}
        aria-label={`${p.name}, Chain: ${p.chain}, Safety score: ${p.safetyScore ?? 'unscored'} out of 100`}
        style={{ '--sheen-delay': `${sheenDelay}s` } as React.CSSProperties}
        tabIndex={duplicate ? -1 : undefined}
        // `h-full` on a flex item in a stretch row: every card takes the height
        // of the tallest, so a card whose badges wrap lengthens the whole row
        // rather than standing proud of its neighbours.
        className={cn(
          'border-sheen group flex h-full flex-col rounded-xl border border-line surface-lit p-5',
          'transition-all hover:-translate-y-0.5 hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        )}
      >
        <div className="flex items-center gap-4">
          {/* Unchanged size and stroke. The card was sized around the ring, not
              the other way round — it is the one thing here a reader is meant to
              register from across the row. `shrink-0` because the ring's size is
              an inline style, which is a flex-basis and not a floor: the text
              beside it would otherwise squash it. */}
          <ScoreRing
            score={p.safetyScore}
            size={104}
            stroke={8}
            label={null}
            className="shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ProtocolLogo name={p.name} logo={p.logo} size={24} />
              <div className="truncate font-display text-lg font-semibold text-ink">{p.name}</div>
            </div>
            <div className="mt-1 text-xs uppercase tracking-wider text-faint">{p.chain}</div>
          </div>
        </div>

        {/* Badges get the card's full width rather than the column beside the
            ring, which is what lets the freshness pill and a deployment label
            sit on ONE line at this width — so every card is the same height and
            the pill is at the same offset on all of them, whatever else a card
            carries. A market on another protocol's contracts carries the same
            label here as everywhere else its name appears. */}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <StatusPill lastRunStatus={p.lastRunStatus} hasScore={p.safetyScore !== null} />
          <DeploymentBadge deployedOn={p.deployedOn} />
          <OperationalBadge operationalState={p.operationalState} />
        </div>
      </Link>
    </div>
  );
}
