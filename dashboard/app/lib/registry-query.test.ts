import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CATEGORY,
  DEFAULT_SORT,
  REGISTRY_SORTS,
  buildRegistryView,
  groupRankedByCategory,
  matchesQuery,
  parseRegistryParams,
  partitionScored,
  registryHref,
  sortRanked,
  type RegistryParams,
  type RegistryView,
} from './registry-query.ts';
import type { LeaderboardEntry, ProtocolCategory } from './contract.ts';
import type { CoverageEntry } from './coverage.ts';

// The rule under test, stated once: an entry we do not score must never occupy
// a position in a ranked list. A reader scanning quickly reads POSITION, not
// the score column, so "unscored, sorted last" and "ranked last" are the same
// thing to them. Everything below exists to make that structural rather than a
// thing review has to keep noticing.
//
// The same rule applies one level up: a `#` numeral is scoped to ONE category,
// and no ordering may put two categories' scores in one ranked sequence, because
// two numbers are comparable only when the same rulebook produced them.

/**
 * A category no entry actually carries.
 *
 * `dex` IS ON THE BOARD NOW, and this constant stayed anyway.
 *
 * It was written when `dex` was a registered rulebook with nothing scored under
 * it, so that the cross-category rules would be enforced before the day a second
 * category first reached the board rather than on it. That day has arrived: one
 * Aquarius market is registered and `LIVE_MIXED_BOARD` below exercises the same
 * rules with the real `'dex'` value.
 *
 * Keeping this one is the point rather than an oversight. It is a category the
 * code has never heard of, so it tests that the grouping, the per-block
 * numbering and the A-Z merge rule are structural — properties of
 * `buildRegistryView`, not of a list of known category names. A suite that only
 * ever saw `'lending'` and `'dex'` could pass with either one special-cased.
 * The cast is confined to this constant, and nothing built from it reaches a
 * score, a route, or the database.
 */
const FUTURE_CATEGORY = 'amm' as ProtocolCategory;

const scored = (
  id: string,
  name: string,
  safetyScore: number | null,
  category: ProtocolCategory = 'lending',
): LeaderboardEntry => ({
  id,
  name,
  chain: 'stellar',
  // Defaults to lending, which is what makes the assertions in this file
  // meaningful today: with one category the ranked list is exactly what it was
  // before categories existed — asserted below, not assumed.
  category,
  logo: null,
  deployedOn: null,
  safetyScore,
  computedAt: safetyScore === null ? null : '2026-08-21T00:00:00Z',
  // Ordering must not depend on it: operational state is published beside a
  // score, never folded into one, so it takes no part in sorting or ranking.
  operationalState: null,
  lastRunAt: '2026-08-21T00:00:00Z',
  lastRunStatus: 'ok',
});

const uncovered = (
  id: string,
  name: string,
  status: CoverageEntry['status'] = 'off-chain-state',
): CoverageEntry => ({
  id,
  name,
  status,
  logo: null,
  links: { site: null, docs: null },
  contractId: null,
  summary: `Why ${name} is not scored.`,
  reason: [`The long form for ${name}.`],
  verify: `How to check ${name}.`,
  asOf: null,
});

const params = (over: Partial<RegistryParams> = {}): RegistryParams => ({
  q: '',
  status: 'all',
  category: DEFAULT_CATEGORY,
  sort: DEFAULT_SORT,
  ...over,
});

const BOARD = [
  scored('blend', 'Blend', 54),
  scored('kinetic', 'Kinetic', 31),
  scored('yieldblox', 'YieldBlox', 24),
  scored('aurora', 'Aurora', null),
];

/** The same board with a second category on it — see FUTURE_CATEGORY. */
const MIXED_BOARD = [
  ...BOARD,
  scored('swapper', 'Swapper', 88, FUTURE_CATEGORY),
  scored('poolside', 'Poolside', 12, FUTURE_CATEGORY),
  scored('driftless', 'Driftless', null, FUTURE_CATEGORY),
];

/**
 * The board as it actually is: four lending markets and one `dex` one, with the
 * real category values and roughly the real scores.
 *
 * SEPARATE FROM `MIXED_BOARD` rather than replacing it — see FUTURE_CATEGORY for
 * why the unknown-category case is still worth having. This one answers a
 * different question: does the shipped board, with the shipped categories,
 * render two blocks numbered independently?
 */
