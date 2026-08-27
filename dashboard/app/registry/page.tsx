import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, CircleSlash, ServerCrash, ShieldCheck } from 'lucide-react';
import { getProtocols, type LeaderboardEntry } from '../lib/api';
import { bandTextClass, formatTimestamp, freshness, scoreBand } from '../lib/format';
import {
  COVERAGE_STATUS_META,
  COVERAGE_STATUS_ORDER,
  coverageToPublish,
  groupCoverage,
  type CoverageEntry,
} from '../lib/coverage';
import {
  CATEGORY_LABELS,
  buildRegistryView,
  parseRegistryParams,
  registryHref,
  type RegistryParams,
  type RegistryView,
} from '../lib/registry-query';
import { cn } from '../lib/cn';
import { FreshnessTooltip, StatusPill } from '../../components/status-pill';
import { MarkAttribution, ProtocolLogo } from '../../components/protocol-logo';
import { DeploymentBadge } from '../../components/deployment-badge';
import { OperationalBadge } from '../../components/operational-badge';
import { RegistryControls } from '../../components/registry-controls';
import { ScoreBar } from '../../components/score-bar';
import { Reveal, RevealGroup, RevealItem } from '../../components/reveal';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Protocol registry',
  // Mentions coverage as well as ranking because the unscored entries are the
  // discovery path for someone searching a protocol name: the search snippet
  // should reflect that this page answers "why isn't X here", not only "what
  // scores best".
  description:
    'Search every protocol Stenion tracks, ranked purely by on-chain safety score — plus the protocols we assessed and do not score, with the reason for each. Free, public, payment-blind.',
};

/**
 * Grid template for the ranked table, with and without the rank column.
 *
 * Two constants rather than a conditional prefix because the header row and
 * every body row must agree, and a template assembled in two places is a
 * template that eventually disagrees with itself.
 */
const GRID_RANKED = 'md:grid-cols-[3rem_1fr_8rem_10rem_11rem]';
const GRID_UNRANKED = 'md:grid-cols-[1fr_8rem_10rem_11rem]';

/**
 * The page header: the claim on the left, the qualifications beside it.
 *
 * TWO ROWS, NOT TWO COLUMNS OF EQUALS. The eyebrow and the heading span the
 * full width on their own row; the split happens underneath them, so the notes
 * begin on the same line as the intro paragraph they qualify rather than
 * floating up alongside the heading. Row spacing is the grid's `gap-y`, which
 * is why the intro carries no top margin of its own.
 *
 * The split is `lg` and not `md`: at 768px two columns leave the intro about
 * 22rem wide, which is narrower than the single-column measure it replaces.
 * Below the breakpoint the grid is a plain stack, so the reading order is the
 * DOM order — eyebrow, heading, intro, then the notes.
 */
const HEADER_GRID = 'grid gap-x-12 gap-y-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]';

/**
 * The subordinate column.
 *
 * The rule does the demoting: a left border on wide viewports, a top border on
 * narrow ones, so the notes read as annotations of the intro in both layouts
 * rather than as three paragraphs of equal weight stacked.
 *
 * `line`, NOT `line-soft`. This rule sits on the page ground, and in light mode
 * `line-soft` (#e3def6) is *lighter* than `bg` (#e0d9f6) — so it reads as a
 * white line drawn on the page rather than as a separator. That token is tuned
 * for card grounds, where `surface` (#ebe8f9) is the lightest step and
 * `line-soft` correctly sits below it. `line` is darker than the ground in
 * light mode and lighter than it in dark, which is what a rule on the page
 * needs; it is the token the section divider below already uses.
 */
const HEADER_NOTES =
  'space-y-3 border-t border-line pt-5 text-sm leading-relaxed text-faint ' +
  'lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0';

