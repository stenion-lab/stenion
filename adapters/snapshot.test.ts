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
// FOUR FIXTURES, TWO ADAPTERS. `blend`, `yieldblox` and `etherfuse` are the same
// BlendAdapter pointed at three different pools, so between them they answer a
// question none could alone: whether the multi-pool refactor left the engine
// alone. Blend's numbers must not move (they are the before/after control), and
// the other two must be produced by the identical code path with nothing
// special-cased for either.
//
// Etherfuse is the one that exercises a scale the other two cannot reach: its
// oracle reports 14 decimals where both others report 7, so every fixed-point
// divide that reads `oracleDecimals` is only genuinely tested here.
//
// EIGHT FIXTURES, THREE ADAPTERS, TWO CATEGORIES. The four Aquarius
// pools are scored under the `dex` rulebook — two factors, not lending's five —
// and they are here for the same reason the lending four are: the synthetic
// suite in `aquarius/score.test.ts` picks convenient issuer flags and identical
// roles, and real pools do not. They also contribute what no lending fixture can:
// a three-token pool, a `concentrated` pool whose `get_reserves` is not the
// tradable balance, and a reserve that is a wasm contract rather than a SAC.
// Their four expected scores are the same four `methodology/dex.md` publishes in
// its worked example, derived there from these same files — so a change here
// that the rulebook does not describe fails in two places.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLEND_ETHERFUSE_V2,
  BLEND_FIXED_V2,
  BLEND_POOLS,
  BLEND_YIELDBLOX_V2,
  BlendAdapter,
} from './blend/index.ts';
import { KineticAdapter } from './kinetic/index.ts';
import { AQUARIUS_POOLS, AQUARIUS_XLM_USDC, AquariusAdapter } from './aquarius/index.ts';
import type { AquariusPool } from './aquarius/index.ts';
import { blendMainnet } from './fixtures/blend-mainnet.ts';
import { etherfuseMainnet } from './fixtures/etherfuse-mainnet.ts';
import { kineticMainnet } from './fixtures/kinetic-mainnet.ts';
import { yieldbloxMainnet } from './fixtures/yieldblox-mainnet.ts';
import { aquariusXlmUsdcMainnet } from './fixtures/aquarius/xlm-usdc-mainnet.ts';
import { aquariusConstantProductMainnet } from './fixtures/aquarius/constant-product-mainnet.ts';
import { aquariusStableMainnet } from './fixtures/aquarius/stable-mainnet.ts';
import { aquariusConcentratedMainnet } from './fixtures/aquarius/concentrated-mainnet.ts';
import { aquariusWasmTokenMainnet } from './fixtures/aquarius/wasm-token-mainnet.ts';
import { DEX_FACTORS } from '@stenion/core';
import type { FactorMap, RiskFactor } from '@stenion/core';

// Takes `FactorMap`, not `RiskFactorMap`: this file reads two categories' maps
// and lending's five-key type cannot describe the dex one.
// `RiskFactorMap` is assignable to it, so every lending call site is unchanged.
const values = (f: FactorMap) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === null ? null : v.value]));

const sub = (f: RiskFactor, id: string) => f.components?.find((c) => c.id === id)?.value;
/** A component's detail string — for the disclosure components, whose `value` is always null. */
const sub2 = (f: RiskFactor, id: string) => f.components?.find((c) => c.id === id)?.detail ?? '';

