// The registry's search, filter and sort — the whole of it, as pure functions.
//
// WHY IT IS A MODULE AND NOT INLINE IN THE PAGE. The rule this code exists to
// enforce is not a rendering detail: an unscored entry must never appear inside
// the ranked ordering, because a row's POSITION reads as a position no matter
// what its score column says. That rule is enforceable in a test only if the
// ordering is a value someone can assert on, rather than JSX. Everything the
// page renders comes out of buildRegistryView, so "does an unscored entry ever
// land inside the ranked list" is a question with an answer.
//
// THE SAME RULE, ONE LEVEL UP (#78): a position numeral is scoped to one
// category, and no ordering may put two categories' scores in one ranked
// sequence. Two scores are comparable only when the same rulebook produced
// them. That one is structural rather than tested-for — the view carries
// RankedCategoryGroups and no flat ranked array, so there is nowhere for a
// cross-category ranking to live.
//
// STATE LIVES IN THE URL, never in a component. A filtered or searched view has
// to be linkable and survive a reload, so these functions parse from and build
// back to query params, and the page is a Server Component that re-renders from
// them. The client control (components/registry-controls.tsx) only pushes new
// params; it never filters a list it is holding. That ordering matters for more
// than links: every reason, status and summary stays in the server-rendered
// HTML, which is how find-in-page and search indexing reach an entry at all.
//
// THIS MODULE IS A LEAF in the sense CLAUDE.md means: its only imports are
// TYPE-ONLY, so type stripping erases them and its test resolves no relative
// import graph. Keep it that way — a value import from ./coverage would make
// this file untestable under `node --test` without an extension dance.

import type { LeaderboardEntry, ProtocolCategory } from './contract';
import type { CoverageEntry, CoverageStatus } from './coverage';

/**
 * The three orderings, and the reason there are only three.
 *
 * `score-desc` is the registry's actual claim — protocols ranked by on-chain
 * safety, payment-blind. `score-asc` is the same claim read from the other end.
 * `name` is not a ranking at all, which is precisely why it is the one ordering
 * allowed to merge scored and unscored entries — or two categories' scores —
 * into a single list. See `merged` and `rankedGroups` on RegistryView.
 */
export const REGISTRY_SORTS = ['score-desc', 'score-asc', 'name'] as const;
export type RegistrySort = (typeof REGISTRY_SORTS)[number];

/**
 * Score, high to low.
 *
 * The default is the ranking because the ranking is what the registry IS — the
 * one thing it promises is an order derived purely from on-chain data that no
 * protocol can pay to move. Making that an opt-in view, behind any other
 * default, would quietly demote the product's only claim to a display option.
 */
export const DEFAULT_SORT: RegistrySort = 'score-desc';

/**
 * `all`, the two kinds, or one specific coverage status.
 *
 * One parameter rather than several, because these are mutually exclusive
 * facets of a single question ("what am I looking at"), and two independent
 * controls that can contradict each other produce empty result sets nobody
 * asked for. A coverage status implies not-scored, so it needs no companion.
 *
 * Note that `scored` means "in the ranked registry", which includes an entry
 * whose latest run never produced a number — see partitionScored. That entry is
 * OUR pipeline not having got there, and it belongs with the protocols we track
 * rather than with the ones we decided not to score. The UI labels the two
 * options accordingly: "Scored" and "Assessed, not scored".
 */
export type RegistryStatusFilter = 'all' | 'scored' | 'not-scored' | CoverageStatus;

export const DEFAULT_STATUS: RegistryStatusFilter = 'all';

/**
 * `all`, or one protocol category.
 *
 * A SEPARATE PARAMETER FROM `status`, unlike everything else on this page,
 * because it is not the same question. `status` asks what KIND of row you are
 * looking at (scored, awaiting a score, assessed-and-not-scored); `category`
 * asks which RULEBOOK produced the numbers you are looking at. The two compose
 * — "scored lending protocols" is a coherent view — where two spellings of the
 * status facet never could.
 *
 * It narrows the scored side only. A CoverageEntry carries no category at all,
 * so a category filter cannot match one, and showing coverage entries under
 * `?category=lending` would assert a categorisation we never made.
 */
export type RegistryCategoryFilter = 'all' | ProtocolCategory;

