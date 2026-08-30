// Tests for the shared scoring rulebook.
//
// WHY THESE EXIST: `scoreFactors` is the one piece of arithmetic every protocol
// on the registry passes through, so a silent change to it moves every
// published number at once. Until now it was copy-pasted into each adapter,
// which meant there was nothing to test — only two copies to keep in sync by
// eye. It lives in core now, and this is the suite that pins it.
//
// Several assertions below read METHODOLOGY.md and core/src/types.ts as *text*
// rather than hardcoding their contents. That is deliberate: CLAUDE.md's
// standing rule is that code and METHODOLOGY.md are not allowed to drift, and a
// test that restates the doc's numbers in TypeScript cannot catch a doc edit —
// it just becomes a third copy to keep in sync. Reading the source of truth is
// what makes a divergence in *either* direction fail here.
//
// Run with: pnpm --filter @stenion/core test

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

// Type-only imports are erased before Node sees this file. That matters: a
// *value* import of `RiskFactorType` would crash the runner, because Node's
// strip-only TypeScript mode rejects `enum` (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
// So the factor keys are written as string literals below, and a test asserts
// those literals still match the enum — see "taxonomy names".
import type { ProtocolCategory } from './category.ts';
import type { FactorMap, RiskFactor, RiskFactorMap } from './types.ts';
// A VALUE import: the weight declarations are the thing the doc's table is
// pinned against, so they have to be readable at runtime, not just at compile
// time. `weights.ts` is a leaf under the strip-only loader — its only import is
// a type-only one — which is what makes this work.
import { PROTOCOL_CATEGORIES } from './category.ts';
import { CATEGORY_FACTORS } from './weights.ts';
import {
  MIN_RESERVE_POOL_SHARE,
  STALE_CEILING_SECONDS,
  describePriceAges,
  describeWorst,
  excludedComponent,
  freshnessWindow,
  scoreFactors,
  sizeReserves,
  worstReserves,
} from './scoring.ts';

// ---------------------------------------------------------------------------
// Reading the sources of truth
// ---------------------------------------------------------------------------