const LIVE_MIXED_BOARD = [
  scored('blend', 'Blend', 50),
  scored('kinetic', 'Kinetic', 27),
  scored('yieldblox', 'YieldBlox', 27),
  scored('etherfuse', 'Etherfuse', 51),
  scored('aquarius-xlm-usdc', 'Aquarius XLM/USDC', 24, 'dex'),
];

const COVER = [
  uncovered('templar', 'Templar', 'off-chain-state'),
  uncovered('k2-earn', 'K2 Earn (earnUSDC)', 'below-size-floor'),
  uncovered('nectar-network', 'Nectar Network', 'awaiting-mainnet'),
];

/**
 * Every scored entry in the view, in section order.
 *
 * For assertions about MEMBERSHIP only — which entries are ranked and which are
 * not. It is deliberately not a thing the view itself hands out: flattening the
 * groups is exactly the cross-category sequence the grouping exists to prevent,
 * and doing
 * it here, in a test, is where that is harmless.
 */
const allRanked = (view: RegistryView): LeaderboardEntry[] =>
  view.rankedGroups.flatMap((group) => group.entries);

describe('parseRegistryParams', () => {
  const statuses = ['off-chain-state', 'below-size-floor', 'awaiting-mainnet'];
  const categories = ['lending', 'amm'];

  it('defaults to the ranked, unfiltered view', () => {
    assert.deepEqual(parseRegistryParams({}, statuses), {
      q: '',
      status: 'all',
      category: 'all',
      sort: 'score-desc',
    });
  });

  it('falls back silently on a value it does not recognise', () => {
    // These params get typed by hand and pasted between people. A stale
    // `?sort=score` from an older link should show the registry, not an error.
    const parsed = parseRegistryParams(
      { sort: 'score', status: 'lolwut', category: 'perpetuals' },
      statuses,
      categories,
    );
    assert.equal(parsed.sort, 'score-desc');
    assert.equal(parsed.status, 'all');
    // A category that doesn't exist yet is the same stale-link case, and gets
    // the same silent fallback rather than an error path of its own.
    assert.equal(parsed.category, 'all');
  });

  it('reads a category the board actually has', () => {
    assert.equal(
      parseRegistryParams({ category: 'lending' }, statuses, categories).category,
      'lending',
    );
    assert.equal(parseRegistryParams({ category: 'amm' }, statuses, categories).category, 'amm');
  });

  it('accepts a category only when that category has members', () => {
    // Same rule as the coverage statuses: a filter that selects nothing
    // describes members that aren't there. With no categories passed — the
    // board is empty or errored — every value falls back.
    assert.equal(parseRegistryParams({ category: 'lending' }, statuses, ['amm']).category, 'all');
    assert.equal(parseRegistryParams({ category: 'lending' }, statuses).category, 'all');
  });

  it('accepts a coverage status only when that status has members', () => {
    // Same rule as groupCoverage dropping empty groups: a filter that selects a
    // heading with nothing under it describes members that aren't there.
    assert.equal(
      parseRegistryParams({ status: 'awaiting-mainnet' }, statuses).status,
      'awaiting-mainnet',
    );
    assert.equal(parseRegistryParams({ status: 'out-of-category' }, statuses).status, 'all');
  });

  it('takes the first value of a repeated param and trims the query', () => {
    assert.equal(parseRegistryParams({ q: ['  blend  ', 'kinetic'] }, statuses).q, 'blend');
  });

  it('caps an absurd query rather than carrying it into the page', () => {
    const parsed = parseRegistryParams({ q: 'x'.repeat(500) }, statuses);
    assert.equal(parsed.q.length, 64);
  });
});