export const DEFAULT_CATEGORY: RegistryCategoryFilter = 'all';

/**
 * How a category is written where a reader sees it — a section heading above a
 * ranked block, or an option in the filter.
 *
 * Lives here rather than in the page because the control and the page must
 * agree, and because `Record<ProtocolCategory, string>` is the compile error
 * that finds this file when a category is added to the union.
 */
export const CATEGORY_LABELS: Record<ProtocolCategory, string> = {
  lending: 'Lending',
  // Matches `CATEGORY_FACTORS.dex.label` in core, which is also the heading of
  // its section in methodology/dex.md — one word for one category, wherever a
  // reader meets it. No entry carries this category yet.
  dex: 'Dex',
};

/** Query strings longer than this are a paste accident or an attack, not a search. */
const MAX_QUERY = 64;

/** What Next hands a Server Component for one search param. */
export type RawParam = string | string[] | undefined;

export interface RegistryParams {
  q: string;
  status: RegistryStatusFilter;
  category: RegistryCategoryFilter;
  sort: RegistrySort;
}

/** First value only — a repeated `?q=a&q=b` is malformed input, not a multi-search. */
function firstOf(raw: RawParam): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * Read the four params, falling back to the defaults for anything absent or
 * unrecognised.
 *
 * Unrecognised values fall back SILENTLY rather than 404ing: these params are
 * typed by hand and pasted between people, and a stale `?sort=score` from an
 * older link should show the registry, not an error page. The canonical URL is
 * restored by registryHref, which omits defaults. `?category=amm` gets the same
 * treatment as `?sort=score` deliberately — a category that doesn't exist yet
 * is exactly the stale link this rule was written for, and it needs no new
 * error path of its own.
 *
 * `coverageStatuses` and `categories` are passed in rather than imported so this
 * module keeps its type-only import graph. Both are the sets actually present in
 * the data, which also means a status or category with no members can't be
 * selected — the same rule as groupCoverage dropping empty groups.
 */
export function parseRegistryParams(
  raw: { q?: RawParam; status?: RawParam; category?: RawParam; sort?: RawParam },
  coverageStatuses: readonly string[],
  categories: readonly string[] = [],
): RegistryParams {
  const sortRaw = firstOf(raw.sort);
  const statusRaw = firstOf(raw.status);
  const categoryRaw = firstOf(raw.category);
  const valid: readonly string[] = ['all', 'scored', 'not-scored', ...coverageStatuses];

  return {
    q: firstOf(raw.q).trim().slice(0, MAX_QUERY),
    status: valid.includes(statusRaw) ? (statusRaw as RegistryStatusFilter) : DEFAULT_STATUS,
    category: categories.includes(categoryRaw)
      ? (categoryRaw as RegistryCategoryFilter)
      : DEFAULT_CATEGORY,
    sort: (REGISTRY_SORTS as readonly string[]).includes(sortRaw)
      ? (sortRaw as RegistrySort)
      : DEFAULT_SORT,
  };
}

/**
 * A linkable URL for a set of params, with defaults omitted.
 *
 * Omitting defaults is what keeps `/registry` the canonical address of the
 * registry: the unfiltered ranked view has one URL rather than three spellings
 * of itself, so a shared link, a bookmark and the nav item all agree.
 */
export function registryHref(params: Partial<RegistryParams>): string {
  const search = new URLSearchParams();
  const q = params.q?.trim() ?? '';
  if (q) search.set('q', q);
  if (params.status && params.status !== DEFAULT_STATUS) search.set('status', params.status);
  if (params.category && params.category !== DEFAULT_CATEGORY)
    search.set('category', params.category);
  if (params.sort && params.sort !== DEFAULT_SORT) search.set('sort', params.sort);
  const qs = search.toString();
  return qs ? `/registry?${qs}` : '/registry';
}

/**
 * Fold a string to something two spellings of the same name can be compared on:
 * lowercase, diacritics stripped, every run of non-alphanumerics collapsed to a
 * single space.
 *
 * The punctuation collapse is what makes an id searchable by its display name —
 * "k2 earn" and "K2-Earn" both fold to `k2 earn`, so someone typing what they
 * see finds the entry whose slug is hyphenated.
 */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does this entry match the query? Substring, over name and id.
 *
 * DELIBERATELY NOT matched: `deployedOn.host`. Searching "blend" and being
 * handed YieldBlox is useful, but a row that appears with no visible reason for
 * matching implies YieldBlox IS Blend — the exact thing the deployment label
 * exists to deny. It earns its place when the row can say why it matched, not
 * before.
 */