export default async function RegistryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  let protocols: LeaderboardEntry[] | null = null;
  let errored = false;
  try {
    protocols = await getProtocols();
  } catch {
    errored = true;
  }

  // Derived from what was actually fetched, never assumed. The note below
  // explains a category of row, so it may only appear when the board really
  // contains one — otherwise it describes members that aren't there, which is a
  // worse failure than saying nothing: a reader looks for the labelled row,
  // doesn't find it, and learns the copy can't be trusted.
  //
  // It matters because the two can genuinely come apart. The registry renders
  // from the database, and a `deployedOn` entry only lands there once an indexer
  // cycle has upserted it — so between deploying a new pool config and the first
  // cycle that runs it, the code knows about a market the board does not. Same
  // for a pool later removed from BLEND_POOLS, or one whose row is present but
  // never scored.
  const hasDeployedEntries = (protocols ?? []).some((p) => p.deployedOn !== null);

  // Same discipline, applied to the unscored entries: filtered against the board
  // we actually fetched rather than against what coverage.ts believes. A market
  // that has since been registered must not appear in both places, and the guard
  // that prevents that cannot be the config file contradicting itself.
  //
  // On the error path this is the full list, deliberately — those entries are
  // static and stay true when the database is down, and ErrorState already tells
  // the reader the live data is unavailable.
  const published = coverageToPublish((protocols ?? []).map((p) => p.id));

  // Only statuses with published members are offered as filters, on the same
  // rule that drops empty headings: a filter selecting nothing describes members
  // that aren't there.
  const availableStatuses = COVERAGE_STATUS_ORDER.filter((status) =>
    published.some((entry) => entry.status === status),
  );

  // Same rule again, for categories: only the ones the board actually contains
  // are offered, so the filter can never select an empty view. Derived from the
  // data rather than from the ProtocolCategory union, because a category with a
  // rulebook but no scored market yet is a filter that finds nothing.
  const availableCategories = [...new Set((protocols ?? []).map((p) => p.category))].sort();

  const params = parseRegistryParams(sp, availableStatuses, availableCategories);
  const view = buildRegistryView(protocols ?? [], published, params);

  const filtering = params.q !== '' || params.status !== 'all' || params.category !== 'all';

  // Both notes are conditional on their subject existing, so the second column
  // can be empty — and an empty column would leave the lead sentence in a 1.4fr
  // cell for no reason, i.e. the narrow-text-beside-dead-space this layout
  // exists to remove. No notes, no split.
  const hasHeaderNotes = hasDeployedEntries || published.length > 0;

  return (
    <div className="mx-auto max-w-6xl px-5 py-14">
      <Reveal className={cn(hasHeaderNotes && HEADER_GRID)}>
        <div className={cn(hasHeaderNotes && 'lg:col-span-2')}>
          <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
            Ranked by safety score · payment-blind
          </span>
          <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
            Protocol registry
          </h1>
        </div>

        {/* Deliberately a size up from the notes beside it. This is the page's
            claim — the ranking is on-chain and unbuyable — and it was previously
            set at the same weight as the two clarifications stacked under it,
            which is what made the column read as an undifferentiated block of
            text. */}
        <p className="max-w-2xl text-lg leading-relaxed text-muted">
          Every protocol Stenion tracks, ordered by its live safety score — higher is safer. Ranking
          is derived purely from on-chain data; no protocol can pay to move up. Open a protocol to
          see the full factor breakdown behind its number.
        </p>

        {hasHeaderNotes && (
          <div className={HEADER_NOTES}>
            {/* Said once at the top rather than only per-row: a reader who scans
                the list and leaves should know that a row is not necessarily a
                distinct protocol, even if they never hover the badge that says
                which. Conditional, because a standing claim about "some entries"
                with no such entry on the board is a promise the page doesn't
                keep. */}
            {hasDeployedEntries && (
              <p>
                Some entries are individual markets running another protocol&rsquo;s contracts
                rather than protocols in their own right. Those are labelled on the row, and scored
                on their own reserves, oracle and admin like any other entry.
              </p>
            )}
            {/* The unscored entries are no longer a section at the bottom of a
                long page, so this is a filter link rather than a jump link — it
                changes the URL, which means it is also the shape someone can
                share. Still conditional on there being members. */}
            {published.length > 0 && (
              <p>
                {published.length === 1 ? 'One protocol we' : `${published.length} protocols we`}{' '}
                assessed and don&rsquo;t score {published.length === 1 ? 'appears' : 'appear'} here
                too, marked as such and never ranked.{' '}
                <Link
                  href={registryHref({ status: 'not-scored' })}
                  className="font-medium text-accent-ink underline-offset-4 hover:underline"
                >
                  See just those
                </Link>
                .
              </p>
            )}
          </div>
        )}
      </Reveal>

      <Reveal delay={0.04} className="mt-8">
        <RegistryControls
          params={params}
          coverageStatuses={availableStatuses.map((status) => ({
            value: status,
            label: COVERAGE_STATUS_META[status].heading,
          }))}
          categories={availableCategories.map((category) => ({
            value: category,
            label: CATEGORY_LABELS[category],
          }))}
        />
        <ResultSummary view={view} params={params} filtering={filtering} />
      </Reveal>

      {errored && <ErrorState />}

      {view.counts.total === 0 ? (
        filtering ? (
          <NoResults params={params} />
        ) : (
          !errored && <EmptyState />
        )
      ) : view.mode === 'alphabetical' ? (
        <AlphabeticalList view={view} />
      ) : (
        <RankedView view={view} filtering={filtering} />
      )}

      {/* Covers BOTH kinds of row. The unscored entries carry marks and links
          exactly as scored ones do, so the same note has to apply to them — and
          it renders on the error path too, where they still show marks and the
          table doesn't. */}
      <MarkAttribution className="mt-12 max-w-7xl border-t border-line-soft pt-6" />
    </div>
  );
}