describe('registryHref', () => {
  it('gives the unfiltered ranked view exactly one URL', () => {
    // Defaults are omitted so /registry is the canonical address of the
    // registry, rather than one of three spellings of itself.
    assert.equal(
      registryHref({ q: '', status: 'all', category: 'all', sort: 'score-desc' }),
      '/registry',
    );
  });

  it('omits the category param when no category is selected', () => {
    // The default must not appear in the URL, or /registry gains a second
    // spelling of itself the moment a category filter exists.
    assert.equal(registryHref({ q: 'blend', category: 'all' }), '/registry?q=blend');
    assert.equal(registryHref({ category: 'lending' }), '/registry?category=lending');
  });

  it('round-trips a filtered view through parse', () => {
    const href = registryHref({ q: 'k2', status: 'below-size-floor', sort: 'name' });
    const parsed = parseRegistryParams(
      Object.fromEntries(new URL(href, 'https://stenion.io').searchParams),
      ['below-size-floor'],
    );
    assert.deepEqual(parsed, {
      q: 'k2',
      status: 'below-size-floor',
      category: 'all',
      sort: 'name',
    });
  });

  it('round-trips a category filter through parse', () => {
    const href = registryHref({ q: 'blend', category: 'lending', sort: 'score-asc' });
    assert.equal(href, '/registry?q=blend&category=lending&sort=score-asc');
    const parsed = parseRegistryParams(
      Object.fromEntries(new URL(href, 'https://stenion.io').searchParams),
      [],
      ['lending'],
    );
    assert.deepEqual(parsed, {
      q: 'blend',
      status: 'all',
      category: 'lending',
      sort: 'score-asc',
    });
  });

  it('drops a category the parse side does not recognise, rather than erroring', () => {
    // The link survives the round trip as the unfiltered view — the same
    // treatment a stale `?sort=` gets.
    const href = registryHref({ category: FUTURE_CATEGORY });
    const parsed = parseRegistryParams(
      Object.fromEntries(new URL(href, 'https://stenion.io').searchParams),
      [],
      ['lending'],
    );
    assert.equal(parsed.category, 'all');
    assert.equal(registryHref(parsed), '/registry');
  });
});

describe('matchesQuery', () => {
  it('finds an entry by what a reader sees, not by its slug spelling', () => {
    // The punctuation fold: someone typing the display name finds the entry
    // whose id is hyphenated.
    assert.ok(matchesQuery({ id: 'k2-earn', name: 'K2 Earn (earnUSDC)' }, 'k2 earn'));
    assert.ok(matchesQuery({ id: 'k2-earn', name: 'K2 Earn (earnUSDC)' }, 'K2-EARN'));
  });

  it('matches a substring anywhere in the name', () => {
    assert.ok(matchesQuery({ id: 'yieldblox', name: 'YieldBlox' }, 'blox'));
  });

  it('does not match a host protocol an entry merely runs on', () => {
    // Searching "blend" and being handed YieldBlox with no visible reason
    // implies YieldBlox IS Blend — the thing the deployment label denies.
    assert.equal(matchesQuery({ id: 'yieldblox', name: 'YieldBlox' }, 'blend'), false);
  });

  it('treats an empty query as no filter at all', () => {
    assert.ok(matchesQuery({ id: 'blend', name: 'Blend' }, '   '));
  });
});

describe('partitionScored — the third state', () => {
  it('keeps a never-scored protocol out of the ranked set', () => {
    // safetyScore: null is our pipeline not having got there. It is neither a
    // rankable number nor a coverage decision.
    const { ranked, pending } = partitionScored(BOARD);
    assert.deepEqual(
      ranked.map((r) => r.id),
      ['blend', 'kinetic', 'yieldblox'],
    );
    assert.deepEqual(
      pending.map((r) => r.id),
      ['aurora'],
    );
  });
});

describe('sortRanked', () => {
  it('ranks by score descending by default', () => {
    assert.deepEqual(
      sortRanked(partitionScored(BOARD).ranked, 'score-desc').map((r) => r.safetyScore),
      [54, 31, 24],
    );
  });

  it('reverses cleanly for score-asc', () => {
    assert.deepEqual(
      sortRanked(partitionScored(BOARD).ranked, 'score-asc').map((r) => r.safetyScore),
      [24, 31, 54],
    );
  });

  it('breaks ties by name so the order is stable between runs', () => {
    // Two protocols on the same number must not swap places because the
    // database returned them in a different order.
    const tied = [scored('zeta', 'Zeta', 40), scored('alpha', 'Alpha', 40)];
    assert.deepEqual(
      sortRanked(tied, 'score-desc').map((r) => r.id),
      ['alpha', 'zeta'],
    );
    assert.deepEqual(
      sortRanked(tied, 'score-asc').map((r) => r.id),
      ['alpha', 'zeta'],
    );
  });
});