export function matchesQuery(entry: { id: string; name: string }, q: string): boolean {
  const needle = fold(q);
  if (!needle) return true;
  return fold(entry.name).includes(needle) || fold(entry.id).includes(needle);
}

/** Case-insensitive display-name order, stable across locales we render in. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

/**
 * Split the leaderboard into entries that have a number and entries that don't.
 *
 * THE THIRD STATE. A `protocols` row with `safetyScore: null` is not a coverage
 * decision and not a low score: it is our pipeline not having produced a number
 * yet. It cannot sit inside the ranked ordering (there is nothing to rank it
 * on) and it must not be folded in with the coverage entries (that would undo
 * the whole separation coverage.ts exists for), so it gets its own block
 * between them.
 */
export function partitionScored(entries: readonly LeaderboardEntry[]): {
  ranked: LeaderboardEntry[];
  pending: LeaderboardEntry[];
} {
  return {
    ranked: entries.filter((e) => e.safetyScore !== null),
    pending: entries.filter((e) => e.safetyScore === null),
  };
}

/**
 * Order the entries that actually carry a score. Ties break by name so the list
 * is stable between runs — two protocols on the same number should not swap
 * places because the database returned them in a different order.
 *
 * ONE CATEGORY'S ENTRIES AT A TIME. Comparing two scores is only meaningful
 * inside a rulebook, so callers reach this through groupRankedByCategory rather
 * than handing it the whole board.
 */
export function sortRanked(
  entries: readonly LeaderboardEntry[],
  sort: RegistrySort,
): LeaderboardEntry[] {
  const rows = [...entries];
  if (sort === 'name') return rows.sort(byName);
  const dir = sort === 'score-asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const delta = ((a.safetyScore ?? 0) - (b.safetyScore ?? 0)) * dir;
    return delta !== 0 ? delta : byName(a, b);
  });
}

/**
 * One category's scored entries, in the requested order — the unit a ranked
 * block is rendered from.
 *
 * THE SHAPE IS THE INVARIANT. A `safetyScore` is only comparable with another
 * one produced by the same rulebook: each category is scored on its own factors
 * under its own weights, so 54 in one category and 54 in another are two
 * different measurements wearing the same numeral. A ranked list that mixes
 * them, and a `#` numeral that counts across them, both assert a comparison
 * nothing computed. Rather than leave that to the sort function getting it right
 * — which is how it would come back the first time someone adds a sort — the
 * view has no flat ranked array at all. There is nowhere to put a cross-category
 * sequence, so no ordering can produce one.
 */
export interface RankedCategoryGroup {
  category: ProtocolCategory;
  /** ranked WITHIN this category — position i+1 is rank i+1 here, and nowhere else */
  entries: LeaderboardEntry[];
}

/**
 * Bucket scored entries by category, then order each bucket independently.
 *
 * The order of the GROUPS is alphabetical by category, and it deliberately says
 * nothing: sections are not ranked against each other, so the only requirement
 * on their order is that it is stable between renders — which rules out
 * "whatever order the database returned" and anything derived from the scores
 * inside, since either would read as a ranking of categories.
 */
export function groupRankedByCategory(
  entries: readonly LeaderboardEntry[],
  sort: RegistrySort,
): RankedCategoryGroup[] {
  const buckets = new Map<ProtocolCategory, LeaderboardEntry[]>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.category);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.category, [entry]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([category, rows]) => ({ category, entries: sortRanked(rows, sort) }));
}

/** A row in the merged, alphabetical view — tagged, because the two render differently. */
export type RegistryRow =
  { kind: 'scored'; entry: LeaderboardEntry } | { kind: 'coverage'; entry: CoverageEntry };