/**
 * What the current view contains, in words.
 *
 * It exists because the counts are the fastest way to see that "not scored" is
 * a category rather than a bad score: "3 scored · 3 assessed, not scored" says
 * the second group is a real thing we publish, before a reader has looked at a
 * single row. Under a search it also names the query back, so a result set with
 * one row in it is obviously a filtered view rather than the whole registry.
 */
function ResultSummary({
  view,
  params,
  filtering,
}: {
  view: RegistryView;
  params: RegistryParams;
  filtering: boolean;
}) {
  const { ranked, pending, coverage, total } = view.counts;
  if (total === 0 && !filtering) return null;

  const parts: string[] = [];
  if (ranked > 0) parts.push(`${ranked} scored`);
  if (pending > 0) parts.push(`${pending} awaiting a first score`);
  if (coverage > 0) parts.push(`${coverage} assessed, not scored`);

  return (
    <p
      aria-live="polite"
      aria-atomic="true"
      className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-faint"
    >
      <span className="tnum">{parts.join(' · ') || 'No entries'}</span>
      {params.q !== '' && (
        <span>
          matching <span className="font-medium text-muted">&ldquo;{params.q}&rdquo;</span>
        </span>
      )}
      {filtering && (
        <Link
          href="/registry"
          className="font-medium text-accent-ink underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
        >
          Clear
        </Link>
      )}
    </p>
  );
}

/**
 * The default shape: a ranked table, then the protocols with no score yet, then
 * the ones we assessed and don't score.
 *
 * THE ORDER OF THE BLOCKS IS THE ARGUMENT. Anything inside a ranked list
 * participates in the ranking claim — a row with a dash in the `#` column still
 * reads as "last". So neither of the two lower blocks is a row in the table
 * above; each is separately headed, and neither renders a numeral where a score
 * would be.
 */