describe('buildRegistryView — unscored entries never enter the ranking', () => {
  it('keeps coverage entries out of the ranked list under score-desc', () => {
    const view = buildRegistryView(BOARD, COVER, params());
    assert.equal(view.mode, 'ranked');
    assert.equal(view.merged.length, 0, 'ranked mode must not produce a merged list');
    for (const id of allRanked(view).map((r) => r.id)) {
      assert.ok(!COVER.some((c) => c.id === id), `${id} is a coverage entry inside the ranking`);
    }
    assert.deepEqual(view.coverage.map((c) => c.id).sort(), [
      'k2-earn',
      'nectar-network',
      'templar',
    ]);
  });

  it('keeps them out under score-asc too, where "last" becomes "first"', () => {
    // The direction flip is the case worth pinning: sorting unscored entries
    // onto the scale at all would put them at the TOP here.
    const view = buildRegistryView(BOARD, COVER, params({ sort: 'score-asc' }));
    assert.equal(allRanked(view)[0]?.id, 'yieldblox', 'lowest real score leads');
    assert.equal(view.merged.length, 0);
  });

  it('never prints a position numeral except under score-desc', () => {
    // Under score-asc row one is the lowest score; under name it is
    // alphabetical. In both, "01" would assert a rank that isn't there.
    assert.equal(buildRegistryView(BOARD, COVER, params()).showRank, true);
    assert.equal(buildRegistryView(BOARD, COVER, params({ sort: 'score-asc' })).showRank, false);
    assert.equal(buildRegistryView(BOARD, COVER, params({ sort: 'name' })).showRank, false);
  });

  it('puts a never-scored protocol after every ranked one, in both directions', () => {
    for (const sort of ['score-desc', 'score-asc'] as const) {
      const view = buildRegistryView(BOARD, COVER, params({ sort }));
      assert.deepEqual(
        view.pending.map((p) => p.id),
        ['aurora'],
      );
      assert.ok(!allRanked(view).some((r) => r.id === 'aurora'));
      assert.ok(
        !view.coverage.some((c) => c.id === 'aurora'),
        'a pipeline gap is not a coverage decision',
      );
    }
  });
});

describe('buildRegistryView — the alphabetical exception', () => {
  it('merges both kinds into one list, since A–Z asserts no ranking', () => {
    const view = buildRegistryView(BOARD, COVER, params({ sort: 'name' }));
    assert.equal(view.mode, 'alphabetical');
    assert.deepEqual(
      view.merged.map((r) => r.entry.name),
      [
        'Aurora',
        'Blend',
        'K2 Earn (earnUSDC)',
        'Kinetic',
        'Nectar Network',
        'Templar',
        'YieldBlox',
      ],
    );
  });

  it('tags every merged row with which kind it is', () => {
    // The tag is what lets the row render a chip instead of a number. A merged
    // list where the two look alike is the confusion the separate section was
    // preventing.
    const view = buildRegistryView(BOARD, COVER, params({ sort: 'name' }));
    const kinds = Object.fromEntries(view.merged.map((r) => [r.entry.id, r.kind]));
    assert.equal(kinds['blend'], 'scored');
    assert.equal(kinds['templar'], 'coverage');
    assert.equal(kinds['aurora'], 'scored', 'a pipeline gap is still a tracked protocol');
  });
});