describe('Blend — frozen mainnet snapshot', () => {
  it('produces exactly the factor map captured with it', async () => {
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.deepEqual(values(factors), {
      collateralSafety: 71,
      oracleSafety: 100,
      adminKeySafety: 40,
      liquiditySafety: 23,
      utilizationSafety: 15,
    });
  });

  it('scores 54 — and that is the weighted mean of those five', async () => {
    // Cross-checked by hand so a failure separates "a factor moved" from "the
    // weighting moved": 71×0.20 + 100×0.25 + 40×0.20 + 23×0.15 + 15×0.20 = 53.65.
    const adapter = new BlendAdapter();
    const factors = await adapter.computeRiskFactors(blendMainnet);
    assert.equal(adapter.score(factors).score, 54);
  });

  it('excludes no reserve as too small — every one clears the $5 min_collateral', async () => {
    // The minimum-size filter (§4/§5) is a genuine no-op on Blend, and this
    // pins that rather than leaving it to be assumed. The pool declares
    // min_collateral = 50000000 at 7 oracle decimals = $5.00, and its smallest
    // reserve holds ~$3.4M, so leg A clears by six orders of magnitude. If a
    // regenerated fixture ever DOES exclude a Blend reserve, that is a real
    // finding about the pool and this test should fail loudly first.
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.equal(blendMainnet.minCollateral, 50_000_000n);
    assert.equal(sub(factors.liquiditySafety!, 'excludedReserves'), undefined);
    assert.equal(sub(factors.utilizationSafety!, 'excludedReserves'), undefined);
  });

  it('reports both oracle sub-signals on real aggregator config', async () => {
    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.equal(sub(factors.oracleSafety!, 'priceFreshness'), 100);
    assert.equal(sub(factors.oracleSafety!, 'deviationBound'), 100);
    // Tightness stays a disclosure on real data too, not just in synthetic cases.
    assert.equal(sub(factors.oracleSafety!, 'deviationTightness'), null);
  });

  it('reports its reserves as the tie they actually are', async () => {
    // All three captured reserves carry the SAME publish timestamp (1787055300)
    // because one aggregator round prices the whole pool. On real data, then,
    // Blend's freshness signal never has a distinguished worst reserve — and the
    // detail must not imply otherwise, as it did for ~1,459 stored runs.
    const stamps = new Set(blendMainnet.reserves.map((r) => r.price?.timestamp));
    assert.equal(stamps.size, 1, 'fixture should capture one shared publish round');

    const factors = await new BlendAdapter().computeRiskFactors(blendMainnet);
    assert.match(factors.oracleSafety!.detail, /all 3 reserves score the same/);
    assert.doesNotMatch(factors.oracleSafety!.detail, /worst reserve/);
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
      liquiditySafety: 44,
      utilizationSafety: 30,
    });
  });

  it('scores 28', async () => {
    // 15×0.20 + 0×0.25 + 60×0.20 + 44×0.15 + 30×0.20 = 27.6.
    const adapter = new KineticAdapter();
    const factors = await adapter.computeRiskFactors(kineticMainnet);
    assert.equal(adapter.score(factors).score, 28);
  });

  it('is the case the minimum-size filter was added for', async () => {
    // THIS FIXTURE IS DELIBERATELY NOT REGENERATED. It is the only captured
    // state where the defect is visible: at capture the PYUSD reserve held
    // $3.00 of a $1,571 pool (0.19%) at 66% utilization, and being the worst
    // reserve it set BOTH factors — liquiditySafety 34 and utilizationSafety 18
    // — off a reserve nobody's capital was meaningfully exposed to. Filtered,
    // the binding reserve becomes SolvBTC at $35.79 (2.28%), which is real:
    // 44 and 30 above.
    //
    // Live K2 has since moved on (PYUSD grew to $4.00 and its utilization fell,
    // so it stopped binding on its own). Recapturing would lose the only
    // regression evidence this change has. Leave it frozen.
    const factors = await new KineticAdapter().computeRiskFactors(kineticMainnet);
    for (const factor of [factors.liquiditySafety!, factors.utilizationSafety!]) {
      const excluded = factor.components?.find((c) => c.id === 'excludedReserves');
      assert.ok(excluded, 'the excluded reserve must be disclosed, not silently dropped');
      assert.equal(excluded.value, null, 'a disclosure is never graded');
      assert.match(excluded.detail, /CCCRWH…/, 'names the excluded reserve');
      assert.match(excluded.detail, /\$3\.00/, 'publishes what it held');
      assert.match(excluded.detail, /0\.19% of pool/, 'publishes its share');
      assert.match(excluded.detail, /would have scored/, 'publishes the suppressed number');
    }
    // The suppressed numbers are exactly the ones this fixture used to publish.
    assert.match(
      factors.liquiditySafety!.components!.find((c) => c.id === 'excludedReserves')!.detail,
      /would have scored 34/,
      'the old liquiditySafety value must still be readable',
    );
    assert.match(
      factors.utilizationSafety!.components!.find((c) => c.id === 'excludedReserves')!.detail,
      /would have scored 18/,
      'the old utilizationSafety value must still be readable',
    );
  });

  it('names the one genuinely worst reserve when there is no tie', async () => {
    // At capture, XLM — 94% of the pool — was the sole reserve at freshness 0,
    // with PYUSD at 31. This is the fixture that disproves the bug report's
    // premise that oracleSafety traced to the dust reserve: the dust reserve was not even the
    // worst one here.
    const factors = await new KineticAdapter().computeRiskFactors(kineticMainnet);
    assert.match(factors.oracleSafety!.detail, /^worst reserve \(CAS3J7…\)/);
    assert.doesNotMatch(factors.oracleSafety!.detail, /CCCRWH/);
  });

  it('scores oracleSafety 0 on a genuinely stale price, with the breaker armed', async () => {
    // This is K2's ordinary state, not an unlucky capture: across the
    // development-era history (since discarded — see METHODOLOGY.md, "Current
    // version") 533 of 588 scored runs carried oracleSafety 0, and the protocol
    // page's Findings section records the same pattern with its own verification
    // steps. The two sub-signals disagreeing is the whole point of the §2
    // composite — the circuit breaker IS armed, and the factor is still 0,
    // because a bounded stale price is untrustworthy.
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

describe('YieldBlox — frozen mainnet snapshot (same adapter, second pool)', () => {
  const adapter = () => new BlendAdapter({ pool: BLEND_YIELDBLOX_V2 });

  it('produces exactly the factor map captured with it', async () => {
    const factors = await adapter().computeRiskFactors(yieldbloxMainnet);
    assert.deepEqual(values(factors), {
      collateralSafety: 52,
      oracleSafety: 0,
      adminKeySafety: 60,
      liquiditySafety: 10,
      utilizationSafety: 0,
    });
  });

  it('scores 24 — the weighted mean of those five', async () => {
    // 52×0.20 + 0×0.25 + 60×0.20 + 10×0.15 + 0×0.20 = 23.9.
    const a = adapter();
    const factors = await a.computeRiskFactors(yieldbloxMainnet);
    assert.equal(a.score(factors).score, 24);
  });

  it('publishes the pool it actually read, not the module default', async () => {
    // THE `adapter: "w"` CLASS OF BUG, in its pool-shaped form. Every number on
    // this entry is derived from CCCCIQSD…, so an explorer link to Blend's
    // CAJJZSGM… would attach a real address to a score computed from a different
    // contract — worse than publishing no link, because it invites a reader to
    // "verify" against state that never fed the number.
    assert.equal(adapter().metadata.contractId, BLEND_YIELDBLOX_V2.poolId);
    assert.equal(adapter().metadata.contractId, yieldbloxMainnet.poolId);
    assert.notEqual(adapter().metadata.contractId, BLEND_FIXED_V2.poolId);
  });

  it("reads its own oracle and its own admin, not Blend's", async () => {
    // The two pools share contract CODE and nothing else. If these ever matched,
    // the fixture would have been captured from the wrong pool — which is the
    // failure mode a shared engine makes easy and a shared assertion catches.
    assert.notEqual(yieldbloxMainnet.oracleId, blendMainnet.oracleId);
    assert.notEqual(yieldbloxMainnet.admin.address, blendMainnet.admin.address);
    assert.equal(yieldbloxMainnet.admin.isContract, true, 'DAO governor, not a keypair');
  });

  it('scores oracleSafety 0 on a disabled deviation bound, with the price fresh', async () => {
    // This is the §2 composite doing the exact job METHODOLOGY.md §2b says it
    // exists for, on the pool the February 2026 incident ran through. An
    // age-only oracle factor would publish 84 here and call it healthy; two of
    // the five graded reserves carry max_dev 0, so the aggregator's deviation
    // check is off for them and a single update can move their price arbitrarily
    // far. METHODOLOGY.md's "what this factor would have said on 2026-02-22"
    // table predicts precisely this pairing — it is now produced by a scored,
    // published entry rather than by a one-off run.
    const factors = await adapter().computeRiskFactors(yieldbloxMainnet);
    assert.ok(sub(factors.oracleSafety!, 'priceFreshness')! > 50, 'the price is fresh');
    assert.equal(sub(factors.oracleSafety!, 'deviationBound'), 0);
    assert.equal(factors.oracleSafety!.value, 0, 'the binding constraint is the missing bound');
    assert.match(factors.oracleSafety!.detail, /deviation check disabled/);
  });

  it('excludes the aggregator base assets from oracleSafety, and says how many', async () => {
    // Blend's Fixed pool has none, so this branch is unexercised by the other
    // fixture. YieldBlox's aggregator declares three assets it prices 1:1 as its
    // unit of account, and `lastprice` short-circuits those without consulting a
    // feed — there is no oracle price to grade, so scoring them 0 for "no
    // deviation bound" would be measuring the absence of a mechanism that does
    // not apply to them.
    assert.equal(yieldbloxMainnet.oracleConfig.baseAssets.length, 3);
    const factors = await adapter().computeRiskFactors(yieldbloxMainnet);
    assert.match(sub2(factors.oracleSafety!, 'deviationTightness'), /3 base asset\(s\) excluded/);
    assert.match(factors.oracleSafety!.detail, /of 5 reserves/, 'grades 5 of the 8 reserves');
  });

  it('reads a live min_collateral of $5.00 from this pool, not from the other one', async () => {
    // The §4/§5 filter's leg A is per-pool: it is read from THIS pool's own
    // PoolConfig instance storage. Both live Blend pools happen to declare the
    // same 50000000 at 7 oracle decimals, and that coincidence is worth pinning
    // — if a future pool declares a different floor, this test is what makes the
    // difference visible instead of assumed.
    assert.equal(yieldbloxMainnet.minCollateral, 50_000_000n);
    assert.equal(yieldbloxMainnet.oracleDecimals, 7);
  });

  it('keeps every reserve — and six of the eight survive on leg A alone', async () => {
    // WORTH READING TWICE, because it is the first pool where the two legs of
    // the minimum-size filter genuinely disagree. The pool holds ~$1.28M, so leg
    // B's 0.5% line sits at ~$6,396 and SIX reserves fall under it ($39 to
    // $4,244). All six are scored anyway, because leg A — Blend's own $5
    // min_collateral — passes for every one of them, and the legs are OR'd.
    //
    // The consequence is visible in the numbers above: liquiditySafety 10 and
    // utilizationSafety 0 are both set by a $1,097 reserve holding 0.086% of the
    // pool. On Blend's Fixed pool leg A is a documented no-op (its smallest
    // reserve is $3.4M); here it is doing all the work, and pulling leg B's
    // guard out from under the factors it was added to protect.
    //
    // This test pins the BEHAVIOUR, not an endorsement of it. Whether a $5 floor
    // is the right leg A for a pool three orders of magnitude smaller than the
    // one it was validated against is a METHODOLOGY.md question, flagged rather
    // than answered here — changing it moves published numbers and is a
    // threshold change under the same review bar as any other.
    const factors = await adapter().computeRiskFactors(yieldbloxMainnet);
    for (const factor of [factors.liquiditySafety!, factors.utilizationSafety!]) {
      assert.equal(
        factor.components?.find((c) => c.id === 'excludedReserves'),
        undefined,
        'leg A rescues every reserve, so nothing is excluded',
      );
    }
    assert.match(factors.liquiditySafety!.detail, /CDTKPW…/);
    assert.match(factors.utilizationSafety!.detail, /CDTKPW…/);
  });

  it('exercises decode paths the Fixed pool cannot reach', async () => {
    // The reason this fixture earns its place next to blend-mainnet rather than
    // duplicating it: eight reserves against three, a reserve at $39 against a
    // floor of $3.4M, cFactor 0 entries (borrow-only, no collateral value), and
    // reserves the aggregator has no entry for at all. A decode or scaling
    // regression that the three tidy Fixed reserves survive has somewhere to
    // show up here.
    assert.equal(yieldbloxMainnet.reserves.length, 8);
    assert.ok(
      yieldbloxMainnet.reserves.some((r) => r.config.cFactor === 0n),
      'expected at least one borrow-only reserve',
    );
    assert.ok(
      yieldbloxMainnet.reserves.some((r) => r.priceConfig === null),
      'expected at least one reserve with no aggregator entry',
    );
  });
});

describe('Etherfuse — frozen mainnet snapshot (same adapter, third pool)', () => {
  const adapter = () => new BlendAdapter({ pool: BLEND_ETHERFUSE_V2 });

  it('produces exactly the factor map captured with it', async () => {
    const factors = await adapter().computeRiskFactors(etherfuseMainnet);
    assert.deepEqual(values(factors), {
      collateralSafety: 94,
      oracleSafety: 100,
      adminKeySafety: 10,
      liquiditySafety: 16,
      utilizationSafety: 11,
    });
  });

  it('scores 50 — the weighted mean of those five', async () => {
    // 94×0.20 + 100×0.25 + 10×0.20 + 16×0.15 + 11×0.20 = 50.4.
    const a = adapter();
    const factors = await a.computeRiskFactors(etherfuseMainnet);
    assert.equal(a.score(factors).score, 50);
  });

  it('publishes the pool it actually read, not the module default', async () => {
    // Same guard as YieldBlox's, and it earns repeating per pool rather than
    // being generalised into a loop: the failure it catches is an entry
    // publishing ONE pool's address beside ANOTHER pool's number, and a loop
    // over the registry cannot tell that from a correct pairing.
    assert.equal(adapter().metadata.contractId, BLEND_ETHERFUSE_V2.poolId);
    assert.equal(adapter().metadata.contractId, etherfuseMainnet.poolId);
    assert.notEqual(adapter().metadata.contractId, BLEND_FIXED_V2.poolId);
    assert.notEqual(adapter().metadata.contractId, BLEND_YIELDBLOX_V2.poolId);
  });

  it('is the deployment that holds the money, not one of the two abandoned ones', async () => {
    // Blend's V2 factory deployed a pool named "Etherfuse" THREE times. The
    // other two — CALRF5I2… and CADR6Q2U… — read exactly 0 supplied and 0
    // borrowed across all five reserves at PoolConfig.status 6 (Setup, never
    // opened) when re-checked on 2026-08-26, while this one was status 1
    // (Active) holding $133,523.47. Pinning the address makes registering the
    // wrong one of three same-named pools a test failure, rather than a
    // published number attached to a dead contract.
    assert.equal(
      BLEND_ETHERFUSE_V2.poolId,
      'CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI',
    );
    assert.equal(etherfuseMainnet.status, 1, 'the live deployment is Active, not Setup');
  });

  it('reads a 14-decimal oracle — the scale neither other fixture reaches', async () => {
    // THE REASON THIS FIXTURE EARNS ITS PLACE beside the other two. Both other
    // Blend pools sit on 7-decimal aggregators, so a divide that hardcoded
    // 10**7 instead of reading `oracleDecimals` would pass every other
    // assertion in this file. Here the same $5.00 min_collateral is
    // 500000000000000 rather than 50000000 — seven orders of magnitude apart —
    // so that bug reports a $50,000,000 floor and excludes the whole pool.
    assert.equal(etherfuseMainnet.oracleDecimals, 14);
    assert.equal(blendMainnet.oracleDecimals, 7);
    assert.equal(yieldbloxMainnet.oracleDecimals, 7);
    assert.equal(etherfuseMainnet.minCollateral, 500_000_000_000_000n);
    assert.equal(Number(etherfuseMainnet.minCollateral) / 10 ** etherfuseMainnet.oracleDecimals, 5);

    // And the filter that floor feeds stays a no-op — only true if the scale
    // was read rather than assumed.
    const factors = await adapter().computeRiskFactors(etherfuseMainnet);
    assert.equal(sub(factors.liquiditySafety!, 'excludedReserves'), undefined);
    assert.equal(sub(factors.utilizationSafety!, 'excludedReserves'), undefined);
  });

  it("reads its own oracle and its own admin, not the other two pools'", async () => {
    // Three pools, three aggregators, three admins. If any of these matched,
    // the fixture was captured from the wrong pool.
    assert.notEqual(etherfuseMainnet.oracleId, blendMainnet.oracleId);
    assert.notEqual(etherfuseMainnet.oracleId, yieldbloxMainnet.oracleId);
    assert.notEqual(etherfuseMainnet.admin.address, blendMainnet.admin.address);
    assert.notEqual(etherfuseMainnet.admin.address, yieldbloxMainnet.admin.address);
  });

  it('scores a single-key admin at the bottom of the range, and says why', async () => {
    // The third distinct admin shape across the fixtures: Blend's multisig,
    // YieldBlox's Governor CONTRACT, and here a plain keypair with one signer.
    // adminKeySafety 10 is the lowest on any scored entry and the factor doing
    // most of the work to hold this market's score down — pinned so a change to
    // the admin rules shows up as a moved number here.
    assert.equal(etherfuseMainnet.admin.isContract, false, 'a keypair, not a governor');
    assert.equal(etherfuseMainnet.admin.account?.signerCount, 1);
    const factors = await adapter().computeRiskFactors(etherfuseMainnet);
    assert.equal(factors.adminKeySafety!.value, 10);
    assert.match(factors.adminKeySafety!.detail, /single-key admin/);
  });

  it('grades every reserve — this aggregator declares no base assets', async () => {
    // YieldBlox's aggregator declares three assets it prices 1:1 and excludes
    // from oracleSafety; this one declares none, so all 5 reserves are graded
    // and that exclusion branch is genuinely absent rather than coincidentally
    // empty.
    assert.deepEqual(etherfuseMainnet.oracleConfig.baseAssets, []);
    const factors = await adapter().computeRiskFactors(etherfuseMainnet);
    assert.doesNotMatch(
      sub2(factors.oracleSafety!, 'deviationTightness'),
      /base asset\(s\) excluded/,
    );
    assert.match(factors.oracleSafety!.detail, /all 5 reserves score the same/);
  });

  it('publishes operationalState active without touching the factor map', async () => {
    // The published-never-scored rule checked on the newest entry. Both adapter
    // suites already assert the byte-identical-factor-map half; what this pins is
    // that a market registered after `operationalState` shipped actually
    // populates the field from its own PoolConfig.status rather than falling
    // back to a default.
    const state = adapter().operationalState(etherfuseMainnet);
    assert.equal(state.level, 'active');
    assert.equal(state.source, 'PoolConfig.status = 1');
    assert.deepEqual(state.blocked, []);
  });
});

describe('all three Blend pools — one engine, three markets', () => {
  it('produce different scores from identical code', async () => {
    // The whole argument for multi-pool targeting rather than aggregation. Same
    // class, same rulebook, same contract wasm on chain — and 30 points apart,
    // because the reserves, the oracle configuration and the admin differ. A
    // single summed "Blend" number would hide exactly this.
    const fixed = new BlendAdapter({ pool: BLEND_FIXED_V2 });
    const ybx = new BlendAdapter({ pool: BLEND_YIELDBLOX_V2 });
    const eth = new BlendAdapter({ pool: BLEND_ETHERFUSE_V2 });
    const fixedScore = fixed.score(await fixed.computeRiskFactors(blendMainnet)).score;
    const ybxScore = ybx.score(await ybx.computeRiskFactors(yieldbloxMainnet)).score;
    const ethScore = eth.score(await eth.computeRiskFactors(etherfuseMainnet)).score;
    assert.equal(fixedScore, 54);
    assert.equal(ybxScore, 24);
    assert.equal(ethScore, 50);
    assert.equal(new Set([fixedScore, ybxScore, ethScore]).size, 3, 'three markets, three numbers');
  });

  it('declare the lending category, on every pool', async () => {
    // Required as of ADAPTER_INTERFACE_VERSION 3. Asserted per pool rather
    // than once on the class, for the same reason `contractId` is: metadata is
    // built per instance from the pool it was handed, so "the class sets it" and
    // "every instance has it" are different claims.
    for (const pool of BLEND_POOLS) {
      assert.equal(new BlendAdapter({ pool }).metadata.category, 'lending');
    }
    assert.equal(new KineticAdapter().metadata.category, 'lending');
  });

  it('are scored by the same adapter, and say so', async () => {
    // `adapterRef` is deliberately shared: both rows genuinely come from
    // BlendAdapter, and a reader following the provenance label lands in the
    // right file. It is the one identity field that does NOT vary per pool, and
    // it must stay a literal — see ProtocolMetadata.adapterRef.
    for (const pool of BLEND_POOLS) {
      assert.equal(new BlendAdapter({ pool }).metadata.adapterRef, 'BlendAdapter');
    }
  });

  it('label the non-flagship pool as a deployment and leave the flagship unlabelled', async () => {
    // The condition on which the second entry is allowed to exist at all. If
    // this ever inverted or went missing, the registry would present a Blend
    // market as an independent protocol — the exact misrepresentation Stenion
    // refused when it declined to build a standalone YieldBlox adapter.
    assert.equal(new BlendAdapter({ pool: BLEND_FIXED_V2 }).metadata.deployedOn, undefined);
    for (const pool of [BLEND_YIELDBLOX_V2, BLEND_ETHERFUSE_V2]) {
      assert.deepEqual(new BlendAdapter({ pool }).metadata.deployedOn, {
        host: 'Blend',
        label: 'Blend V2 pool',
      });
    }
    // Stated as a rule over the whole registry as well as a list, so a pool
    // added later without the label fails here instead of quietly presenting
    // itself as an independent protocol.
    for (const pool of BLEND_POOLS) {
      if (pool.id === 'blend') continue;
      assert.ok(pool.deployedOn, `${pool.id} must carry deployedOn`);
    }
  });

  it('never share a slug or a contract', async () => {
    // `id` is a primary key and a public URL; two pools colliding on it would
    // make one silently overwrite the other's row on every indexer cycle.
    const ids = BLEND_POOLS.map((p) => p.id);
    const contracts = BLEND_POOLS.map((p) => p.poolId);
    assert.equal(new Set(ids).size, ids.length, 'pool slugs must be unique');
    assert.equal(new Set(contracts).size, contracts.length, 'pool contracts must be unique');
  });
});

// ---------------------------------------------------------------------------
// Aquarius — the dex category
// ---------------------------------------------------------------------------

/**
 * The five captured pools, each paired with the identity an adapter instance
 * would be handed.
 *
 * THE FIRST ENTRY IS THE REGISTERED MARKET and its identity is IMPORTED from
 * `AQUARIUS_POOLS`, not written out here — a snapshot that pinned a
 * hand-typed pool would keep passing after the registry moved to a different
 * one, which is the failure this file exists to catch. The other four are branch
 * fixtures for markets nothing publishes a number about, so they declare the
 * identity an adapter instance would be handed; each `poolId` is read off the
 * fixture itself, so an adapter here can never be pointed at a pool the numbers
 * did not come from.
 *
 * The expected values are re-derived by hand, never copied from the capture
 * run — see the arithmetic beside each assertion below.
 */
const AQUARIUS_SNAPSHOTS = [
  {
    label: 'REGISTERED — constant_product XLM/USDC',
    pool: AQUARIUS_XLM_USDC,
    raw: aquariusXlmUsdcMainnet,
    adminKeySafety: 10,
    assetControlSafety: 40,
    score: 24,
  },
  {
    label: 'constant_product XLM/AQUA',
    pool: {
      id: 'aquarius-xlm-aqua',
      name: 'Aquarius XLM/AQUA',
      poolId: aquariusConstantProductMainnet.poolId,
    } satisfies AquariusPool,
    raw: aquariusConstantProductMainnet,
    adminKeySafety: 10,
    assetControlSafety: 70,
    score: 37,
  },
  {
    label: 'stable USDC/USDx/yUSDC (three tokens)',
    pool: {
      id: 'aquarius-usdc-usdx-yusdc',
      name: 'Aquarius USDC/USDx/yUSDC',
      poolId: aquariusStableMainnet.poolId,
    } satisfies AquariusPool,
    raw: aquariusStableMainnet,
    adminKeySafety: 10,
    assetControlSafety: 40,
    score: 24,
  },
  {
    label: 'concentrated XLM/AQUA',
    pool: {
      id: 'aquarius-xlm-aqua-concentrated',
      name: 'Aquarius XLM/AQUA (concentrated)',
      poolId: aquariusConcentratedMainnet.poolId,
    } satisfies AquariusPool,
    raw: aquariusConcentratedMainnet,
    adminKeySafety: 10,
    assetControlSafety: 70,
    score: 37,
  },
  {
    label: 'stable USDC(SAC)/USDC(wasm)',
    pool: {
      id: 'aquarius-usdc-usdc-wasm',
      name: 'Aquarius USDC/USDC.w',
      poolId: aquariusWasmTokenMainnet.poolId,
    } satisfies AquariusPool,
    raw: aquariusWasmTokenMainnet,
    adminKeySafety: 10,
    assetControlSafety: 40,
    score: 24,
  },
] as const;

/**
 * One snapshot by label.
 *
 * BY LABEL, NOT BY INDEX. The assertions below each need a SPECIFIC pool — the
 * three-token stable one, the one holding a wasm token — and reading them out of
 * the array positionally meant that inserting the registered market at the front
 * silently repointed four tests at different pools, three of which then
 * failed and one of which would have kept passing while covering nothing. A name
 * cannot be shifted by an insertion.
 */
const snapshot = (label: (typeof AQUARIUS_SNAPSHOTS)[number]['label']) => {
  const found = AQUARIUS_SNAPSHOTS.find((s) => s.label === label);
  assert.ok(found, `no Aquarius snapshot labelled ${label}`);
  return found;
};

describe('Aquarius — frozen mainnet snapshots, every captured pool', () => {
  it('captures the market the indexer actually scores, not one beside it', () => {
    // The registry is the source of truth for what is published, so the snapshot
    // that pins published numbers has to be pinned to it. If AQUARIUS_POOLS gains,
    // loses or repoints an entry, this fails rather than going quietly stale.
    assert.deepEqual(
      AQUARIUS_POOLS.map((p) => p.id),
      ['aquarius-xlm-usdc'],
      'one Aquarius market is registered — the cycle budget allows a fifth target and no sixth',
    );
    assert.equal(
      aquariusXlmUsdcMainnet.poolId,
      AQUARIUS_XLM_USDC.poolId,
      'the fixture was captured from the pool contract the registry names',
    );
    // Chain-attested identity, frozen with the reading: the running wasm is the
    // hash the router declares for constant_product, and the reserve tokens are
    // Circle's USDC (not the look-alike GCBYVQH3… also coded USDC) and native XLM.
    assert.equal(aquariusXlmUsdcMainnet.poolType, 'constant_product');
    assert.equal(
      aquariusXlmUsdcMainnet.upgrade.runningWasm,
      'ae0da5a84b15805c5c7931ac567a8d1b34be3f26b483993d9ff80cb2c3de9852',
    );
    const issuer = aquariusXlmUsdcMainnet.reserveTokens[1]?.issuer;
    assert.equal(issuer?.status, 'read');
    assert.equal(
      issuer?.status === 'read' ? issuer.issuer : null,
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    );
  });

  for (const snap of AQUARIUS_SNAPSHOTS) {
    it(`produces exactly the factor map captured with it — ${snap.label}`, async () => {
      const factors = await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw);
      assert.deepEqual(values(factors), {
        adminKeySafety: snap.adminKeySafety,
        assetControlSafety: snap.assetControlSafety,
      });
    });

    it(`scores ${snap.score} — the weighted mean of those two — ${snap.label}`, async () => {
      // Cross-checked by hand against methodology/dex.md's worked example, so a
      // failure separates "a factor moved" from "the weighting moved":
      //   10x0.55 + 70x0.45 = 37.0 -> 37
      //   10x0.55 + 40x0.45 = 23.5 -> 24
      //
      // The registered XLM/USDC pool's two factors, re-derived rather than read
      // off the capture log. adminKeySafety is the worst of seven roles across
      // the pool and the router: Admin is 3 signers at high-threshold 2, so
      // multisig, base 90, less min(30, 96x3) = 30 -> 60; the five single-key
      // roles are base 40, of which RewardsAdmin and SystemFeeAdmin took 200 ops
      // in 30d -> 40 - 30 = 10. Worst = 10, and no upgrade is pending so the
      // reaction-window ceiling does not bind. assetControlSafety is the worst of
      // two gradable reserves: native XLM has no issuer account -> 100, and
      // Circle's USDC issuer has auth_revocable set -> 40. Worst = 40.
      const adapter = new AquariusAdapter({ pool: snap.pool });
      assert.equal(adapter.score(await adapter.computeRiskFactors(snap.raw)).score, snap.score);
    });
  }

  it('reads the same admin posture on all four — the factor that does not discriminate', async () => {
    // The 2026-08-27 census found one role structure across the router and all
    // 340 pools, and the 2026-08-29 capture still shows it: a 2-of-3 owner key
    // with 96 ops (60) and six lone keys, two of them at 200 ops (10). The
    // minimum is 10 on every pool.
    //
    // Pinned rather than left implicit because it is the reason
    // `assetControlSafety` carries the whole spread today — and because the
    // weights must NOT be re-tuned to widen that spread, which would be
    // calibrating a category rulebook against one protocol's current data.
    for (const snap of AQUARIUS_SNAPSHOTS) {
      const f = await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw);
      assert.equal(f.adminKeySafety!.value, 10, snap.label);
      assert.equal(sub(f.adminKeySafety!, 'rolePosture'), 10);
      assert.equal(sub(f.adminKeySafety!, 'upgradeWindow'), 100);
      assert.match(sub2(f.adminKeySafety!, 'upgradeWindow'), /UpgradeDeadline = 0/);
    }
  });

  it('publishes the two route-(a) disclosures on every pool, ungraded', async () => {
    for (const snap of AQUARIUS_SNAPSHOTS) {
      const f = await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw);
      assert.equal(sub(f.adminKeySafety!, 'timelockDuration'), null);
      assert.equal(sub(f.adminKeySafety!, 'emergencyBypass'), null);
    }
  });

  it('grades native XLM as a SAC with no issuer, not as an unreadable one', async () => {
    // The counter-example the METADATA read exists for: XLM's `name` is the bare
    // string `native` rather than `CODE:ISSUER`, so a SAC detected by the shape
    // of its name would misclassify the most common token in the registry. Here
    // it scores 100 — "nobody can seize this" — which is the opposite of what a
    // failed read scores.
    const snap = snapshot('constant_product XLM/AQUA');
    const f = await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw);
    const xlm = f.assetControlSafety!.components!.find((c) => c.label === 'XLM')!;
    assert.equal(xlm.value, 100);
    assert.match(xlm.detail, /no issuer account to act from/);
  });

  it('binds on Circle USDC being auth_revocable in the three-token stable pool', async () => {
    // Three reserves, scores 40 / 70 / 70, and the minimum is what publishes.
    // Circle's USDC really does carry `auth_revocable` — read from Horizon at
    // capture time, not asserted from documentation.
    const snap = snapshot('stable USDC/USDx/yUSDC (three tokens)');
    const f = await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw);
    assert.equal(snap.raw.reserveTokens.length, 3);
    assert.deepEqual(
      f.assetControlSafety!.components!.map((c) => c.value),
      [40, 70, 70],
    );
    assert.match(f.assetControlSafety!.detail, /worst of 3 gradable reserve/);
  });

  it('excludes the wasm reserve as a disclosure — not as a zero and not as a pass', async () => {
    // The distinction methodology/dex.md calls the most dangerous confusion
    // available in this factor. The pool scores exactly what its one gradable
    // reserve scores; the wasm token is named with a null value.
    const snap = snapshot('stable USDC(SAC)/USDC(wasm)');
    const f = await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw);
    assert.equal(snap.raw.reserveTokens[1]!.isStellarAsset, false);
    assert.deepEqual(
      f.assetControlSafety!.components!.map((c) => c.value),
      [40, null],
    );
    assert.equal(f.assetControlSafety!.value, 40);
    assert.match(f.assetControlSafety!.detail, /1 of 2 excluded as non-SAC/);
  });

  it('scores a concentrated pool through the identical path, reading none of its reserves', async () => {
    // A `concentrated` pool's `get_reserves` is the total across all tick ranges
    // and NOT the tradable balance. Neither dex factor reads reserves at all, so
    // the two XLM/AQUA pools — one constant-product, one concentrated — produce
    // the same numbers from the same code, and that quantity is never misread as
    // something it is not.
    const cp = snapshot('constant_product XLM/AQUA');
    const conc = snapshot('concentrated XLM/AQUA');
    assert.equal(conc.raw.poolType, 'concentrated');
    assert.notDeepEqual(conc.raw.reserves, cp.raw.reserves);
    assert.deepEqual(
      values(await new AquariusAdapter({ pool: conc.pool }).computeRiskFactors(conc.raw)),
      values(await new AquariusAdapter({ pool: cp.pool }).computeRiskFactors(cp.raw)),
    );
  });

  it('publishes operationalState active on every one without touching the factor map', async () => {
    // The published-never-scored rule on the newest category. None of the
    // captured pools has a
    // kill switch set, so `active` here is a reading rather than a default; the
    // synthetic suite is what walks all 32 states.
    for (const snap of AQUARIUS_SNAPSHOTS) {
      const state = new AquariusAdapter({ pool: snap.pool }).operationalState(snap.raw);
      assert.equal(state.level, 'active');
      assert.deepEqual(state.blocked, []);
      assert.equal(state.source, 'router.get_emergency_mode() = false');
    }
  });

  it('declares the dex category and names the pool it actually read', async () => {
    for (const snap of AQUARIUS_SNAPSHOTS) {
      const metadata = new AquariusAdapter({ pool: snap.pool }).metadata;
      assert.equal(metadata.category, 'dex');
      assert.equal(metadata.adapterRef, 'AquariusAdapter');
      assert.equal(metadata.contractId, snap.raw.poolId);
    }
    const ids = AQUARIUS_SNAPSHOTS.map((s) => s.pool.id);
    assert.equal(new Set(ids).size, ids.length, 'pool slugs must be unique');
  });

  it('takes both weights from DEX_FACTORS rather than a literal', async () => {
    const snap = AQUARIUS_SNAPSHOTS[0];
    const f = await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw);
    assert.equal(f.adminKeySafety!.weight, DEX_FACTORS.adminKeySafety.weight);
    assert.equal(f.assetControlSafety!.weight, DEX_FACTORS.assetControlSafety.weight);
  });
});