function RankedView({ view, filtering }: { view: RegistryView; filtering: boolean }) {
  const groups = groupCoverage(view.coverage);

  // The heading is conditional on there being something to distinguish. With
  // one category on the board the block IS the ranking, and a "Lending" label
  // over it would answer a question nobody could have — the same rule that
  // drops an empty coverage heading, applied to a redundant one.
  const showCategoryHeadings = view.rankedGroups.length > 1;

  return (
    <>
      {view.rankedGroups.map((group, groupIndex) => (
        <Reveal
          key={group.category}
          delay={0.05}
          trigger="mount"
          className={cn(groupIndex === 0 ? 'mt-8' : 'mt-12')}
        >
          {/* Each category is its own ranked list, numbered from 1 inside
              itself. Two categories' scores come from two rulebooks, so one
              sequence spanning both — and a `#` counting across them — would
              assert a comparison nothing computed. */}
          {showCategoryHeadings && (
            <h2 className="mb-4 font-display text-lg font-semibold tracking-tight text-ink">
              {CATEGORY_LABELS[group.category]}
            </h2>
          )}

          {/* header row (desktop) */}
          <div
            className={cn(
              'hidden gap-4 border-b border-line px-4 pb-3 text-xs uppercase tracking-wider text-faint md:grid',
              view.showRank ? GRID_RANKED : GRID_UNRANKED,
            )}
          >
            {/* The rank column exists only where a rank is real. Under
                score-asc row one is the LOWEST score, and under name it is
                alphabetical — printing "01" in either case asserts a standing
                the row doesn't have. Removed, not blanked: a dash in a rank
                column is the same ambiguity as a dash in a score column. */}
            {view.showRank && <span>#</span>}
            <span>Protocol</span>
            <span>Chain</span>
            <span>Safety score</span>
            <span>Freshness</span>
          </div>

          <RevealGroup className="divide-y divide-line-soft" stagger={0.05} trigger="mount">
            {group.entries.map((p, i) => (
              <RevealItem key={p.id}>
                <ProtocolRow entry={p} rank={view.showRank ? i + 1 : null} barIndex={i} />
              </RevealItem>
            ))}
          </RevealGroup>
        </Reveal>
      ))}

      {view.pending.length > 0 && <PendingBlock entries={view.pending} />}

      {groups.length > 0 && <CoverageSection groups={groups} filtering={filtering} />}
    </>
  );
}

/**
 * Protocols we track that have no score yet.
 *
 * THE THIRD STATE, and the reason it has its own block. `safetyScore: null` on
 * a `protocols` row means our pipeline has not produced a number — not that we
 * decided against scoring it, and not that it scored badly. It cannot go in the
 * ranked table (there is nothing to rank it on) and it must not be folded in
 * with the coverage entries below, because that would tell a reader we made a
 * decision we haven't made.
 *
 * These rows keep their protocol page: the page exists, it just has no factors
 * yet, and it says so.
 */
function PendingBlock({ entries }: { entries: LeaderboardEntry[] }) {
  return (
    <Reveal delay={0.05} trigger="mount" className="mt-10">
      <div className="border-t border-dashed border-line pt-6">
        <h2 className="font-display text-lg font-semibold text-ink">Awaiting a first score</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Tracked and queued, with no completed scoring run yet. This is a gap in <em>our</em>{' '}
          pipeline rather than anything about the protocol, and it is not a decision not to score —
          those are further down. Unranked, because there is no number to rank.
        </p>
        <RevealGroup className="mt-4 divide-y divide-line-soft" stagger={0.05} trigger="mount">
          {entries.map((p, i) => (
            <RevealItem key={p.id}>
              <ProtocolRow entry={p} rank={null} barIndex={i} />
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </Reveal>
  );
}

/**
 * Protocols and markets we assessed and do not score.
 *
 * NOT ONE NUMERAL RENDERS IN HERE. That is the load-bearing requirement: a
 * reader must never mistake "not scored" for "scored badly". The chip that
 * stands where a scored row has its number is a phrase, in the neutral grey
 * register, and `coverage.test.ts` asserts no status chip contains a digit.
 *
 * THE ROWS ARE COMPACT AND LINK THROUGH. They used to carry the full reasoning
 * inline, which worked at four entries and would not have worked at eleven. The
 * summary sentence is still server-rendered here — find-in-page and indexing
 * are how someone looking for a specific protocol reaches this at all — and the
 * full reasoning, the contract, the verify path and the date live on the
 * entry's own page at /coverage/<id>.
 */
function CoverageSection({
  groups,
  filtering,
}: {
  groups: { status: CoverageEntry['status']; entries: CoverageEntry[] }[];
  filtering: boolean;
}) {
  const total = groups.reduce((n, g) => n + g.entries.length, 0);

  return (
    <section id="not-scored" className="mt-14 scroll-mt-24">
      {/* `mount`, like everything else below the controls: this whole section
          appears and disappears with the filter, so an in-view trigger that has
          already fired would leave it invisible on the render that brings it
          back. See RevealGroup's note. */}
      <Reveal trigger="mount">
        <div className="border-t border-line pt-8">
          <div className="flex items-center gap-2">
            <CircleSlash className="h-4 w-4 text-faint" aria-hidden="true" />
            <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
              Assessed, and not scored
            </h2>
          </div>
          <p className="mt-3 max-w-2xl text-muted">
            {total === 1 ? 'One protocol we' : `${total} protocols and markets we`} looked at and
            don&rsquo;t publish a score for
            {filtering ? ' that match this view' : ''}. None of these has a safety score — not a low
            one, not a zero. They are unranked and cannot be compared with the entries above.
          </p>
          {/* More load-bearing than the trademark note at the foot of the page: a
              protocol's own mark sitting beside a decision not to score it is a
              different kind of statement than a mark beside a score, and leaving
              that to legal boilerplate would waste it. */}
          <p className="mt-2 max-w-2xl text-sm text-faint">
            Listing a protocol here is a statement about Stenion&rsquo;s coverage, not a criticism
            of the protocol. Open one to see what we found and how you can check it yourself.
          </p>
        </div>
      </Reveal>

      <div className="mt-8 space-y-10">
        {groups.map((group, gi) => {
          const meta = COVERAGE_STATUS_META[group.status];
          return (
            <Reveal key={group.status} delay={0.05 + gi * 0.05} trigger="mount">
              <h3 className="font-display text-lg font-semibold text-ink">{meta.heading}</h3>
              <p className="adapter-prose mt-2 max-w-3xl text-sm leading-relaxed text-muted">
                {meta.blurb}
              </p>

              <RevealGroup
                className="mt-4 divide-y divide-line-soft"
                stagger={0.06}
                trigger="mount"
              >
                {group.entries.map((entry) => (
                  <RevealItem key={entry.id}>
                    <CoverageRow entry={entry} chip={meta.chip} />
                  </RevealItem>
                ))}
              </RevealGroup>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

/**
 * One unscored entry, compact, linking to its own page.
 *
 * It is a <Link> now, where it used to be an <article>: /coverage/<id> is
 * served entirely from the static coverage module and never touches the API, so
 * giving these a page costs neither of the two things that ruled out
 * /protocol/<id> — an id the dashboard renders and the API 404s on, or a second
 * shape out of getProtocolDetail. The per-entry anchor stays so links that
 * already point at /registry#not-scored-<id> keep landing on the row.
 */
function CoverageRow({ entry, chip }: { entry: CoverageEntry; chip: string }) {
  return (
    <Link
      id={`not-scored-${entry.id}`}
      href={`/coverage/${entry.id}`}
      className="group grid scroll-mt-24 grid-cols-1 gap-2 rounded-xl px-4 py-4 transition-colors hover:bg-surface/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg md:grid-cols-[1fr_14rem] md:items-center md:gap-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        {/* Same tile as a scored row. The point of listing these is that they
            are real protocols we assessed, and a reader recognises a mark
            faster than a name. Entries with no self-hosted mark get the
            initials tile — a designed state, not a gap. */}
        <ProtocolLogo name={entry.name} logo={entry.logo} size={32} className="mt-0.5" />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="font-display text-base font-semibold text-ink">{entry.name}</span>
            <ArrowUpRight
              className="h-3.5 w-3.5 text-faint transition duration-200 ease-out group-hover:text-accent-ink motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
              aria-hidden="true"
            />
          </span>
          {/* Server-rendered, always open, never behind a disclosure: this
              sentence is what find-in-page and a search engine index, and it is
              how someone looking for this protocol arrives at all. */}
          <span className="adapter-prose mt-1 block text-sm leading-relaxed text-muted">
            {entry.summary}
          </span>
        </span>
      </div>

      {/* The right column carries the chip AND the action. A column holding one
          small pill against fourteen rems of nothing reads as an unfinished
          layout, and the row's whole purpose is that there is more to read —
          naming that is both the fill and the affordance. */}
      <div className="flex items-center gap-2 pl-11 md:flex-col md:items-end md:gap-1.5 md:pl-0">
        <CoverageChip chip={chip} />
        <span className="inline-flex items-center gap-1 text-xs font-medium text-faint transition-colors group-hover:text-accent-ink">
          Why we don&rsquo;t score it
          <ArrowRight
            className="h-3 w-3 transition-transform motion-safe:group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </Link>
  );
}

/**
 * The phrase that stands where a scored row has its number.
 *
 * Deliberately the same neutral grey as freshnessPillClass('unscored') — never
 * a band colour, which would say "this protocol is dangerous" when it means "we
 * don't publish a number for it".
 *
 * The classes are repeated rather than imported from format.ts on purpose: that
 * function styles FRESHNESS, a statement about our pipeline's data age. This is
 * a third thing, and coupling them would drag a future change to one into the
 * other. What must not drift is the rule, not the string: no band colour, no
 * numeral.
 */
function CoverageChip({ chip, className }: { chip: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-faint',
        className,
      )}
    >
      <CircleSlash className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      {chip}
    </span>
  );
}

/**
 * Name order — the one sort allowed to put both kinds in a single list.
 *
 * Alphabetical order asserts nothing about quality, so an unscored entry
 * between two scored ones is not being ranked below either. There is no rank
 * column at all here, and each row still carries the thing that says which kind
 * it is: a number and a freshness pill, or a coverage chip and a summary.
 */
function AlphabeticalList({ view }: { view: RegistryView }) {
  const hasCoverage = view.merged.some((row) => row.kind === 'coverage');

  return (
    <Reveal delay={0.05} trigger="mount" className="mt-8">
      {hasCoverage && (
        // Full width, matching the table it sits above rather than the prose
        // measure: a banner that stops two thirds of the way across reads as a
        // callout floating beside the list instead of a caption on it.
        <p className="mb-5 rounded-lg border border-line bg-surface-2/60 px-4 py-3 text-sm leading-relaxed text-muted">
          <span className="font-medium text-ink">Sorted A–Z, so nothing here is ranked.</span> The
          list mixes protocols we score with ones we assessed and don&rsquo;t. An entry marked{' '}
          <span className="whitespace-nowrap font-medium text-faint">not scored</span> has no safety
          score at all — not a low one, not a zero — and its row links to why.
        </p>
      )}

      <div
        className={cn(
          'hidden gap-4 border-b border-line px-4 pb-3 text-xs uppercase tracking-wider text-faint md:grid',
          GRID_UNRANKED,
        )}
      >
        <span>Protocol</span>
        <span>Chain</span>
        <span>Safety score</span>
        <span>Freshness</span>
      </div>

      <RevealGroup className="divide-y divide-line-soft" stagger={0.04} trigger="mount">
        {view.merged.map((row, i) => (
          <RevealItem key={`${row.kind}-${row.entry.id}`}>
            {row.kind === 'scored' ? (
              <ProtocolRow entry={row.entry} rank={null} barIndex={i} />
            ) : (
              <MergedCoverageRow entry={row.entry} />
            )}
          </RevealItem>
        ))}
      </RevealGroup>
    </Reveal>
  );
}

/**
 * An unscored entry inside the merged list, on the same grid as a scored row.
 *
 * Sharing the grid is what makes the difference legible: the chip lands exactly
 * where the number would, so the eye comparing that column down the page reads
 * "phrase, not figure" rather than having to notice a different layout. The
 * chain cell is empty rather than guessed — a coverage entry has no chain we
 * measured, and Templar's lending state isn't on Stellar at all.
 */
function MergedCoverageRow({ entry }: { entry: CoverageEntry }) {
  const meta = COVERAGE_STATUS_META[entry.status];
  return (
    <Link
      id={`not-scored-${entry.id}`}
      href={`/coverage/${entry.id}`}
      className={cn(
        'group grid scroll-mt-24 grid-cols-1 gap-3 rounded-xl px-4 py-5 transition-colors hover:bg-surface/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg md:items-center md:gap-4',
        GRID_UNRANKED,
      )}
    >
      <div className="flex items-start gap-2">
        <ProtocolLogo name={entry.name} logo={entry.logo} size={36} className="mr-1 mt-0.5" />
        <span className="flex min-w-0 flex-col items-start">
          <span className="flex items-center gap-2">
            <span className="font-display text-lg font-semibold text-ink">{entry.name}</span>
            <ArrowUpRight
              className="h-4 w-4 text-faint transition duration-200 ease-out group-hover:text-accent-ink motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
              aria-hidden="true"
            />
          </span>
          <span className="adapter-prose mt-1 block text-sm leading-relaxed text-muted">
            {entry.summary}
          </span>
        </span>
      </div>

      <div className="hidden text-sm text-faint md:block" aria-hidden="true" />

      <div>
        <CoverageChip chip={meta.chip} />
      </div>

      {/* Where a scored row shows its freshness and run time, this shows what
          kind of row it is and where it goes. Same column, same weight, so the
          merged list has no gap in it — and the difference between the two
          kinds stays readable straight down that column. */}
      <div className="text-xs leading-snug text-faint">
        Coverage note · not a score
        <span className="mt-1 flex items-center gap-1 font-medium transition-colors group-hover:text-accent-ink">
          Why we don&rsquo;t score it
          <ArrowRight
            className="h-3 w-3 transition-transform motion-safe:group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </Link>
  );
}

function ProtocolRow({
  entry,
  rank,
  barIndex = 0,
}: {
  entry: LeaderboardEntry;
  rank: number | null;
  /** position in the rendered list, used only to stagger the score-bar fills */
  barIndex?: number;
}) {
  const band = scoreBand(entry.safetyScore);
  const fresh = freshness(entry.lastRunStatus, entry.safetyScore !== null);
  // A failed last run has to be visible while SCANNING, not only on the row you
  // happen to read: the row itself carries an accent rule and a faint accent
  // wash, so the exception is findable without comparing timestamps. Accent,
  // never a band colour — see freshnessPillClass.
  const stale = fresh.tone === 'stale';

  return (
    <Link
      href={`/protocol/${entry.id}`}
      aria-label={
        rank !== null
          ? `Rank ${rank}: ${entry.name}, Chain: ${entry.chain}, Safety score: ${entry.safetyScore ?? 'unscored'} out of 100`
          : `${entry.name}, Chain: ${entry.chain}, Safety score: ${entry.safetyScore ?? 'unscored'} out of 100`
      }
      className={cn(
        'group grid grid-cols-1 gap-3 rounded-xl px-4 py-5 transition-colors hover:bg-surface/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg md:items-center md:gap-4',
        rank === null ? GRID_UNRANKED : GRID_RANKED,
        stale && 'bg-accent/5 shadow-[inset_3px_0_0_0_var(--color-accent)] hover:bg-accent/9',
      )}
    >
      {rank !== null && (
        <div className="tnum hidden text-sm text-faint md:block" aria-hidden="true">
          {String(rank).padStart(2, '0')}
        </div>
      )}

      <div className="flex items-center gap-2">
        {rank !== null && (
          <span className="tnum mr-1 text-sm text-faint md:hidden" aria-hidden="true">
            {String(rank).padStart(2, '0')}
          </span>
        )}
        {/* Mark first, then the name as text — the logo is an aid to scanning,
            never the identifier. A row stays fully readable with images off.

            The tilt and the arrow's nudge are `motion-safe:` rather than plain
            hover states: they're decoration, so under prefers-reduced-motion the
            row still highlights and the arrow still recolours, with nothing
            moving. */}
        <ProtocolLogo
          name={entry.name}
          logo={entry.logo}
          size={36}
          className="mr-1 transition-transform duration-200 ease-out motion-safe:group-hover:-rotate-6"
        />
        {/* Name and deployment label stack, so the label sits with the name it
            qualifies rather than trailing off to the right where a narrow
            viewport would wrap it away from its subject. */}
        <span className="flex min-w-0 flex-col items-start">
          <span className="flex items-center gap-2">
            <span className="font-display text-lg font-semibold text-ink">{entry.name}</span>
            <ArrowUpRight
              className="h-4 w-4 text-faint transition duration-200 ease-out group-hover:text-accent-ink motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
              aria-hidden="true"
            />
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <DeploymentBadge deployedOn={entry.deployedOn} />
            {/* Beside the name, on the row, for the reason the whole
                publish-don't-score decision rests on: a reader who scans the
                registry and leaves must not have seen only the number. */}
            <OperationalBadge operationalState={entry.operationalState} />
          </span>
        </span>
      </div>

      <div className="text-sm text-muted">
        <span className="text-xs uppercase tracking-wider text-faint md:hidden">Chain: </span>
        {entry.chain}
      </div>

      <div
        aria-label={
          entry.safetyScore !== null
            ? `Safety score: ${entry.safetyScore} out of 100`
            : 'Safety score unavailable'
        }
      >
        <div className="flex items-baseline gap-2">
          <span className={`score-num text-2xl font-semibold ${bandTextClass(band)}`}>
            {entry.safetyScore ?? '—'}
          </span>
          <span className="text-xs text-faint" aria-hidden="true">
            / 100
          </span>
        </div>
        {/* The bar now fills on arrival, staggered down the list. It is the one
            element on the row that shows the score as a position on a scale
            rather than as a figure, and animating it is what makes three rows
            read as a ranking. See ScoreBar for the reduced-motion behaviour. */}
        <ScoreBar score={entry.safetyScore} index={barIndex} className="mt-1.5 max-w-[9rem]" />
      </div>

      {/* `relative` anchors the tooltip; the tooltip itself reveals on hover or
          keyboard focus of the row (this whole cell's `group` is the <Link>). */}
      <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill lastRunStatus={entry.lastRunStatus} hasScore={entry.safetyScore !== null} />
        {/* The always-visible half of the explanation. A tooltip alone would
            leave a touch user with nothing but the word "failed". */}
        {stale && (
          <span className="w-full text-xs leading-snug text-muted">
            {entry.safetyScore !== null ? 'showing last good score' : 'no score to show'}
          </span>
        )}
        {/* Shown at EVERY width now, not just on mobile. On desktop this column
            was a small pill against eleven rems of nothing, which read as an
            unfinished layout; the run time is the information that column is
            actually about, and the page's whole claim is that these numbers are
            recent. It is the real `lastRunAt`, so it says something different
            per row rather than filling space. */}
        <span className="tnum w-full text-xs leading-snug text-faint">
          {formatTimestamp(entry.lastRunAt)}
        </span>
        {stale && <FreshnessTooltip text={fresh.explanation} />}
      </div>
    </Link>
  );
}

/**
 * A search or filter that matched nothing.
 *
 * The wording is the point. "No results" would be fine; "Stenion has no entry
 * for X" is what is actually true, and it is different from "X does not exist"
 * — which is what a bare empty state on a registry implies. A protocol we have
 * never assessed is a gap in our coverage, not a verdict on the protocol.
 */
function NoResults({ params }: { params: RegistryParams }) {
  return (
    <div className="mt-10 rounded-xl border border-line surface-lit p-10 text-center">
      <CircleSlash className="mx-auto h-8 w-8 text-faint" />
      <h2 className="mt-4 font-display text-lg font-semibold text-ink">
        {params.q ? (
          <>Nothing in the registry matches &ldquo;{params.q}&rdquo;</>
        ) : (
          <>Nothing matches this filter</>
        )}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        {params.q
          ? 'That means Stenion has no entry under that name — either we have not assessed it, or it goes by a different one here. It is not a statement about the protocol.'
          : 'No entry currently falls into this category.'}
      </p>
      <p className="mt-4">
        <Link
          href="/registry"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-ink underline-offset-4 hover:underline"
        >
          Show the whole registry
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 rounded-xl border border-line surface-lit p-10 text-center">
      <ShieldCheck className="mx-auto h-8 w-8 text-accent" />
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
        The ranked registry is served from the Stenion API, which appears to be unavailable right
        now. This is a data-availability issue, not a scoring change — try again shortly. The
        coverage entries below are static and unaffected.
      </p>
    </div>
  );
}