describe('buildRegistryView — search and filter', () => {
  it('searches across both kinds at once', () => {
    const view = buildRegistryView(BOARD, COVER, params({ q: 'k2' }));
    assert.deepEqual(
      allRanked(view).map((r) => r.id),
      [],
    );
    assert.deepEqual(
      view.coverage.map((c) => c.id),
      ['k2-earn'],
    );
    assert.equal(view.counts.total, 1);
  });

  it('finds a scored protocol and an unscored one under the same query', () => {
    const board = [...BOARD, scored('nectar-lend', 'Nectar Lend', 70)];
    const view = buildRegistryView(board, COVER, params({ q: 'nectar' }));
    assert.deepEqual(
      allRanked(view).map((r) => r.id),
      ['nectar-lend'],
    );
    assert.deepEqual(
      view.coverage.map((c) => c.id),
      ['nectar-network'],
    );
  });

  it('narrows to one kind on the status filter', () => {
    const onlyScored = buildRegistryView(BOARD, COVER, params({ status: 'scored' }));
    assert.equal(onlyScored.coverage.length, 0);
    assert.equal(onlyScored.counts.ranked, 3);
    assert.equal(
      onlyScored.counts.pending,
      1,
      'a tracked protocol with no score is still scored-side',
    );

    const onlyCoverage = buildRegistryView(BOARD, COVER, params({ status: 'not-scored' }));
    assert.equal(onlyCoverage.counts.ranked, 0);
    assert.equal(onlyCoverage.pending.length, 0);
    assert.equal(onlyCoverage.coverage.length, 3);
  });

  it('narrows to a single coverage status', () => {
    const view = buildRegistryView(BOARD, COVER, params({ status: 'below-size-floor' }));
    assert.deepEqual(
      view.coverage.map((c) => c.id),
      ['k2-earn'],
    );
    assert.equal(view.counts.ranked, 0, 'a coverage status implies not-scored');
  });

  it('reports an empty result honestly rather than falling back to everything', () => {
    const view = buildRegistryView(BOARD, COVER, params({ q: 'nothing-matches-this' }));
    assert.equal(view.counts.total, 0);
    assert.equal(view.merged.length, 0);
  });
});

describe('buildRegistryView — a ranking is scoped to one category', () => {
  it('splits the ranked entries into one block per category', () => {
    const view = buildRegistryView(MIXED_BOARD, COVER, params());

    assert.deepEqual(
      view.rankedGroups.map((g) => g.category),
      [FUTURE_CATEGORY, 'lending'],
      'one block per category, in a stable order that is not itself a ranking',
    );
    assert.deepEqual(
      view.rankedGroups.map((g) => g.entries.map((e) => e.id)),
      [
        ['swapper', 'poolside'],
        ['blend', 'kinetic', 'yieldblox'],
      ],
    );
    // The count is still the total across blocks: the summary line counts rows,
    // it does not rank them.
    assert.equal(view.counts.ranked, 5);
  });

  it('numbers each block from 1, so a # means a rank inside its own rulebook', () => {
    // The numeral is rendered as `index + 1` WITHIN a group. Poolside is the
    // lowest score on the whole board and still ranks 02 — of the AMMs, which
    // is the only claim its number supports.
    const view = buildRegistryView(MIXED_BOARD, COVER, params());
    assert.equal(view.showRank, true);
    const lending = view.rankedGroups.find((g) => g.category === 'lending');
    assert.equal(lending?.entries[0]?.id, 'blend', 'lending rank 01 is the top lending score');
    const amm = view.rankedGroups.find((g) => g.category === FUTURE_CATEGORY);
    assert.equal(amm?.entries[0]?.id, 'swapper', 'the AMM block ranks from its own top');
    assert.equal(
      amm?.entries[1]?.id,
      'poolside',
      'the lowest score on the board still ranks 02 of the AMMs, not last overall',
    );
  });

  it('leaves the pending and coverage blocks exactly where they were', () => {
    // Grouping is a change to the RANKED section only. A protocol awaiting a
    // first score is still one block, name-ordered, whatever its category — it
    // has no number, so there is nothing to make comparable or incomparable.
    const view = buildRegistryView(MIXED_BOARD, COVER, params());
    assert.deepEqual(
      view.pending.map((p) => p.id),
      ['aurora', 'driftless'],
    );
    assert.deepEqual(
      view.coverage.map((c) => c.id),
      ['k2-earn', 'nectar-network', 'templar'],
    );
    assert.equal(view.counts.pending, 2);
    assert.equal(view.counts.coverage, 3);
  });

  it('never puts two categories into one ranked sequence, under any ordering', () => {
    // THE INVARIANT, checked against every ordering the registry offers rather
    // than against the one that motivated it. It holds structurally — the view
    // carries groups and no flat ranked array — so the only way to break it is
    // to put the flat array back, which this test would then catch.
    for (const sort of REGISTRY_SORTS) {
      const view = buildRegistryView(MIXED_BOARD, COVER, params({ sort }));
      const seen = new Set<string>();
      for (const group of view.rankedGroups) {
        const categories = new Set(group.entries.map((e) => e.category));
        assert.equal(
          categories.size,
          1,
          `sort=${sort} produced a ranked block spanning ${[...categories].join(' + ')}`,
        );
        assert.ok(!seen.has(group.category), `sort=${sort} split ${group.category} across blocks`);
        seen.add(group.category);
      }
      // Every scored entry still appears exactly once, so scoping the ranking
      // hides nothing.
      assert.equal(allRanked(view).length, 5, `sort=${sort} lost or duplicated a scored entry`);
    }
  });

  it('makes A–Z the only ordering that merges two categories into one list', () => {
    for (const sort of REGISTRY_SORTS) {
      const view = buildRegistryView(MIXED_BOARD, COVER, params({ sort }));
      const mergedCategories = new Set(
        view.merged
          .filter((row) => row.kind === 'scored')
          .map((row) => (row.entry as LeaderboardEntry).category),
      );

      if (sort === 'name') {
        assert.equal(view.mode, 'alphabetical');
        // A–Z asserts no comparison, so a lending score sitting above an AMM one
        // is not calling it better — the same licence that lets unscored entries
        // merge in here.
        assert.equal(mergedCategories.size, 2, 'name must merge the categories');
        assert.deepEqual(
          view.merged.map((r) => r.entry.name),
          [
            'Aurora',
            'Blend',
            'Driftless',
            'K2 Earn (earnUSDC)',
            'Kinetic',
            'Nectar Network',
            'Poolside',
            'Swapper',
            'Templar',
            'YieldBlox',
          ],
        );
        assert.equal(view.showRank, false, 'a merged list may never carry a numeral');
      } else {
        assert.equal(view.mode, 'ranked');
        assert.equal(
          view.merged.length,
          0,
          `sort=${sort} produced a merged list, which would span categories`,
        );
      }
    }
  });

  it('narrows to one category on the filter, and drops the coverage block with it', () => {
    const view = buildRegistryView(MIXED_BOARD, COVER, params({ category: 'lending' }));
    assert.deepEqual(
      view.rankedGroups.map((g) => g.category),
      ['lending'],
    );
    assert.deepEqual(
      view.pending.map((p) => p.id),
      ['aurora'],
      'the pending block is filtered by category too — those rows carry one',
    );
    assert.deepEqual(
      view.coverage,
      [],
      'a coverage entry has no category, so listing it under one would assert a categorisation we never made',
    );
    assert.equal(view.counts.total, 4);
  });
});