describe('every snapshot', () => {
  it('populates every factor its category declares, with real detail strings', async () => {
    // Both categories, one loop — the check is category-agnostic: whichever
    // factors a rulebook declares must all be present, all whole numbers in
    // range, and all carry a real explanation. Lending contributes five keys per
    // fixture and dex contributes two; nothing here asserts a count, because the
    // count is `CATEGORY_FACTORS`' business and not this test's.
    const maps: FactorMap[] = [
      await new BlendAdapter().computeRiskFactors(blendMainnet),
      await new KineticAdapter().computeRiskFactors(kineticMainnet),
      await new BlendAdapter({ pool: BLEND_YIELDBLOX_V2 }).computeRiskFactors(yieldbloxMainnet),
      await new BlendAdapter({ pool: BLEND_ETHERFUSE_V2 }).computeRiskFactors(etherfuseMainnet),
    ];
    for (const snap of AQUARIUS_SNAPSHOTS) {
      maps.push(await new AquariusAdapter({ pool: snap.pool }).computeRiskFactors(snap.raw));
    }

    for (const factors of maps) {
      for (const [key, factor] of Object.entries(factors)) {
        assert.ok(factor, `${key} should be populated on live data`);
        assert.ok(factor.detail.length > 10, `${key} needs a real detail string`);
        assert.ok(Number.isInteger(factor.value), `${key} should be a whole number`);
        assert.ok(factor.value >= 0 && factor.value <= 100, `${key} out of range`);
      }
    }
  });
});