/** Walk up from the test's cwd to find a repo file, so this works from any package dir. */
function repoFile(name: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not find ${name} walking up from ${process.cwd()}`);
    dir = parent;
  }
}

/**
 * One category's rulebook file.
 *
 * METHODOLOGY.md is a FOLDER now — its per-category sections became
 * per-category files — and a category's file is named for the category:
 * `lending` lives in `methodology/lending.md`. Reading only that file rather
 * than the whole folder is the same scoping the section parser below already
 * did; it just starts one level up now, so a second category cannot be read
 * into scope by accident at all.
 */
function methodologyFile(category: ProtocolCategory): string {
  return repoFile(`methodology/${category}.md`);
}

/** Lending's rulebook, for the assertions below that read it as one document. */
const LENDING_METHODOLOGY = methodologyFile('lending');

/**
 * The slice of a category's methodology file belonging to that category: from
 * its `## <Label>` heading down to the next heading of the same level.
 *
 * WHY THE PARSERS BELOW ARE SCOPED AND NO LONGER READ THE WHOLE FILE. The
 * document used to describe exactly one rulebook, so "the weight table" and
 * "the worked example" were unambiguous phrases and a file-wide regex was a
 * correct reading of it. Per-category sections make both phrases ambiguous: a
 * second category brings a second weight table and a second worked example,
 * with its own factor keys and its own weights, and the old parsers would have
 * concatenated the two tables and then asserted the pile summed to 1.00. That
 * break would have surfaced in whatever change added the category, pointing at
 * the wrong line. Taking a category and reading only its section is what makes
 * each assertion below say which rulebook it is about.
 *
 * The heading text comes from `CATEGORY_FACTORS[category].label` rather than a
 * literal here, so the document and the code cannot disagree about what a
 * category's section is called — the same reason these parsers read the doc at
 * all instead of restating it.
 */
function docCategorySection(category: ProtocolCategory): string {
  const heading = `## ${CATEGORY_FACTORS[category].label}`;
  const lines = methodologyFile(category).split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  assert.ok(
    start >= 0,
    `methodology/${category}.md has no "${heading}" section. Every category in ` +
      `PROTOCOL_CATEGORIES needs one — a category with no published rulebook is ` +
      `a score nobody outside can check.`,
  );

  const rest = lines.slice(start + 1);
  // `^## ` matches an h2 only: an h3 line starts `###`, so the space fails to
  // match and a subsection cannot be mistaken for the end of the section.
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * One category's "Factor weights" table: rows like ``| `oracleSafety` | 0.25 |``.
 * The `Total` row is excluded by requiring a `*Safety` name.
 */
function docWeightRows(category: ProtocolCategory): { factor: string; weight: number }[] {
  const rows = [
    ...docCategorySection(category).matchAll(/^\|\s*`(\w+Safety)`\s*\|\s*([\d.]+)\s*\|/gm),
  ];
  return rows.map((m) => ({ factor: m[1], weight: Number(m[2]) }));
}

/**
 * The same rows, but insisting there are some.
 *
 * Split from `docWeightRows` because a `pendingWeights` category is asserted to
 * publish NO weight table, and an empty result is the passing case there — so
 * the "did the format change?" alarm cannot live inside the parser any more.
 * Callers that require a table say so by calling this one.
 */
function docWeightTable(category: ProtocolCategory): { factor: string; weight: number }[] {
  const rows = docWeightRows(category);
  assert.ok(
    rows.length > 0,
    `could not parse ${category}'s factor-weight table out of METHODOLOGY.md — has its format changed?`,
  );
  return rows;
}

/**
 * One category's worked example, e.g.
 * `70×0.20 + 100×0.25 + 40×0.20 + 22×0.15 + 14×0.20 = 53.1 → 53`
 *
 * Returns the (value, weight) pairs plus the score the doc claims they produce.
 */
function docWorkedExample(category: ProtocolCategory): {
  pairs: [number, number][];
  stated: number;
  rounded: number;
} {
  const line = docCategorySection(category)
    .split('\n')
    .find((l) => /×/.test(l) && /→/.test(l) && /\+/.test(l));
  assert.ok(line, `could not find ${category}'s worked example line in METHODOLOGY.md`);

  const pairs = [...line.matchAll(/([\d.]+)×([\d.]+)/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as [number, number],
  );
  const result = line.match(/=\s*([\d.]+)\s*→\s*(\d+)/);
  assert.ok(result, `could not parse the result out of the worked example: ${line}`);

  return { pairs, stated: Number(result[1]), rounded: Number(result[2]) };
}

// ---------------------------------------------------------------------------
// Building factor maps
// ---------------------------------------------------------------------------

/** The taxonomy's five keys. Asserted against the enum in the "taxonomy names" test. */
const FACTOR_KEYS = [
  'collateralSafety',
  'oracleSafety',
  'adminKeySafety',
  'liquiditySafety',
  'utilizationSafety',
] as const;

const factor = (value: number, weight: number): RiskFactor => ({
  value,
  weight,
  detail: 'synthetic test factor',
});

/**
 * The categories whose weight table has been reviewed, i.e. the ones a weight
 * table and a worked example are required of.
 *
 * The assertions below iterate this rather than naming `lending`, because every
 * one of them is a statement about *a category's* rulebook and nothing in any of
 * them is lending-specific. Naming one category was correct while one was
 * published; it stopped being correct when `dex` gained a table that would
 * otherwise have been pinned against nothing.
 */
const publishedCategories = () =>
  PROTOCOL_CATEGORIES.filter((c) => CATEGORY_FACTORS[c].status === 'published');

/**
 * A factor map of whatever arity the worked example has, from (value, weight)
 * pairs.
 *
 * Deliberately NOT `factorMap` below, which insists on lending's five keys —
 * `dex` has two, and `scoreFactors` is generic over `FactorMap` precisely so a
 * category's arity is data rather than a second implementation of the mean. The
 * keys are positional because a worked example's line does not label its terms
 * and the weighted mean does not care which key holds which value.
 */
function syntheticMap(pairs: [number, number][]): FactorMap {
  return Object.fromEntries(pairs.map(([v, w], i) => [`f${i}Safety`, factor(v, w)]));
}

/** A full five-key map from entries in FACTOR_KEYS order; `null` means "doesn't apply". */
function factorMap(entries: (RiskFactor | null)[]): RiskFactorMap {
  assert.equal(entries.length, FACTOR_KEYS.length, 'factorMap needs one entry per factor');
  return Object.fromEntries(FACTOR_KEYS.map((k, i) => [k, entries[i]])) as RiskFactorMap;
}

// ---------------------------------------------------------------------------

describe("scoreFactors — agreement with each published category's rulebook", () => {
  // Every assertion in here names the category it is about. `scoreFactors`
  // itself is category-agnostic — it is a weighted mean and does not know which
  // rulebook produced the weights — but a worked example and a weight table are
  // a *category's*, so reading them without saying whose would be reading the
  // wrong rulebook the moment a second one is published.
  //
  // THEY ITERATE THE PUBLISHED CATEGORIES RATHER THAN NAMING `lending`. Nothing
  // in any of them was ever lending-specific; naming one category was simply
  // correct while one had a weight table. `dex` gained one, and a table
  // nobody pins against `CATEGORY_FACTORS` is exactly the drift these tests
  // exist to catch — so the loop is what stops the next category being published
  // in the document and never checked against the code.
  it("reproduces each doc's worked example exactly", () => {
    for (const category of publishedCategories()) {
      const { pairs, stated, rounded } = docWorkedExample(category);

      assert.equal(
        pairs.length,
        Object.keys(CATEGORY_FACTORS[category].factors).length,
        `${category}'s worked example should have one term per factor`,
      );

      // The mean is order-independent, so which key holds which value doesn't
      // affect the result — the doc's line doesn't label them anyway.
      const result = scoreFactors(syntheticMap(pairs));

      assert.equal(
        result.score,
        rounded,
        `scoreFactors disagrees with methodology/${category}.md's worked example ` +
          `(doc says ${rounded}, code says ${result.score}). Code and the doc are not ` +
          `allowed to drift — fix whichever is wrong, in the same change.`,
      );

      // Lending's doc writes its pre-rounding value as 53.1. In IEEE-754 that
      // sum is actually 53.099999999999994, so this is checked with a tolerance
      // rather than by equality — asserting the exact literal would fail for a
      // reason that has nothing to do with the rulebook.
      const exact = pairs.reduce((a, [v, w]) => a + v * w, 0);
      const totalWeight = pairs.reduce((a, [, w]) => a + w, 0);
      assert.ok(
        Math.abs(exact / totalWeight - stated) < 0.005,
        `${category}'s doc states a pre-rounding value of ${stated}, ` +
          `computed ${exact / totalWeight}`,
      );
    }
  });

  it("each doc's weight table sums to 1.00 and matches its worked example's weights", () => {
    for (const category of publishedCategories()) {
      const table = docWeightTable(category);
      assert.equal(
        table.length,
        Object.keys(CATEGORY_FACTORS[category].factors).length,
        `${category} publishes a different number of weighted factors than it declares`,
      );

      const sum = table.reduce((a, r) => a + r.weight, 0);
      assert.ok(
        Math.abs(sum - 1) < 1e-9,
        `${category}'s factor weights should sum to 1.00, got ${sum}`,
      );

      // A doc states its weights twice — once in the table, once inline in the
      // worked example. They must agree with each other, or the doc contradicts
      // itself regardless of what the code does.
      const fromTable = table.map((r) => r.weight).sort();
      const fromExample = docWorkedExample(category)
        .pairs.map(([, w]) => w)
        .sort();
      assert.deepEqual(
        fromExample,
        fromTable,
        `${category}'s worked example weights differ from its table's`,
      );
    }
  });

  it("each published table is exactly what CATEGORY_FACTORS declares — the adapters' source", () => {
    // THE LINK THAT MAKES THE CHAIN A CHAIN. Adapters read their weights from
    // `CATEGORY_FACTORS.<category>`, and none contains a weight literal; their
    // suites assert they carry what it declares. This asserts the other end —
    // that what it declares is what `methodology/` publishes. Without it, two
    // adapters could agree perfectly with each other and both disagree with the
    // rulebook, which is worse than the drift the move into core was meant to
    // fix, not better: it would look consistent.
    //
    // The doc is parsed, never restated, so a weight edited in either place
    // alone fails here.
    for (const category of publishedCategories()) {
      const declaration = CATEGORY_FACTORS[category];
      // Narrowing for the compiler; `publishedCategories()` already filtered.
      if (declaration.status !== 'published') continue;

      const fromDoc = Object.fromEntries(docWeightTable(category).map((r) => [r.factor, r.weight]));
      const declared = Object.fromEntries(
        Object.entries(declaration.factors).map(([k, f]) => [k, f.weight]),
      );

      assert.deepEqual(
        declared,
        fromDoc,
        `CATEGORY_FACTORS.${category} and methodology/${category}.md’s "Factor weights" ` +
          'table disagree. Code and the doc are not allowed to drift — fix whichever is ' +
          'wrong, in the same change.',
      );
    }
  });

  it('publishes a rulebook section for every category that exists', () => {
    // A category in PROTOCOL_CATEGORIES with no METHODOLOGY.md section is a
    // score with no published rules behind it. `docCategorySection` throws with
    // that message if the heading is missing, so iterating every category is the
    // whole assertion — and it is the check that stops the next category being
    // registered in code and forgotten in the document.
    //
    // THE WEIGHT TABLE AND WORKED EXAMPLE ARE REQUIRED OF A `published`
    // CATEGORY, NOT OF EVERY ONE. A worked example is an arithmetic
    // demonstration of the weight table, so a category whose weights are
    // deliberately not yet reviewed (`status: 'pendingWeights'`) has nothing it
    // could honestly show: any table it published would be numbers invented to
    // satisfy a parser, which is the opposite of what parsing the document is
    // for. The `## <Label>` section itself is still required of it, because the
    // factor set, the anchors and the rejected alternatives are exactly what
    // such a category HAS been reviewed on. Both categories are `published`
    // today — `dex`'s weight table has been reviewed — so the skip below
    // currently skips nothing.
    for (const category of PROTOCOL_CATEGORIES) {
      const section = docCategorySection(category);
      assert.ok(section.trim().length > 0, `${category}'s section in METHODOLOGY.md is empty`);

      if (CATEGORY_FACTORS[category].status !== 'published') continue;
      assert.ok(docWeightTable(category).length > 0, `${category} publishes no weight table`);
      assert.ok(
        docWorkedExample(category).pairs.length > 0,
        `${category} publishes no worked example`,
      );
    }
  });

  it('publishes NO weight table for a category whose weights are not yet reviewed', () => {
    // The mirror, and the half that stops the skip above from being a hole. A
    // `pendingWeights` category that published a weight table anyway would be
    // asserting reviewed weights in the one document that is supposed to be the
    // source of truth for them, while the code carried none — drift in the
    // loudest possible place. Either the numbers are real, in which case the
    // status flips and the table is pinned against `CATEGORY_FACTORS` by the
    // assertion above, or there are no numbers to print.
    //
    // It iterates nothing today, for the same reason the skip above skips
    // nothing, and is kept for the next category admitted in TAXONOMY.md's two
    // steps rather than deleted the moment `dex` left the state.
    for (const category of PROTOCOL_CATEGORIES) {
      if (CATEGORY_FACTORS[category].status === 'published') continue;
      assert.equal(
        docWeightRows(category).length,
        0,
        `methodology/${category}.md publishes a weight table for a category ` +
          `declared 'pendingWeights'. Flip the status and land the weights in ` +
          `CATEGORY_FACTORS in the same change, or remove the table.`,
      );
    }
  });

  it('names, in the doc, exactly the factors the category declares', () => {
    // The Gate-6 pin that survives a category having no weights: whatever else
    // is deferred, the factor SET is what the category was admitted on, and the
    // document and `CATEGORY_FACTORS` must agree on it. Lending's version of this check runs
    // through its weight table (above); a pendingWeights category has no table,
    // so the keys are read from the `#### N. \`factorKey\`` headings its section
    // uses to introduce each factor — the same headings lending's section uses.
    for (const category of PROTOCOL_CATEGORIES) {
      const section = docCategorySection(category);
      const fromDoc = [...section.matchAll(/^#{3,4} \d+\. `([A-Za-z]+)`/gm)].map((m) => m[1]);
      assert.deepEqual(
        [...fromDoc].sort(),
        Object.keys(CATEGORY_FACTORS[category].factors).sort(),
        `methodology/${category}.md introduces a different set of factors than ` +
          `CATEGORY_FACTORS.${category} declares`,
      );
    }
  });

  it('taxonomy names agree across the enum, the doc, and this test', () => {
    // The enum can't be imported as a value here (strip-only mode rejects
    // `enum`), so its members are read from source instead. This is what keeps
    // FACTOR_KEYS above honest if a factor is ever renamed.
    const source = repoFile('core/src/types.ts');
    const body = source.match(/export enum RiskFactorType \{([^}]*)\}/)?.[1];
    assert.ok(body, 'could not find the RiskFactorType enum in core/src/types.ts');
    const fromEnum = [...body.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();

    assert.deepEqual([...FACTOR_KEYS].sort(), fromEnum, 'FACTOR_KEYS is out of date with the enum');
    assert.deepEqual(
      docWeightTable('lending')
        .map((r) => r.factor)
        .sort(),
      fromEnum,
      "METHODOLOGY.md's lending weight table names a different set of factors than the enum",
    );
    assert.deepEqual(
      Object.keys(CATEGORY_FACTORS.lending.factors).sort(),
      fromEnum,
      'CATEGORY_FACTORS.lending declares a different set of factors than the enum',
    );
  });
});

describe('scoreFactors — renormalization over null factors', () => {
  it('renormalizes rather than treating a null factor as a zero', () => {
    // oracle 100 (0.25) + collateral 50 (0.20), the other three inapplicable.
    // Renormalized: (100×0.25 + 50×0.20) / 0.45 = 35 / 0.45 = 77.8 → 78.
    const result = scoreFactors(factorMap([factor(50, 0.2), factor(100, 0.25), null, null, null]));
    assert.equal(result.score, 78);

    // The point of renormalizing, made explicit: dividing by a fixed 1.0 would
    // give 35 — a protocol punished for a factor that doesn't apply to it.
    assert.notEqual(result.score, 35);
  });

  it('scores a single applicable factor as its own value, whatever its weight', () => {
    // With one factor the weight cancels entirely (v×w / w === v). This is the
    // property that makes a weight change safe for single-factor protocols.
    for (const weight of [0.15, 0.2, 0.25, 1]) {
      assert.equal(scoreFactors(factorMap([factor(22, weight), null, null, null, null])).score, 22);
    }
  });

  it('returns 0, not NaN, when every factor is null', () => {
    const result = scoreFactors(factorMap([null, null, null, null, null]));
    assert.equal(result.score, 0);
    assert.ok(!Number.isNaN(result.score), 'a 0/0 division must not leak out as NaN');
  });

  it('returns 0 when the applicable factors all carry zero weight', () => {
    // Degenerate but reachable by a mis-declared adapter: guarding on
    // totalWeight === 0 (not on "no non-null factors") is what covers it.
    const result = scoreFactors(factorMap([factor(90, 0), factor(90, 0), null, null, null]));
    assert.equal(result.score, 0);
  });
});

describe('scoreFactors — output shape', () => {
  it('rounds to nearest, half upward', () => {
    // Pinned because a switch to banker's rounding would move published scores
    // by a point without touching a single threshold.
    const score = (v: number) =>
      scoreFactors(factorMap([factor(v, 1), null, null, null, null])).score;

    // Exact halves go to the higher integer, both from an even and an odd base
    // (banker's rounding would send 52.5 to 52).
    assert.equal(score(53.5), 54);
    assert.equal(score(52.5), 53);

    // And it is nearest-rounding, not a ceiling or a floor. Without these the
    // suite passes with Math.ceil substituted in — the halves alone don't
    // distinguish the two.
    assert.equal(score(52.4), 52);
    assert.equal(score(52.6), 53);
  });

  it('returns the factor map unchanged and a real computedAt', () => {
    const factors = factorMap([factor(70, 0.2), null, null, null, null]);
    const result = scoreFactors(factors);
    // Passed through by reference: the indexer persists exactly what it scored.
    assert.equal(result.factors, factors);
    assert.ok(result.computedAt instanceof Date);
    assert.ok(Number.isFinite(result.computedAt.getTime()));
  });

  it('always produces a score inside 0-100 for in-range factors', () => {
    for (const v of [0, 1, 50, 99, 100]) {
      const score = scoreFactors(
        factorMap([factor(v, 0.2), factor(v, 0.25), null, null, null]),
      ).score;
      assert.ok(score >= 0 && score <= 100, `score ${score} out of range for factor value ${v}`);
    }
  });
});

describe('freshnessWindow', () => {
  it("uses both of the protocol's own anchors when they are sane (Blend)", () => {
    // METHODOLOGY.md §2a: Blend reads resolution 300s and max_age 900s off its
    // own oracle aggregator. Neither is a Stenion constant.
    assert.deepEqual(freshnessWindow(300, 900), { fresh: 300, dead: 900 });
  });

  it("caps a protocol's over-generous max age at STALE_CEILING_SECONDS (K2)", () => {
    // K2's per-asset max_age is 43200s (12h). Anchoring to it unmodified would
    // score a six-hour-old price ~50 — i.e. reward a protocol for tolerating
    // staler prices. METHODOLOGY.md §2a flags this cap as the one Stenion
    // constant left in the factor.
    const { fresh, dead } = freshnessWindow(30, 43200);
    assert.equal(fresh, 30);
    assert.equal(dead, STALE_CEILING_SECONDS);
    assert.notEqual(dead, 43200);
  });

  it('is documented at 3600s and stays there', () => {
    assert.equal(STALE_CEILING_SECONDS, 3600);
    assert.ok(
      LENDING_METHODOLOGY.includes('3600'),
      'methodology/lending.md should still document the 3600s stale ceiling',
    );
  });

  it('collapses a missing or nonsensical resolution to a zero fresh bound', () => {
    // A feed that publishes no resolution shouldn't crash or invert the window;
    // it should just mean "any age at all is already imperfect".
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { fresh, dead } = freshnessWindow(bad, 900);
      assert.equal(fresh, 0, `resolution ${bad} should collapse fresh to 0`);
      assert.equal(dead, 900);
    }
  });

  it('falls back to the ceiling when the protocol declares no usable max age', () => {
    for (const bad of [0, -1, Number.NaN]) {
      assert.equal(freshnessWindow(300, bad).dead, STALE_CEILING_SECONDS);
    }
  });

  it('always returns dead > fresh, so the grading window is never degenerate', () => {
    // This is the invariant that keeps the adapters' `lerp01(age, dead, fresh)`
    // out of its `a === b` branch — where it would stop being a curve and become
    // a step function. If this ever fails, that branch has become reachable and
    // the adapters need re-checking, not just this file.
    const values = [0, 1, 30, 300, 900, 3600, 43200, -1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const resolution of values) {
      for (const maxAge of values) {
        const { fresh, dead } = freshnessWindow(resolution, maxAge);
        assert.ok(
          dead > fresh,
          `freshnessWindow(${resolution}, ${maxAge}) produced a degenerate window ` +
            `{ fresh: ${fresh}, dead: ${dead} }`,
        );
      }
    }
  });

  it('widens the window when a feed publishes slower than its own staleness limit', () => {
    // resolution >= max age: the protocol's own numbers give no usable range, so
    // the window is widened rather than trusted, keeping newer prices ordered
    // above older ones instead of collapsing to a step.
    const { fresh, dead } = freshnessWindow(3600, 3600);
    assert.equal(fresh, 3600);
    assert.ok(dead > fresh, 'expected the degenerate case to be widened');
  });
});

// ---------------------------------------------------------------------------
// sizeReserves — the §4/§5 minimum-size filter.
//
// This lives in core for the same reason scoreFactors does: it is one shared
// rule, and two adapters implementing it separately would be two rules waiting
// to drift. The OR structure is the part that needs pinning — each leg exists to
// cover a failure the other one has, so a "simplification" to a single test
// would quietly reintroduce one of them.
// ---------------------------------------------------------------------------

describe('sizeReserves — the minimum-size filter (METHODOLOGY.md §4/§5)', () => {
  const scored = (usd: (number | null)[], floor: number | null) =>
    sizeReserves(usd, floor).map((r) => r.scored);

  it('keeps a reserve that passes either leg, and drops only one that fails both', () => {
    // Pool of 1000. The 50 clears both. The 6 fails the share test (0.6%… wait,
    // it passes) — so the cases are laid out explicitly instead:
    //   500 → 50% share, above $5      → kept (both)
    //   494 → 49.4% share, above $5    → kept (both)
    //     5 → 0.5% share exactly, = $5 → kept (both, on the boundary)
    //     1 → 0.1% share, below $5     → DROPPED (neither)
    assert.deepEqual(scored([500, 494, 5, 1], 5), [true, true, true, false]);
  });

  it('leg A alone rescues a reserve far below the relative floor', () => {
    // $10 of a $1,000,010 pool is 0.001%. Relative-only would drop half a
    // million dollars' worth on a large pool; the protocol's own floor is what
    // stops that, and this is the error direction that hides real risk.
    assert.deepEqual(scored([1_000_000, 10], 5), [true, true]);
    assert.deepEqual(scored([1_000_000, 10], null), [true, false]);
  });

  it('leg B alone rescues every reserve of a pool smaller than any sane floor', () => {
    // K2's live pool totals ~$1,500. An absolute-only filter set anywhere
    // sensible for a real market excludes all of it, sending both factors to
    // cannot-assess and DROPPING the protocol's score — a worse outcome than
    // the problem being fixed.
    assert.deepEqual(scored([1_443, 54, 36, 4], null), [true, true, true, false]);
  });

  it('stands aside entirely when nothing can be priced', () => {
    // No denominator, so no filter — §4/§5 degrade to exactly their pre-filter
    // behaviour rather than refusing to score with the oracle down.
    assert.deepEqual(scored([null, null, null], 5), [true, true, true]);
    assert.deepEqual(sizeReserves([null, null], 5)[0], {
      scored: true,
      suppliedUsd: null,
      share: null,
    });
  });

  it('keeps an individual unpriced reserve rather than treating it as worthless', () => {
    // "We could not measure it" is not "it is empty", and the difference decides
    // whether a reserve gets silently dropped.
    assert.deepEqual(scored([1_000, null, 1], 5), [true, true, false]);
  });

  it('ignores a nonsensical floor instead of trusting it', () => {
    // A zero/negative/NaN min_collateral means the pool declares none. It must
    // not become a floor everything trivially clears.
    for (const bad of [0, -5, Number.NaN]) {
      assert.deepEqual(scored([1_000, 1], bad), [true, false], `floor ${bad}`);
    }
  });

  it('reports the share it judged each reserve on', () => {
    const sized = sizeReserves([750, 250], null);
    assert.deepEqual(
      sized.map((r) => r.share),
      [0.75, 0.25],
    );
    assert.deepEqual(
      sized.map((r) => r.suppliedUsd),
      [750, 250],
    );
  });

  it('cannot empty the scored set on any pool of 200 reserves or fewer', () => {
    // Shares sum to 1, so the largest is always >= 1/n. That is why the
    // all-excluded branch in each adapter is unreachable on real data — and why
    // it is pinned synthetically there rather than left untested.
    for (const n of [1, 2, 5, 64, 200]) {
      const sized = sizeReserves(
        Array.from({ length: n }, () => 1),
        null,
      );
      assert.ok(
        sized.some((r) => r.scored),
        `${n} equal reserves: at least one must survive`,
      );
    }
    // 201 is the first count where an even split starves every reserve.
    const starved = sizeReserves(
      Array.from({ length: 201 }, () => 1),
      null,
    );
    assert.ok(
      starved.every((r) => !r.scored),
      'the boundary is real, and callers must handle it',
    );
  });

  it('agrees with the threshold METHODOLOGY.md publishes', () => {
    // Reading the doc rather than restating its number, for the reason at the
    // top of this file: a test that hardcodes the threshold is a third copy to
    // keep in sync, not a guard against drift.
    const match = LENDING_METHODOLOGY.match(
      /([\d.]+)%\s+of\s+the\s+pool['’]s\s+own\s+total\s+supplied/i,
    );
    assert.ok(match, 'could not find the minimum-size threshold in methodology/lending.md §4');
    assert.equal(Number(match[1]) / 100, MIN_RESERVE_POOL_SHARE);
  });
});

describe('excludedComponent — the disclosure for what the filter set aside', () => {
  it('publishes nothing when nothing was excluded', () => {
    // Spread by the caller, so an empty object means the factor carries no
    // components at all rather than an empty array.
    assert.deepEqual(excludedComponent([], 'free liquidity'), {});
  });

  it('discloses the reserve, its size, its share and the score it suppressed', () => {
    const { components } = excludedComponent(
      [{ asset: 'CDUSTAAAAAA', scored: false, suppliedUsd: 3, share: 0.0019, wouldHaveScored: 34 }],
      'free liquidity',
    );
    const detail = components![0].detail;
    assert.equal(components![0].value, null, 'measured, shown, deliberately not graded');
    assert.match(detail, /CDUSTA…/);
    assert.match(detail, /\$3\.00/);
    assert.match(detail, /0\.19% of pool/);
    assert.match(detail, /would have scored 34/);
    assert.match(detail, /free liquidity/);
  });

  it('says so plainly when a reserve had no score to suppress', () => {
    // §5's no-configured-cap case: excluded AND ungradeable. "would have scored
    // 0" would be a fabricated number for a reserve that had none.
    const { components } = excludedComponent(
      [{ asset: 'CNOCAP', scored: false, suppliedUsd: 1, share: 0.001, wouldHaveScored: null }],
      'utilization headroom',
    );
    assert.match(components![0].detail, /would not have scored/);
    assert.doesNotMatch(components![0].detail, /would have scored \d/);
  });
});

// ---------------------------------------------------------------------------
// worstReserves / describeWorst — every reserve at the binding value, not one.
//
// WHY THESE EXIST: the previous selection kept a single reserve and, comparing
// with `<=`, kept whichever came LAST in iteration order. That produced a
// detail string that reads like a diagnosis but is really a tie-break, and it
// caused a real misdiagnosis — a bug report claimed K2's oracleSafety of 0
// traced to a $4.00 dust reserve, when a reserve thirteen times larger was
// equally dead and simply never named. The score was always right; only the
// explanation was wrong. These pin the explanation.
// ---------------------------------------------------------------------------

describe('worstReserves — keeps every reserve at the binding score', () => {
  const r = (asset: string, score: number, note = `note-${asset}`) => ({ asset, score, note });

  it('reports the minimum, which is what the sub-signal publishes', () => {
    assert.equal(worstReserves([r('CA', 90), r('CB', 12), r('CC', 40)]).score, 12);
  });

  it('keeps all reserves tied at the minimum, not the last one seen', () => {
    // The old behaviour kept exactly one of these — CC, purely because it came
    // last. Both are equally the binding constraint.
    const w = worstReserves([r('CA', 90), r('CB', 0), r('CC', 0)]);
    assert.deepEqual(
      w.tied.map((t) => t.asset),
      ['CB', 'CC'],
    );
    assert.equal(w.total, 3);
  });

  it('preserves input order in the tied set', () => {
    // So the disclosure reads in reserve order rather than in whatever order a
    // filter happened to produce.
    const w = worstReserves([r('CA', 0), r('CB', 5), r('CC', 0), r('CD', 0)]);
    assert.deepEqual(
      w.tied.map((t) => t.asset),
      ['CA', 'CC', 'CD'],
    );
  });

  it('ties on the exact score, not the published rounded one', () => {
    // 12.4 and 12.6 both publish as 12 and 13 respectively but are genuinely
    // different scores; calling them tied would swap one misleading claim for
    // another. Real ties sit at the clamped ends, where equality is exact.
    const w = worstReserves([r('CA', 12.4), r('CB', 12.6)]);
    assert.deepEqual(
      w.tied.map((t) => t.asset),
      ['CA'],
    );
  });

  it('handles an empty set without inventing a reserve', () => {
    const w = worstReserves([]);
    assert.deepEqual(w, { score: 0, tied: [], total: 0 });
    assert.equal(describeWorst(w), 'no reserves');
  });
});

describe('describeWorst — a tie is described as a tie', () => {
  const r = (asset: string, score: number, note: string) => ({ asset, score, note });

  it('names the reserve when exactly one is worst', () => {
    const text = describeWorst(worstReserves([r('CAAAAAAA', 0, '900s old'), r('CB', 90, 'fine')]));
    assert.equal(text, 'worst reserve (CAAAAA…) 900s old');
  });

  it('does not say "worst" when every reserve scores the same', () => {
    // Blend's permanent state on freshness: one aggregator publish round prices
    // every reserve, so all ages are identical. Calling one of them the worst
    // reads as a finding about that reserve when there is no finding at all.
    const text = describeWorst(
      worstReserves([r('CA', 100, '233s old'), r('CB', 100, '233s old'), r('CC', 100, '233s old')]),
    );
    assert.equal(text, 'all 3 reserves score the same — 233s old');
    assert.doesNotMatch(text, /worst/);
  });

  it('says "worst" when only some tie, because the rest really are better', () => {
    // K2's case, and the one that produced the misdiagnosis. BOTH dead feeds
    // must appear — naming only the second is what made a $4.00 reserve look
    // like the sole cause.
    const text = describeWorst(
      worstReserves([
        r('CUSDCAAA', 0, '19599s old'),
        r('CXLMAAAA', 96, '167s old'),
        r('CPYUSDAA', 0, '39955s old'),
        r('CSOLVAAA', 100, '17s old'),
      ]),
    );
    assert.equal(
      text,
      '2 of 4 reserves tied at the worst score — CUSDCA… 19599s old; CPYUSD… 39955s old',
    );
  });

  it('prints a shared note once and differing notes per reserve', () => {
    const shared = describeWorst(worstReserves([r('CA', 0, 'same'), r('CB', 0, 'same')]));
    assert.equal(shared, 'all 2 reserves score the same — same');

    const differing = describeWorst(worstReserves([r('CA', 0, 'one'), r('CB', 0, 'two')]));
    assert.match(differing, /CA… one; CB… two$/);
  });
});

// ---------------------------------------------------------------------------
// describePriceAges — the per-feed staleness disclosure.
//
// WHY IT EXISTS: `priceFreshness` grades the worst reserve, so a reader sees a
// single number and cannot tell the SPREAD. "oracleSafety 0" reads as a general
// condition of the oracle; "two feeds untouched for hours while two others
// update every few seconds, through one contract and one source" is a specific
// checkable claim about which feeds are maintained. Only the second is
// actionable, and it was previously unreadable from anything published.
// ---------------------------------------------------------------------------

describe('describePriceAges — per-feed ages, disclosed not graded', () => {
  const age = (feed: string | null, ageSeconds: number | null, asset = `C${feed}AAAAAA`) => ({
    asset,
    feed,
    ageSeconds,
  });

  it('surfaces the spread that a single worst-reserve score hides', () => {
    // K2's live shape. The point is that both ends are visible at once.
    const text = describePriceAges(
      [age('USDC', 21421), age('XLM', 177), age('PYUSD', 41777), age('SolvBTC', 27)],
      3600,
    );
    assert.match(text, /PYUSD 41777s, USDC 21421s, XLM 177s, SolvBTC 27s/, 'oldest first');
    assert.match(text, /2 of 4 past the protocol's own 3600s staleness limit \(USDC, PYUSD\)/);
  });

  it('orders oldest-first, because the stale end is the point', () => {
    const text = describePriceAges([age('A', 1), age('B', 900), age('C', 30)], 3600);
    assert.match(text, /B 900s, C 30s, A 1s/);
  });

  it('sorts an unusable price as the oldest, not the freshest', () => {
    // No price at all is not fresher than a merely old one; ranking it by a
    // missing number would put the worst case at the top of the list.
    const text = describePriceAges([age('FRESH', 10), age('MISSING', null)], 3600);
    assert.match(text, /MISSING no usable price, FRESH 10s/);
    assert.match(text, /1 of 2 past/, 'an unusable price counts as stale');
  });

  it('says so plainly when every feed is inside the limit', () => {
    // Blend's normal state. A disclosure that only appears when something is
    // wrong gives a reader no healthy baseline to compare against.
    const text = describePriceAges([age('X', 233), age('Y', 233)], 900);
    assert.match(text, /all 2 within the protocol's own 900s staleness limit/);
    assert.doesNotMatch(text, /past the protocol/);
  });

  it('counts against the protocol’s own limit, never a Stenion one', () => {
    // The same ages under two different protocol-declared limits give different
    // counts — the claim is "how many the protocol itself would call stale".
    const ages = [age('A', 1000), age('B', 100)];
    assert.match(describePriceAges(ages, 900), /1 of 2 past/);
    assert.match(describePriceAges(ages, 3600), /all 2 within/);
  });

  it('falls back to the address when a protocol publishes no feed label', () => {
    const text = describePriceAges([{ asset: 'CABCDEFGHIJ', feed: null, ageSeconds: 5 }], 900);
    assert.match(text, /CABCDE… 5s/);
  });

  it('handles a pool with nothing to report', () => {
    assert.equal(describePriceAges([], 3600), 'no reserves to report a price age for');
  });

  it('shortens a full address inside the label a protocol publishes', () => {
    // The YieldBlox case. Blend's aggregator maps a reserve to either
    // Asset::Other(Symbol) or Asset::Stellar(Address), so `upstreamAsset` is a
    // symbol on one pool and a 64-character unbreakable token on the next. The
    // fallback above shortened; the label branch did not, and the label branch
    // is the one that runs here.
    const text = describePriceAges(
      [
        {
          asset: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
          feed: 'Stellar:CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
          ageSeconds: 396,
        },
      ],
      900,
    );
    assert.match(text, /Stellar:CAS3J7… 396s/, 'the qualifier survives, the address does not');
    assert.doesNotMatch(text, /CAS3J7GYLGXMF6TD/, 'no full address is left in the string');
  });

  it('leaves a feed label that is not an address exactly as the protocol writes it', () => {
    // K2's feedIds. Shortening is for addresses only — a label that is already
    // a name must not be mangled by a rule aimed at something else.
    const text = describePriceAges(
      [age('SolvBTC_FUNDAMENTAL/USD', 27), age('Other:XLM', 233)],
      3600,
    );
    assert.match(text, /SolvBTC_FUNDAMENTAL\/USD 27s/);
    assert.match(text, /Other:XLM 233s/);
  });
});