describe('buildRegistryView — one category renders exactly what a flat list did', () => {
  // THE REGRESSION GUARD. `ProtocolCategory` has one member in the real data, so
  // grouping must be invisible today: one block, ordered and numbered exactly as
  // the flat list was. The expectation is recomputed from the pre-grouping
  // primitives (partitionScored, then sortRanked), which is the code the old flat `ranked`
  // field was built by — so this compares against the old behaviour rather than
  // against a copy of the new one.
  for (const sort of REGISTRY_SORTS) {
    it(`is equivalent to the flat ranked list under sort=${sort}`, () => {
      const view = buildRegistryView(BOARD, COVER, params({ sort }));
      const legacyRanked = sortRanked(partitionScored(BOARD).ranked, sort);

      assert.equal(view.rankedGroups.length, 1, 'one category must produce exactly one block');
      assert.equal(view.rankedGroups[0]?.category, 'lending');
      assert.deepEqual(
        view.rankedGroups[0]?.entries,
        legacyRanked,
        'the single block must be the flat pre-grouping list, entry for entry',
      );
      assert.deepEqual(
        view.rankedGroups[0]?.entries.map((_, i) => i + 1),
        [1, 2, 3],
        'numbered 01..n exactly as before',
      );

      // And the rest of the view, which grouping was not allowed to touch.
      assert.equal(view.mode, sort === 'name' ? 'alphabetical' : 'ranked');
      assert.equal(view.showRank, sort === 'score-desc');
      assert.deepEqual(view.counts, {
        ranked: legacyRanked.length,
        pending: 1,
        coverage: 3,
        total: legacyRanked.length + 4,
      });
      assert.deepEqual(
        view.pending.map((p) => p.id),
        ['aurora'],
      );
      assert.deepEqual(
        view.coverage.map((c) => c.id),
        ['k2-earn', 'nectar-network', 'templar'],
      );
    });
  }

  it('leaves the merged alphabetical list unchanged too', () => {
    const view = buildRegistryView(BOARD, COVER, params({ sort: 'name' }));
    assert.deepEqual(
      view.merged.map((r) => [r.kind, r.entry.id]),
      [
        ['scored', 'aurora'],
        ['scored', 'blend'],
        ['coverage', 'k2-earn'],
        ['scored', 'kinetic'],
        ['coverage', 'nectar-network'],
        ['coverage', 'templar'],
        ['scored', 'yieldblox'],
      ],
    );
  });
});