export interface RegistryView {
  /**
   * `ranked` renders a ranked block per category, then the two unranked blocks;
   * `alphabetical` renders one merged list. The distinction is load-bearing
   * rather than cosmetic — see `merged`.
   */
  mode: 'ranked' | 'alphabetical';
  /**
   * Scored entries carrying a number, grouped by category and ordered within
   * each group — never one flat sequence. See RankedCategoryGroup.
   */
  rankedGroups: RankedCategoryGroup[];
  /** tracked protocols with no score yet — never inside `ranked` */
  pending: LeaderboardEntry[];
  /** coverage entries that survived the filter, always by name */
  coverage: CoverageEntry[];
  /**
   * Every surviving row in one alphabetical list — populated ONLY in
   * `alphabetical` mode, and empty otherwise.
   *
   * Merging is safe here and nowhere else: alphabetical order asserts nothing
   * about quality, so an unscored entry sitting between two scored ones is not
   * being ranked below either, and a lending score above an AMM one is not being
   * called the better of the two. Under a score sort the same list would be a
   * ranking claim about entries that have no score, or about two numbers from
   * two rulebooks, which are the things this page may not do.
   */
  merged: RegistryRow[];
  /**
   * Whether a position numeral may be rendered at all.
   *
   * True only under `score-desc`. Under `score-asc` the first row is the LOWEST
   * score, so printing "01" beside it asserts a rank that is the reverse of the
   * truth; under `name` the position is alphabetical and means nothing. In both
   * cases the column is removed rather than blanked — a dash in a rank column is
   * the same ambiguity as a dash in a score column.
   *
   * Where a numeral IS printed it counts from 1 inside one RankedCategoryGroup,
   * because that is the only span over which it means anything.
   */
  showRank: boolean;
  counts: { ranked: number; pending: number; coverage: number; total: number };
}

/**
 * Everything the page renders, derived from the live board, the published
 * coverage entries, and the three URL params.
 *
 * `protocols` is already deduped against coverage by the caller
 * (coverageToPublish), so an entry that has since been scored cannot arrive
 * here twice.
 */
export function buildRegistryView(
  protocols: readonly LeaderboardEntry[],
  coverage: readonly CoverageEntry[],
  params: RegistryParams,
): RegistryView {
  const { q, status, category, sort } = params;

  const wantsScored = status === 'all' || status === 'scored';
  // A category filter narrows the scored side only — a coverage entry has no
  // category to match, and listing one under `?category=lending` would assert a
  // categorisation we never made. Same shape as a coverage status implying
  // not-scored, read from the other end.
  const wantsCoverage = status !== 'scored' && category === DEFAULT_CATEGORY;

  const matchedProtocols = wantsScored
    ? protocols.filter(
        (p) => matchesQuery(p, q) && (category === DEFAULT_CATEGORY || p.category === category),
      )
    : [];
  const matchedCoverage = wantsCoverage
    ? coverage.filter(
        (c) =>
          matchesQuery(c, q) &&
          (status === 'all' || status === 'not-scored' || c.status === status),
      )
    : [];

  const { ranked, pending } = partitionScored(matchedProtocols);
  const rankedGroups = groupRankedByCategory(ranked, sort);
  // Pending rows are name-ordered in every mode. There is no score to sort them
  // by, and reversing them under score-asc would imply the order meant
  // something.
  const sortedPending = [...pending].sort(byName);
  const sortedCoverage = [...matchedCoverage].sort(byName);

  const mode = sort === 'name' ? 'alphabetical' : 'ranked';
  const merged: RegistryRow[] =
    mode === 'alphabetical'
      ? [
          // The one place two categories' scored entries share a sequence, and
          // the reason it is allowed: A–Z is not an ordering anyone can read a
          // comparison out of.
          ...rankedGroups.flatMap((group) =>
            group.entries.map((entry) => ({ kind: 'scored' as const, entry })),
          ),
          ...sortedPending.map((entry) => ({ kind: 'scored' as const, entry })),
          ...sortedCoverage.map((entry) => ({ kind: 'coverage' as const, entry })),
        ].sort((a, b) => byName(a.entry, b.entry))
      : [];

  const rankedCount = rankedGroups.reduce((n, group) => n + group.entries.length, 0);

  return {
    mode,
    rankedGroups,
    pending: sortedPending,
    coverage: sortedCoverage,
    merged,
    showRank: sort === 'score-desc',
    counts: {
      ranked: rankedCount,
      pending: sortedPending.length,
      coverage: sortedCoverage.length,
      total: rankedCount + sortedPending.length + sortedCoverage.length,
    },
  };
}
