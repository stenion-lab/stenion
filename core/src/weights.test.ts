// Tests for the per-category factor declarations.
//
// WHY THESE EXIST. `scoreFactors` renormalizes by the *observed* total weight,
// not by a fixed 1.0 — that is what makes a null factor genuinely excluded
// rather than counted as a zero (see `scoring.ts`). The cost of that design is
// that a weight set which does NOT sum to 1.00 produces no symptom at all: the
// mean still divides by whatever the weights add up to, and every score still
// looks like a score. Nothing else in the codebase would notice. So the sum is
// asserted here, per category, as the property the whole weighting rests on.
//
// The second half is the compile-time claim made runnable: `CATEGORY_FACTORS` is
// declared `satisfies Record<ProtocolCategory, …>`, which catches a category
// with no factor set but says nothing about a factor set with no factors, a
// weight of 0, or a weight outside (0, 1]. Those are checked below.
//
// THE WEIGHT ASSERTIONS ARE SCOPED TO PUBLISHED CATEGORIES, and that is a real
// distinction rather than an exemption. `dex` (#100) is admitted as a factor set
// with its weight table deliberately deferred to #102, so it declares
// `status: 'pendingWeights'` and carries no weights to sum. A test that skipped
// it silently would be a hole; the tests below instead assert the OPPOSITE
// property for it — that no factor in such a category carries a weight at all —
// so neither state can be reached by accident.
//
// WHAT IS NOT TESTED HERE: whether lending's weights match METHODOLOGY.md. That
// pinning lives in `scoring.test.ts`, which parses the published table out of
// the document — a value restated in TypeScript is a third copy, not a check.
//
// Run with: pnpm --filter @stenion/core test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// VALUE imports, deliberately: this file is also the proof that both modules
// load under the strip-only test runner. `weights.ts` imports `ProtocolCategory`
// as a type only, so at runtime it is a leaf — if that import ever becomes a
// value import, this file is where it shows up.
import { PROTOCOL_CATEGORIES } from './category.ts';
import { CATEGORY_FACTORS, LENDING_FACTORS } from './weights.ts';

const categories = () => Object.entries(CATEGORY_FACTORS);