describe('buildRegistryView — the live two-category board', () => {
  it('renders two ranked blocks, each numbered from 01 within itself', () => {
    const view = buildRegistryView(LIVE_MIXED_BOARD, COVER, params());

    assert.deepEqual(
      view.rankedGroups.map((g) => g.category),
      ['dex', 'lending'],
      'one block per shipped category, alphabetically — not a ranking of categories',
    );
    assert.deepEqual(
      view.rankedGroups.map((g) => g.entries.map((e) => e.id)),
      [['aquarius-xlm-usdc'], ['etherfuse', 'blend', 'kinetic', 'yieldblox']],
    );
    // The claim the block structure exists to protect: the single dex entry is
    // 01 OF DEX. It has the lowest score on the board, and a flat ranking would
    // have numbered it 05 — which would read as "worst of five", a comparison
    // no rulebook supports.
    const dex = view.rankedGroups.find((g) => g.category === 'dex');
    assert.equal(dex?.entries[0]?.id, 'aquarius-xlm-usdc');
    assert.equal(dex?.entries.length, 1, 'one dex market is registered today');
    assert.equal(view.counts.ranked, 5, 'the count is rows, across blocks — never a rank');
  });

  it('keeps the # column to score-descending, with a real dex row present', () => {
    assert.equal(buildRegistryView(LIVE_MIXED_BOARD, COVER, params()).showRank, true);
    for (const sort of REGISTRY_SORTS.filter((s) => s !== 'score-desc')) {
      assert.equal(
        buildRegistryView(LIVE_MIXED_BOARD, COVER, params({ sort })).showRank,
        false,
        `sort=${sort} must not render a position numeral`,
      );
    }
  });

  it('lets A–Z merge lending and dex, and nothing else does', () => {
    for (const sort of REGISTRY_SORTS) {
      const view = buildRegistryView(LIVE_MIXED_BOARD, COVER, params({ sort }));
      if (sort === 'name') {
        assert.equal(view.mode, 'alphabetical');
        assert.equal(
          view.merged[0]?.entry.id,
          'aquarius-xlm-usdc',
          'the dex market sorts first by name, above every lending one, and that asserts nothing',
        );
        assert.equal(view.showRank, false);
      } else {
        assert.equal(
          view.merged.length,
          0,
          `sort=${sort} produced a merged, category-spanning list`,
        );
        for (const group of view.rankedGroups) {
          assert.equal(new Set(group.entries.map((e) => e.category)).size, 1);
        }
      }
    }
  });
});

describe('groupRankedByCategory', () => {
  it('orders the groups stably, and never by anything inside them', () => {
    // Section order must not read as a ranking of categories, so it is
    // alphabetical by category — the same answer whatever order the database
    // returned the rows in, and whatever scores they carry.
    const ranked = partitionScored(MIXED_BOARD).ranked;
    const forwards = groupRankedByCategory(ranked, 'score-desc').map((g) => g.category);
    const backwards = groupRankedByCategory([...ranked].reverse(), 'score-desc').map(
      (g) => g.category,
    );
    assert.deepEqual(forwards, backwards);
    assert.deepEqual(forwards, [FUTURE_CATEGORY, 'lending']);
  });

  it('returns no groups at all for an empty ranked set', () => {
    assert.deepEqual(groupRankedByCategory([], 'score-desc'), []);
  });
});
