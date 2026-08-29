// Types come from ./contract, not ./api: this module is imported by client
// components, and ./api is server-only. A type-only import would be erased
// either way, but importing from the contract keeps that from being a footgun
// the day someone needs a value from here.
import type { OperationalLevel, RunStatus } from './contract';

/** Compact ISO-ish timestamp → readable UTC, e.g. "2026-08-11 13:24 UTC". */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())} UTC`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "07:20" (UTC). */
export function formatUtcTime(t: number | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** "14 Aug" (UTC). */
export function formatUtcDay(t: number | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * Compact elapsed span: "45m", "4h 5m", "3d 2h". Used for spans measured from
 * real data — never to assert a window we assume but haven't checked.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return 'under a minute';
  // Rounds rather than floors: the indexer's real 4m59s median spacing floors
  // to "every 4m", which understates a cadence the product markets as 5-minute.
  const total = Math.round(ms / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/**
 * A UTC range label, collapsing the end to a bare time when both ends fall on
 * the same UTC day: "14 Aug 07:20 → 11:25 UTC", else "11 Aug 11:23 → 14 Aug 11:25 UTC".
 */
export function formatUtcRange(startIso: string, endIso: string): string {
  const a = new Date(startIso);
  const b = new Date(endIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '—';
  const sameDay =
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
  const left = `${formatUtcDay(a)} ${formatUtcTime(a)}`;
  const right = sameDay ? formatUtcTime(b) : `${formatUtcDay(b)} ${formatUtcTime(b)}`;
  return `${left} → ${right} UTC`;
}

/**
 * Freshness — how current the number on screen is. Deliberately a SEPARATE
 * vocabulary from the score bands below.
 *
 * The displayed score is always the latest *ok* run; `lastRunAt`/`lastRunStatus`
 * describe the newest run of any status (see the staleness model in
 * ARCHITECTURE.md). When the newest run failed, the score on screen is the last
 * one we computed successfully — an age problem in OUR pipeline, not a risk
 * finding about the protocol. `explanation` exists so the UI never has to make
 * the reader infer that distinction from the word "stale".
 *
 * Tone names are `live`/`stale`/`unscored` rather than ok/warn/none so they
 * can't be mistaken for — or quietly wired to — the risk bands.
 */
export type FreshnessTone = 'live' | 'stale' | 'unscored';

export interface Freshness {
  /** Short pill text. Must stay short enough for the registry's freshness column. */
  label: string;
  tone: FreshnessTone;
  /** Plain-English expansion of `label`, for a tooltip or a notice. */
  explanation: string;
}

export function freshness(lastRunStatus: RunStatus | null, hasScore: boolean): Freshness {
  if (lastRunStatus === null) {
    return {
      label: 'never run',
      tone: 'unscored',
      explanation:
        'Stenion has not completed a scoring run for this protocol yet, so there is no score to show. This says nothing about the protocol — it is a gap in our coverage.',
    };
  }

  if (lastRunStatus === 'failed') {
    return hasScore
      ? {
          label: 'update failed',
          tone: 'stale',
          explanation:
            'The score shown is the last one Stenion computed successfully; our most recent attempt to refresh it failed, so the number may be out of date. This is a problem with our data collection, not a change in the protocol’s risk.',
        }
      : {
          label: 'update failed',
          tone: 'stale',
          explanation:
            'Our most recent attempt to score this protocol failed, and there is no earlier successful run to fall back on — so there is no score to show. This is a gap in our data, not a risk finding.',
        };
  }

  return {
    label: 'live',
    tone: 'live',
    explanation: 'The most recent indexer run succeeded, so this score is current.',
  };
}

/**
 * Pill classes for a freshness tone.
 *
 * `stale` and `unscored` use the ACCENT and the neutral greys respectively, and
 * must never use `safe`/`warn`/`danger`: those are the score bands and mean risk
 * level. A stale marker in amber or red would tell a reader the protocol is
 * dangerous when it means our data is old. `dashboard/app/lib/format.test.ts`
 * enforces that mechanically — don't "unify" these with `bandTextClass`.
 *
 * `live` keeps the `safe` band: green-as-a-heartbeat is a different claim from
 * green-as-a-score, and no band colour is being borrowed to describe a fault.
 */
export function freshnessPillClass(tone: FreshnessTone): string {
  switch (tone) {
    case 'live':
      // See the `*-ink` note in globals.css: the label needs `safe-ink`, not
      // `safe`, to clear AA on the /10 tint in light mode.
      return 'border-safe/25 bg-safe/10 text-safe-ink';
    case 'stale':
      return 'border-accent/40 bg-accent/10 text-accent-ink';
    default:
      return 'border-line bg-surface-2 text-faint';
  }
}

/**
 * Pill classes and wording for an operational level.
 *
 * NO SCORE BAND, EVER — the same non-negotiable that governs
 * `freshnessPillClass` above, and for a sharper reason. `safe`/`warn`/`danger`
 * mean risk level, and operational state is precisely the thing Stenion
 * publishes WITHOUT grading: a pause can be an admin containing a threat or a
 * market being abandoned, and nothing on chain tells the two apart
 * (METHODOLOGY.md, "Operational state is published, never scored"). Dressing
 * "withdrawals halted" in `danger` would make the page assert the verdict the
 * methodology explicitly declines to reach. `format.test.ts` enforces this
 * mechanically.
 *
 * Accent is out too: the dashboard already spends accent on freshness ("our data
 * is old"), and a second accent-toned marker on the same row would blur a
 * distinction that took work to draw.
 *
 * So prominence comes from WEIGHT, not hue. The two levels that constrain a
 * reader's own capital — no new deposits, or no withdrawals at all — get ink
 * text and a stronger border; the milder ones sit in the same quiet register as
 * the deployment badge. The words do the work: "Withdrawals halted" is not a
 * sentence a reader skims past because it is grey.
 */
export function operationalPillClass(level: OperationalLevel): string {
  switch (level) {
    case 'exitDisabled':
    case 'entryDisabled':
      return 'border-ink/30 bg-surface-2 text-ink';
    default:
      return 'border-line bg-surface-2 text-muted';
  }
}

/**
 * The label for an operational level, naming the RESTRICTION rather than the
 * protocol's own term.
 *
 * A reader comparing two rows should not have to know that Blend says "On-Ice"
 * and K2 says "paused" — those vocabularies do not map onto each other, which is
 * the whole reason the shared level exists. Each protocol's own wording is still
 * published verbatim in the state's `source` and `detail`.
 *
 * `active` deliberately has no label: nothing renders for it. Labelling the
 * ordinary state turns the exception into noise, and an "all operations
 * available" pill would read as a safety endorsement — exactly the claim this
 * whole mechanism refuses to make.
 */
export function operationalLabel(level: Exclude<OperationalLevel, 'active'>): string {
  switch (level) {
    case 'borrowingDisabled':
      return 'Borrowing disabled';
    // Names what stopped AND what did not, because for an AMM the second half is
    // the part a reader would otherwise assume wrongly: a halted market sounds
    // like trapped capital, and here it is not. "Trading halted" alone would
    // leave that to guesswork.
    case 'swapDisabled':
      return 'Trading halted, LP open';
    case 'entryDisabled':
      return 'Deposits & borrowing disabled';
    case 'exitDisabled':
      return 'Withdrawals halted';
    case 'notOperational':
      return 'Never opened';
  }
}

export type ScoreBand = 'high' | 'mid' | 'low' | 'none';

/** Coarse safety band for score coloring — purely visual, not part of scoring. */
export function scoreBand(score: number | null): ScoreBand {
  if (score === null) return 'none';
  if (score >= 67) return 'high';
  if (score >= 34) return 'mid';
  return 'low';
}

/** The CSS color value (theme token) for a band — used by SVG strokes/inline fills. */
export function bandColor(band: ScoreBand): string {
  switch (band) {
    case 'high':
      return 'var(--color-safe)';
    case 'mid':
      return 'var(--color-warn)';
    case 'low':
      return 'var(--color-danger)';
    default:
      return 'var(--color-faint)';
  }
}

/** Tailwind text-color class for a band. */
export function bandTextClass(band: ScoreBand): string {
  switch (band) {
    case 'high':
      return 'text-safe';
    case 'mid':
      return 'text-warn';
    case 'low':
      return 'text-danger';
    default:
      return 'text-faint';
  }
}

/** Short human label for a band, e.g. for a legend. */
export function bandLabel(band: ScoreBand): string {
  switch (band) {
    case 'high':
      return 'Lower risk';
    case 'mid':
      return 'Elevated risk';
    case 'low':
      return 'High risk';
    default:
      return 'Unscored';
  }
}
