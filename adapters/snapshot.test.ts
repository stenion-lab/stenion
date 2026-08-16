// Regression tests against frozen mainnet snapshots.
//
// WHY THESE EXIST, given the synthetic suites already cover the rules: the
// synthetic fixtures are hand-built, and every one of them picks convenient
// numbers — rate = 1.0, decimals = 7, round balances. Real pools do not. The
// captured Blend reserves carry b_rate/d_rate of 1.0015, 1.1392 and 1.2214, so
// the fixed-point scaling in `reserveTotals` is only genuinely exercised here;
// with a unit rate, a bug in the SCALAR_12 divisor cancels out and every
// synthetic assertion still passes. Kinetic contributes 8-decimal balances down
// to dust (0.0005668) alongside 7-decimal ones.
//
// So this file answers a different question from the others. They ask "does the
// rulebook say what METHODOLOGY.md says". This one asks "did a refactor move a
// published number on real data" — and it is the only thing that would notice a
// decode or scaling regression.
//
// The expected values below are what the adapters produced at capture time.
// They are not aspirational: if one changes, either the fixture was regenerated
// (re-derive them deliberately) or something regressed. Do not update a number
// here without knowing which.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BlendAdapter } from './blend.ts';
import { KineticAdapter } from './kinetic.ts';
import { blendMainnet } from './fixtures/blend-mainnet.ts';
import { kineticMainnet } from './fixtures/kinetic-mainnet.ts';
import type { RiskFactor, RiskFactorMap } from '@stenion/core';

const values = (f: RiskFactorMap) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === null ? null : v.value]));

const sub = (f: RiskFactor, id: string) => f.components?.find((c) => c.id === id)?.value;

describe('Blend — frozen mainnet snapshot', () => {
  it('produces exactly the factor map captured with it', async () => {
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.deepEqual(values(factors), {
      collateralSafety: 70,
      oracleSafety: 100,
      adminKeySafety: 40,
      liquiditySafety: 21,
      utilizationSafety: 12,
    });
  });

  it('scores 53 — and that is the weighted mean of those five', async () => {
    // Cross-checked by hand so a failure separates "a factor moved" from "the
    // weighting moved": 70×0.20 + 100×0.25 + 40×0.20 + 21×0.15 + 12×0.20 = 52.55.
    const adapter = new BlendAdapter();
    const factors = await adapter.computeRiskFactors(blendMainnet);
    assert.equal(adapter.score(factors).score, 53);
  });

  it('reports both oracle sub-signals on real aggregator config', async () => {
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.equal(sub(factors.oracleSafety!, 'priceFreshness'), 100);
    assert.equal(sub(factors.oracleSafety!, 'deviationBound'), 100);
    // Tightness stays a disclosure on real data too, not just in synthetic cases.
    assert.equal(sub(factors.oracleSafety!, 'deviationTightness'), null);
  });

  it('still exercises non-unit interest rates — the reason this fixture exists', async () => {
    // A guard on the fixture rather than on the adapter. If a regenerated
    // snapshot ever landed with every rate at exactly SCALAR_12, this file would
    // silently stop covering the scaling it was added for, and nothing else
    // would notice.
    const SCALAR_12 = 10n ** 12n;
    const nonUnit = blendMainnet.reserves.filter(
      (r) => r.data.bRate !== SCALAR_12 || r.data.dRate !== SCALAR_12,
    );
    assert.ok(
      nonUnit.length > 0,
      'every captured rate is 1.0 — recapture, or this fixture adds nothing over the synthetic ones',
    );
  });
});

describe('Kinetic — frozen mainnet snapshot', () => {
  it('produces exactly the factor map captured with it', async () => {
    const factors = await new KineticAdapter().computeRiskFactors(kineticMainnet);
    assert.deepEqual(values(factors), {
      collateralSafety: 15,
      oracleSafety: 0,
      adminKeySafety: 60,
      liquiditySafety: 34,
      utilizationSafety: 18,
    });
  });

  it('scores 24', async () => {
    // 15×0.20 + 0×0.25 + 60×0.20 + 34×0.15 + 18×0.20 = 23.7.
    const adapter = new KineticAdapter();
    const factors = await adapter.computeRiskFactors(kineticMainnet);
    assert.equal(adapter.score(factors).score, 24);
  });

  it('scores oracleSafety 0 on a genuinely stale price, with the breaker armed', async () => {
    // This is K2's ordinary state, not an unlucky capture: 533 of its 588
    // methodology-v2 rows carry oracleSafety 0. The two sub-signals disagreeing
    // is the whole point of the v2 composite — the circuit breaker IS armed, and
    // the factor is still 0, because a bounded stale price is untrustworthy.
    const factors = await new KineticAdapter().computeRiskFactors(kineticMainnet);
    assert.equal(sub(factors.oracleSafety!, 'priceFreshness'), 0);
    assert.equal(sub(factors.oracleSafety!, 'deviationBound'), 100);
    assert.equal(factors.oracleSafety!.value, 0, 'the binding constraint is freshness');
  });

  it('handles reserves whose balances differ by orders of magnitude', async () => {
    // The captured set spans a 9,418-unit reserve and a 0.0005668 one, across 7-
    // and 8-decimal assets. Dust must stay dust through the decimals decode —
    // an off-by-one there would turn it into a pool-dominating balance.
    const decimals = new Set(kineticMainnet.reserves.map((r) => r.decimals));
    assert.ok(decimals.size > 1, 'fixture should span more than one decimals value');
    const supplied = kineticMainnet.reserves.map((r) => Number(r.suppliedRaw) / 10 ** r.decimals);
    assert.ok(
      Math.max(...supplied) / Math.min(...supplied) > 1e6,
      'expected a wide balance spread',
    );
  });
});

describe('both snapshots', () => {
  it('populate all five factors with real detail strings', async () => {
    for (const [factors] of [
      [await new BlendAdapter().computeRiskFactors(blendMainnet)],
      [await new KineticAdapter().computeRiskFactors(kineticMainnet)],
    ]) {
      for (const [key, factor] of Object.entries(factors)) {
        assert.ok(factor, `${key} should be populated on live data`);
        assert.ok(factor.detail.length > 10, `${key} needs a real detail string`);
        assert.ok(Number.isInteger(factor.value), `${key} should be a whole number`);
        assert.ok(factor.value >= 0 && factor.value <= 100, `${key} out of range`);
      }
    }
  });
});