describe('the per-category factor declarations', () => {
  it('is value-importable under the test runner', () => {
    assert.equal(typeof CATEGORY_FACTORS, 'object');
  });

  it('declares a factor set for every category, and no others', () => {
    // The `satisfies` clause already requires every category to be present. This
    // asserts the other direction — that nothing has been declared for a
    // category the registry does not publish — and states the pairing in a form
    // that fails loudly rather than being inferred from a type annotation.
    assert.deepEqual(Object.keys(CATEGORY_FACTORS).sort(), [...PROTOCOL_CATEGORIES].sort());
  });

  it("every PUBLISHED category's weights sum to 1.00", () => {
    for (const [category, declaration] of categories()) {
      if (declaration.status !== 'published') continue;
      const sum = Object.values(declaration.factors).reduce((a, f) => a + f.weight, 0);
      assert.ok(
        Math.abs(sum - 1) < 1e-9,
        `${category}'s factor weights sum to ${sum}, not 1.00. ` +
          `scoreFactors divides by the observed total, so this would not fail ` +
          `anywhere else — every score would just be quietly computed against ` +
          `the wrong denominator.`,
      );
    }
  });

  it('gives every factor a real label, and a real weight where the category has them', () => {
    for (const [category, declaration] of categories()) {
      const { label, factors } = declaration;
      assert.ok(label.length > 0, `${category} needs a display label`);
      const keys = Object.keys(factors);
      assert.ok(keys.length > 0, `${category} declares no factors`);

      for (const key of keys) {
        const where = `${category}.${key}`;
        assert.match(key, /^[a-z][A-Za-z]*Safety$/, `${where}: factor keys end in *Safety`);
      }

      if (declaration.status !== 'published') continue;
      for (const [key, decl] of Object.entries(declaration.factors)) {
        assert.ok(
          decl.weight > 0 && decl.weight <= 1,
          `${category}.${key}: weight ${decl.weight} is outside (0, 1]`,
        );
      }
    }
  });

  it('gives every factor a human label whatever the category status', () => {
    // Split out from the weight checks above so a pendingWeights category is
    // still held to the label bar — a factor with no name is unpublishable in
    // either state, and `continue`-ing past the whole loop would have exempted
    // it by accident.
    for (const [category, { factors }] of categories()) {
      for (const [key, decl] of Object.entries(factors)) {
        assert.ok(decl.label.length > 0, `${category}.${key} needs a human label`);
      }
    }
  });

  it('carries no weight at all on a pendingWeights category', () => {
    // THE ASSERTION THE STATE EXISTS FOR. `dex` was admitted as a factor SET
    // (#100); its weights are a separate review (#102) precisely because
    // TAXONOMY.md Gate 1 makes them a labelled judgment call rather than an
    // anchored reading. A `0`, a `0.33` placeholder, or a half-filled table
    // would be indistinguishable from a reviewed value the moment anyone read
    // it — so the property must be ABSENT, not falsy.
    //
    // The compiler already forbids reading `.weight` off an unweighted
    // declaration. This is the runtime half: a stray value assigned through an
    // `as` or a spread would satisfy the type and fail here.
    for (const [category, declaration] of categories()) {
      if (declaration.status === 'published') continue;
      for (const [key, decl] of Object.entries(declaration.factors)) {
        assert.ok(
          !('weight' in decl),
          `${category}.${key} is in a pendingWeights category but carries a weight. ` +
            `Either the weight table was reviewed — in which case flip status to ` +
            `'published' and publish the table in methodology/${category}.md — or it ` +
            `was guessed, which is the thing this state exists to prevent.`,
        );
      }
    }
  });

  it('declares a status for every category, and only the two that exist', () => {
    for (const [category, { status }] of categories()) {
      assert.ok(
        status === 'published' || status === 'pendingWeights',
        `${category} has status '${status}', which is neither state`,
      );
    }
  });

  it('keeps lending published, and dex pending until #102', () => {
    // Pins the two current answers so that flipping either is a deliberate,
    // reviewed act rather than a one-word edit. Turning `dex` to 'published'
    // must land with its weight table in methodology/dex.md, which
    // scoring.test.ts then parses and pins against this map.
    assert.equal(CATEGORY_FACTORS.lending.status, 'published');
    assert.equal(CATEGORY_FACTORS.dex.status, 'pendingWeights');
  });

  it("declares dex's two factors, sharing adminKeySafety's key with lending", () => {
    // Open question B on #100, resolved as: one name for one question, computed
    // from different data on each side (Aquarius's seven roles plus an upgrade
    // deadline; a lending pool's single admin's signer set). The shared key is
    // what stops the taxonomy fragmenting into synonyms — and it is NOT a
    // comparability claim, since scores are not comparable across categories
    // whatever the keys are called.
    assert.deepEqual(Object.keys(CATEGORY_FACTORS.dex.factors), [
      'adminKeySafety',
      'assetControlSafety',
    ]);
    assert.ok(
      'adminKeySafety' in CATEGORY_FACTORS.lending.factors,
      'the shared key is only shared while lending still declares it',
    );
  });

  it('does not declare depthSafety — it is deferred, and a declaration is a promise', () => {
    // Open question A resolved to option 4: no depth factor until Aquarius has an
    // on-chain unit of value to denominate a trade size in. Declaring the key
    // anyway — as a placeholder, or "so the taxonomy is complete" — would publish
    // a factor the rulebook has no formula for, which is the same class of claim
    // as a placeholder weight. It arrives, if it arrives, as a labelled version
    // bump on a live category.
    assert.ok(
      !('depthSafety' in CATEGORY_FACTORS.dex.factors),
      'depthSafety is deferred (open question A, option 4) and must not be declared ' +
        'until methodology/dex.md publishes a formula and a trade size for it',
    );
  });

  it('has no two factors sharing a label within a category', () => {
    // Two factors with the same display name are indistinguishable wherever the
    // label is what a reader sees, which is the one job a label has.
    for (const [category, { factors }] of categories()) {
      const labels = Object.values(factors).map((f) => f.label);
      assert.equal(new Set(labels).size, labels.length, `${category} reuses a factor label`);
    }
  });

  it('exposes lending as the same object, not a copy', () => {
    // `LENDING_FACTORS` is a convenience alias for the adapters to read. If it
    // ever becomes a separate literal it becomes a second source of the weights,
    // which is the whole thing this module was added to stop.
    assert.equal(LENDING_FACTORS, CATEGORY_FACTORS.lending.factors);
  });
});
