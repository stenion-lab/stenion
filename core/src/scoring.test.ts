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
import type { RiskFactor, RiskFactorMap } from './types.ts';
import { STALE_CEILING_SECONDS, freshnessWindow, scoreFactors } from './scoring.ts';

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

const METHODOLOGY = repoFile('METHODOLOGY.md');

/**
 * The "Factor weights" table: rows like ``| `oracleSafety` | 0.25 |``.
 * The `Total` row is excluded by requiring a `*Safety` name.
 */
function docWeightTable(): { factor: string; weight: number }[] {
  const rows = [...METHODOLOGY.matchAll(/^\|\s*`(\w+Safety)`\s*\|\s*([\d.]+)\s*\|/gm)];
  assert.ok(
    rows.length > 0,
    'could not parse the factor-weight table out of METHODOLOGY.md — has its format changed?',
  );
  return rows.map((m) => ({ factor: m[1], weight: Number(m[2]) }));
}

/**
 * The worked example, e.g.
 * `70×0.20 + 100×0.25 + 40×0.20 + 22×0.15 + 14×0.20 = 53.1 → 53`
 *
 * Returns the (value, weight) pairs plus the score the doc claims they produce.
 */
function docWorkedExample(): { pairs: [number, number][]; stated: number; rounded: number } {
  const line = METHODOLOGY.split('\n').find((l) => /×/.test(l) && /→/.test(l) && /\+/.test(l));
  assert.ok(line, 'could not find the worked example line in METHODOLOGY.md');

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

/** A full five-key map from entries in FACTOR_KEYS order; `null` means "doesn't apply". */
function factorMap(entries: (RiskFactor | null)[]): RiskFactorMap {
  assert.equal(entries.length, FACTOR_KEYS.length, 'factorMap needs one entry per factor');
  return Object.fromEntries(FACTOR_KEYS.map((k, i) => [k, entries[i]])) as RiskFactorMap;
}

// ---------------------------------------------------------------------------

describe('scoreFactors — agreement with METHODOLOGY.md', () => {
  it("reproduces the doc's worked example exactly", () => {
    const { pairs, stated, rounded } = docWorkedExample();

    assert.equal(
      pairs.length,
      FACTOR_KEYS.length,
      'the worked example should have one term per factor',
    );

    // The mean is order-independent, so which key holds which value doesn't
    // affect the result — the doc's line doesn't label them anyway.
    const result = scoreFactors(factorMap(pairs.map(([v, w]) => factor(v, w))));

    assert.equal(
      result.score,
      rounded,
      `scoreFactors disagrees with METHODOLOGY.md's worked example ` +
        `(doc says ${rounded}, code says ${result.score}). Code and the doc are not ` +
        `allowed to drift — fix whichever is wrong, in the same change.`,
    );

    // The doc writes the pre-rounding value as 53.1. In IEEE-754 the sum is
    // actually 53.099999999999994, so this is checked with a tolerance rather
    // than by equality — asserting the exact literal would fail for a reason
    // that has nothing to do with the rulebook.
    const exact = pairs.reduce((a, [v, w]) => a + v * w, 0);
    const totalWeight = pairs.reduce((a, [, w]) => a + w, 0);
    assert.ok(
      Math.abs(exact / totalWeight - stated) < 0.005,
      `doc states a pre-rounding value of ${stated}, computed ${exact / totalWeight}`,
    );
  });

  it("the doc's weight table sums to 1.00 and matches the worked example's weights", () => {
    const table = docWeightTable();
    assert.equal(table.length, FACTOR_KEYS.length, 'expected five weighted factors');

    const sum = table.reduce((a, r) => a + r.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `factor weights should sum to 1.00, got ${sum}`);

    // The doc states its weights twice — once in the table, once inline in the
    // worked example. They must agree with each other, or the doc contradicts
    // itself regardless of what the code does.
    const fromTable = table.map((r) => r.weight).sort();
    const fromExample = docWorkedExample()
      .pairs.map(([, w]) => w)
      .sort();
    assert.deepEqual(
      fromExample,
      fromTable,
      "the worked example's weights differ from the table's",
    );
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
      docWeightTable()
        .map((r) => r.factor)
        .sort(),
      fromEnum,
      "METHODOLOGY.md's weight table names a different set of factors than the enum",
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
      METHODOLOGY.includes('3600'),
      'METHODOLOGY.md should still document the 3600s stale ceiling',
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
