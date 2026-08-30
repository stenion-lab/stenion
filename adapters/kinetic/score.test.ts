// Fixture tests for the five factors and `operationalState` — everything in
// ./score.ts.
//
// WHY THESE EXIST: K2's half of `oracleSafety` (METHODOLOGY.md §2) turns on a rule Blend has no
// equivalent of — its circuit breaker fails *open*. `validate_price_change`
// returns Ok when there is no stored baseline, so a configured
// `max_price_change_bps` with no `get_last_price` is inert: configured, but not
// armed. That is exactly the newly-listed-thin-asset case the YieldBlox
// incident ran through, and no live K2 reserve is in that state today, so only
// a fixture can prove we score it as unbounded.
//
// The bitmap decoders these raw values are read out WITH are tested in
// ./fetch.test.ts; the captured-mainnet snapshots are ../snapshot.test.ts.
//
// Reached through `KineticAdapter` rather than through ./score.ts's exports
// directly, which is how these assertions were written and what they have always
// covered: the class's `computeRiskFactors` / `operationalState` are pure
// delegators, and going through them keeps the delegation itself under test.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KineticAdapter } from './index.ts';
import type { KineticRawData, KineticReserveFlags, KineticReserveRaw } from './index.ts';
import { LENDING_FACTORS, OperationalLevel } from '@stenion/core';
import type { RiskFactor } from '@stenion/core';

// ---------------------------------------------------------------------------
// Synthetic raw-state builders
// ---------------------------------------------------------------------------

const FETCHED_AT = 1_760_000_000;
const PRICE_DECIMALS = 14;

interface ReserveOpts {
  asset?: string;
  decimals?: number;
  supplied?: number;
  borrowed?: number;
  price?: number | null;
  ageSeconds?: number;
  /** per-asset max acceptable price age; null means the oracle has none set */
  maxAge?: number | null;
  /** the circuit breaker's stored baseline; null/0n means it has none — the inert case */
  breakerBaseline?: bigint | null;
  /** null = the asset isn't whitelisted on the oracle at all */
  whitelisted?: boolean;
  manualOverrideActive?: boolean;
  /**
   * Per-reserve gating flags. Defaults to fully open, so every existing case
   * keeps meaning exactly what it meant — a reserve is unrestricted unless a
   * test says otherwise, which is also true of the live protocol.
   */
  flags?: Partial<KineticReserveFlags>;
}

function reserve(o: ReserveOpts = {}): KineticReserveRaw {
  const {
    asset = 'CRESERVEK2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    decimals = 7,
    supplied = 1_000,
    borrowed = 400,
    price = 1,
    ageSeconds = 0,
    maxAge = null,
    breakerBaseline = 1_000_000n,
    whitelisted = true,
    manualOverrideActive = false,
    flags = {},
  } = o;

  const unit = BigInt(10) ** BigInt(decimals);
  return {
    asset,
    decimals,
    flags: { active: true, frozen: false, borrowingEnabled: true, paused: false, ...flags },
    suppliedRaw: BigInt(Math.round(supplied)) * unit,
    borrowedRaw: BigInt(Math.round(borrowed)) * unit,
    price:
      price === null
        ? null
        : {
            value: BigInt(Math.round(price * 10 ** PRICE_DECIMALS)),
            timestamp: FETCHED_AT - ageSeconds,
          },
    priceConfig: whitelisted
      ? {
          enabled: true,
          maxAge,
          source: 'reflector',
          feedId: 'TEST',
          manualOverrideActive,
          breakerBaseline,
        }
      : null,
  };
}

interface RawOpts {
  reserves?: KineticReserveRaw[];
  /** the oracle's global circuit-breaker bound, in basis points; 0 disables it */
  maxPriceChangeBps?: number;
  /** the oracle's global max price age */
  priceStalenessThreshold?: number;
  /** how long the oracle reuses a cached price — K2's stand-in for a publish interval */
  priceCacheTtl?: number;
  admin?: KineticRawData['admin'];
  paused?: boolean;
}

function makeRaw(o: RawOpts = {}): KineticRawData {
  const {
    reserves = [reserve()],
    maxPriceChangeBps = 2_000,
    priceStalenessThreshold = 3_600,
    priceCacheTtl = 30,
    admin = { address: 'CADMIN…', isContract: true, account: null },
    paused = false,
  } = o;

  return {
    routerId: 'CROUTER…',
    oracleId: 'CORACLE…',
    oraclePriceDecimals: PRICE_DECIMALS,
    paused,
    admin,
    oracleConfig: { maxPriceChangeBps, priceStalenessThreshold, priceCacheTtl, paused: false },
    reserves,
    fetchedAt: FETCHED_AT,
  } satisfies KineticRawData;
}

const adapter = new KineticAdapter();
const factors = (raw: KineticRawData) => adapter.computeRiskFactors(raw);
const sub = (f: RiskFactor, id: string): number | null | undefined =>
  f.components?.find((c) => c.id === id)?.value;

describe('oracleSafety — the breaker must be armed, not merely configured (§2b)', () => {
  it('scores 100 when a bound is set and a baseline exists', async () => {
    const f = await factors(makeRaw());
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 100);
  });

  it('scores 0 when the breaker is disabled outright', async () => {
    const f = await factors(makeRaw({ maxPriceChangeBps: 0 }));
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
    assert.match(f.oracleSafety!.detail, /circuit breaker disabled/);
  });

  it('scores 0 when a bound is configured but no baseline is stored — inert', async () => {
    // THE K2-SPECIFIC RULE. Blend's aggregator fails closed here (no prior
    // record → the reserve simply cannot be priced); K2's fails open (no
    // baseline → validate_price_change returns Ok and lets any price through).
    // A configured bound with nothing to compare against is not protection.
    const f = await factors(makeRaw({ reserves: [reserve({ breakerBaseline: null })] }));
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
    assert.match(f.oracleSafety!.detail, /no circuit-breaker baseline/);
  });

  it('treats a zero baseline as no baseline', async () => {
    // A stored zero can't bound a percentage move either — |new−0|/0 is not a
    // constraint. It must not read as "a baseline exists".
    const f = await factors(makeRaw({ reserves: [reserve({ breakerBaseline: 0n })] }));
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
  });

  it('scores 0 for an asset that is not whitelisted on the oracle', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ whitelisted: false })] }));
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
    assert.match(f.oracleSafety!.detail, /not whitelisted/);
  });

  it('takes the worst reserve — one inert breaker sinks the pool', async () => {
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CARMED…' }),
          reserve({ asset: 'CINERT…', breakerBaseline: null }),
        ],
      }),
    );
    assert.equal(sub(f.oracleSafety!, 'deviationBound'), 0);
  });
});

describe("oracleSafety — freshness anchored to K2's own parameters (§2a)", () => {
  it('treats a price inside the cache TTL as fully fresh', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 30 })] }));
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 100);
  });

  it('grades between the cache TTL and the global staleness threshold', async () => {
    // fresh = 30 (PriceCacheTtl), dead = 3600 (price_staleness_threshold).
    for (const [age, expected] of [
      [30, 100],
      [1_815, 50],
      [3_600, 0],
      [7_200, 0],
    ]) {
      const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: age })] }));
      assert.equal(sub(f.oracleSafety!, 'priceFreshness'), expected, `age ${age}s`);
    }
  });

  it('takes the tighter of the per-asset max_age and the global threshold', async () => {
    // Both numbers are K2's own; the binding one is the one that governs. With a
    // 600s per-asset limit, a 315s-old price is mid-scale — against the 3600s
    // global alone the same price would score 92.
    const tight = await factors(makeRaw({ reserves: [reserve({ maxAge: 600, ageSeconds: 315 })] }));
    assert.equal(sub(tight.oracleSafety!, 'priceFreshness'), 50);

    const global = await factors(
      makeRaw({ reserves: [reserve({ maxAge: null, ageSeconds: 315 })] }),
    );
    assert.equal(sub(global.oracleSafety!, 'priceFreshness'), 92);
  });

  it('never lets a loose per-asset max_age beat the global threshold', async () => {
    // K2's per-asset max_age is 43200s (12h) in production. It must not widen
    // the window past the global 3600s — "tighter of the two", not "whichever
    // is more generous".
    const f = await factors(
      makeRaw({ reserves: [reserve({ maxAge: 43_200, ageSeconds: 1_815 })] }),
    );
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 50);
  });

  it('scores a reserve with no usable price 0', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ price: null })] }));
    assert.equal(sub(f.oracleSafety!, 'priceFreshness'), 0);
  });
});

describe('oracleSafety — composite and disclosures', () => {
  it('takes the binding constraint of freshness and bound', async () => {
    const freshUnarmed = await factors(
      makeRaw({ reserves: [reserve({ ageSeconds: 0, breakerBaseline: null })] }),
    );
    assert.equal(freshUnarmed.oracleSafety!.value, 0, 'an inert breaker must bind');

    const staleArmed = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 7_200 })] }));
    assert.equal(staleArmed.oracleSafety!.value, 0, 'a dead price must bind');

    const both = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 30 })] }));
    assert.equal(both.oracleSafety!.value, 100);
  });

  it('discloses the bound without grading it, and says why it is incomparable', async () => {
    const f = await factors(makeRaw({ maxPriceChangeBps: 2_000 }));
    const tightness = f.oracleSafety!.components!.find((c) => c.id === 'deviationTightness');
    assert.ok(tightness);
    assert.equal(tightness.value, null, 'tightness is disclosed, never scored (§2d)');
    assert.match(tightness.detail, /2000 \(20%\)/);
    assert.match(tightness.detail, /not comparable|not graded/);
  });

  it('surfaces an active admin price override prominently', async () => {
    // An admin-set price in force is exactly the kind of thing a reader must
    // see, even though it isn't graded.
    const f = await factors(
      makeRaw({ reserves: [reserve({ asset: 'COVERRIDE…', manualOverrideActive: true })] }),
    );
    const tightness = f.oracleSafety!.components!.find((c) => c.id === 'deviationTightness');
    assert.match(tightness!.detail, /ADMIN PRICE OVERRIDE ACTIVE/);
  });
});

describe("utilizationSafety — anchored to K2's 80% kink (§5)", () => {
  it('grades headroom below the optimal-utilization rate', async () => {
    // headroom = (0.8 − util) / 0.8. util 0.4 → 50; util 0.8 → 0; util 0 → 100.
    for (const [supplied, borrowed, expected] of [
      [1_000, 0, 100],
      [1_000, 400, 50],
      [1_000, 800, 0],
      [1_000, 900, 0],
    ]) {
      const f = await factors(makeRaw({ reserves: [reserve({ supplied, borrowed })] }));
      assert.equal(f.utilizationSafety!.value, expected, `${borrowed}/${supplied} borrowed`);
    }
  });

  it('takes the worst reserve, not the average', async () => {
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CIDLE…', supplied: 1_000, borrowed: 0 }),
          reserve({ asset: 'CSTRESSED…', supplied: 1_000, borrowed: 700 }),
        ],
      }),
    );
    // Worst is 700/1000 = 0.7 util → (0.8−0.7)/0.8 = 12.5 → 13.
    assert.equal(f.utilizationSafety!.value, 13);
  });
});

describe('documented gaps — pinned so a change to them is deliberate', () => {
  it('does not currently feed the router pause flag into any factor', async () => {
    // `paused` is captured in the raw shape but deliberately not scored — the
    // pause/frozen-state question is an open taxonomy item in ROADMAP.md, not an
    // oversight. This test exists so that wiring it in trips a visible failure
    // and gets the METHODOLOGY.md change it requires, rather than silently
    // moving every K2 score.
    const running = await factors(makeRaw({ paused: false }));
    const halted = await factors(makeRaw({ paused: true }));
    assert.deepEqual(
      Object.values(halted).map((f) => f?.value),
      Object.values(running).map((f) => f?.value),
      'pause state is not scored yet — see ROADMAP.md',
    );
  });
});

describe('the factor map itself', () => {
  // THE MIRROR OF blend.test.ts'S BLOCK OF THE SAME NAME, and it is here because
  // it was not. Blend's weights had been pinned against the rulebook since the
  // adapter was written; Kinetic's had never been pinned against anything, so a
  // typo in one of its five weight literals would have gone out as a published
  // score with no test between it and production. Both adapters implement one
  // shared rulebook (METHODOLOGY.md ground rule 1), so both are held to it here,
  // to the same standard and against the same source.

  it('populates all five factors, each with a real detail string', async () => {
    const f = await factors(makeRaw());
    for (const [key, value] of Object.entries(f)) {
      assert.ok(value !== undefined, `${key} must be present`);
      assert.ok(value !== null, `${key} should be populated for a normal K2 market`);
      assert.ok(value.detail.length > 0, `${key} needs a human-readable detail`);
      assert.ok(value.value >= 0 && value.value <= 100, `${key} out of the 0-100 range`);
    }
  });

  it('carries the weights the shared lending rulebook declares', async () => {
    // Reads `LENDING_FACTORS` rather than spelling the five numbers out, so this
    // is not a second hand-written copy of the weight table — it is the same
    // declaration blend.test.ts checks against, and core/src/scoring.test.ts
    // pins that declaration to METHODOLOGY.md's published table. No number in
    // this file.
    const f = await factors(makeRaw());

    assert.deepEqual(
      Object.keys(f).sort(),
      Object.keys(LENDING_FACTORS).sort(),
      'the adapter populates a different factor set than lending declares',
    );

    for (const [key, decl] of Object.entries(LENDING_FACTORS)) {
      assert.equal(
        f[key as keyof typeof f]!.weight,
        decl.weight,
        `${key} is weighted ${f[key as keyof typeof f]!.weight} here but ` +
          `${decl.weight} in CATEGORY_FACTORS.lending`,
      );
    }
  });

  it('weights the same factors Blend does — one rulebook, two adapters', async () => {
    // The point of a shared declaration, stated as a property rather than left
    // implicit: if these two ever disagree, one of them has stopped reading the
    // rulebook. Compared against the declaration rather than against Blend's
    // adapter so this suite stays runnable on its own.
    const f = await factors(makeRaw());
    const total = Object.values(f).reduce((a, v) => a + (v ? v.weight : 0), 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `the populated weights sum to ${total}, not 1.00`);
  });
});

// ---------------------------------------------------------------------------
// "Nothing to measure" scores 0, never 100 — see the longer note in
// blend.test.ts. Both adapters had the same defect, not because one was copied
// from the other but because both were written to the same rulebook and both
// read it the same wrong way, which is why the correction had to land in both
// at once and why it is pinned in both suites.
// ---------------------------------------------------------------------------

describe('collateralSafety — the original "nothing to measure" case (§1)', () => {
  // This factor already scored 0 for an unassessable pool before the correction
  // above; it is what the other two were made consistent with. It had no Kinetic
  // test at all, which meant the shared convention was only guarded on one
  // adapter and on two of the three factors that now follow it.
  it('scores 0 when no reserve can be priced', async () => {
    const f = await factors(
      makeRaw({
        reserves: [reserve({ asset: 'CA…', price: null }), reserve({ asset: 'CB…', price: null })],
      }),
    );
    assert.equal(f.collateralSafety!.value, 0);
    assert.match(f.collateralSafety!.detail, /no priced supplied value/);
  });

  it('scores 0 for a pool with no reserves at all', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.equal(f.collateralSafety!.value, 0);
  });

  it('scores a single priced reserve 0 — concentrated by definition', async () => {
    const f = await factors(makeRaw({ reserves: [reserve()] }));
    assert.equal(f.collateralSafety!.value, 0);
    assert.match(f.collateralSafety!.detail, /single priced reserve/);
  });

  it('scores an even split as fully diversified', async () => {
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CA…', supplied: 500 }),
          reserve({ asset: 'CB…', supplied: 500 }),
        ],
      }),
    );
    assert.equal(f.collateralSafety!.value, 100);
  });
});

describe('all three "cannot assess" factors agree on the convention', () => {
  it('collateral, liquidity and utilization all report 0 for an empty pool', async () => {
    // The convention is the point: three factors, one answer for "no data".
    // A future factor that returns its accumulator seed instead should look
    // obviously wrong next to this.
    const f = await factors(makeRaw({ reserves: [] }));
    assert.deepEqual(
      {
        collateral: f.collateralSafety!.value,
        liquidity: f.liquiditySafety!.value,
        utilization: f.utilizationSafety!.value,
      },
      { collateral: 0, liquidity: 0, utilization: 0 },
    );
  });
});

describe('no measurable reserves — cannot assess, so 0 not 100', () => {
  it('liquiditySafety: a pool with no reserves cannot be assessed', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.equal(f.liquiditySafety!.value, 0);
  });

  it('liquiditySafety: every reserve empty is equally unassessable', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ supplied: 0, borrowed: 0 })] }));
    assert.equal(f.liquiditySafety!.value, 0);
  });

  it('utilizationSafety: a pool with no reserves cannot be assessed', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.equal(f.utilizationSafety!.value, 0);
  });

  it('utilizationSafety: every reserve empty is equally unassessable', async () => {
    const f = await factors(makeRaw({ reserves: [reserve({ supplied: 0, borrowed: 0 })] }));
    assert.equal(f.utilizationSafety!.value, 0);
  });

  it('neither factor describes a reserve that does not exist', async () => {
    const f = await factors(makeRaw({ reserves: [] }));
    assert.doesNotMatch(f.liquiditySafety!.detail, /worst reserve/);
    assert.doesNotMatch(f.utilizationSafety!.detail, /worst reserve/);
  });
});

// ---------------------------------------------------------------------------
// The minimum-size filter (METHODOLOGY.md §4/§5).
//
// Same shared rule as Blend, but K2 declares no minimum-exposure parameter
// anywhere on chain, so leg A is unavailable and the 0.5% relative floor is the
// only test a K2 reserve faces. These pin that difference as a property of K2's
// DATA rather than of K2's rules — the formula is identical, and if K2 ever
// ships an equivalent of Blend's min_collateral, leg A turns on here too.
// ---------------------------------------------------------------------------

describe('minimum-size filter — K2 has only the relative leg (§4/§5)', () => {
  /** The live shape the filter was added for: one dominant reserve, one dust one. */
  const withDust = (supplied: number, borrowed: number) =>
    makeRaw({
      reserves: [
        reserve({ asset: 'CXLM…', supplied: 1_000, borrowed: 0 }),
        reserve({ asset: 'CDUST…', supplied, borrowed }),
      ],
    });

  it('stops a dust reserve setting both factors', async () => {
    // $3 of a $1,003 pool is 0.30% — under the line, and with no K2 floor to
    // rescue it. This is the 2026-08-16 K2 snapshot in miniature.
    const f = await factors(withDust(3, 2));
    assert.equal(f.liquiditySafety!.value, 100, 'the surviving reserve is undrawn');
    assert.equal(f.utilizationSafety!.value, 100);
  });

  it('keeps a reserve that clears 0.5% even though it is still small', async () => {
    // $8 of a $1,008 pool is 0.79%. Small in absolute terms and kept anyway —
    // an absolute-only filter sized for a real market would have thrown away
    // every reserve K2 has. 4/8 drawn → free 50, headroom (0.8−0.5)/0.8 = 37.5.
    const f = await factors(withDust(8, 4));
    assert.equal(f.liquiditySafety!.value, 50, 'the small reserve still binds');
    assert.equal(f.utilizationSafety!.value, 38);
  });

  it('publishes what it excluded, including the score it suppressed', async () => {
    // A reserve being excluded from scoring is not the same as it not existing.
    // The disclosure carries the number we chose not to publish so a reader can
    // disagree with the exclusion rather than never learning of it.
    const f = await factors(withDust(3, 2));
    const excluded = f.liquiditySafety!.components!.find((c) => c.id === 'excludedReserves')!;
    assert.equal(excluded.value, null, 'a disclosure is measured and shown, never graded');
    assert.match(excluded.detail, /CDUST…/);
    assert.match(excluded.detail, /\$3\.00/);
    assert.match(excluded.detail, /0\.30% of pool/);
    assert.match(excluded.detail, /would have scored 33/, '2 of 3 drawn → 33% free');
  });
});

describe('minimum-size filter — excluding everything still cannot publish 100', () => {
  // Unreachable on a real pool for the reason spelled out in blend.test.ts — the
  // largest of n reserves always holds >= 1/n — so it takes 201 equal reserves
  // to starve the relative leg everywhere. Pinned because this is precisely
  // where the filter could smuggle back the "0 not 100" defect.
  const starved = makeRaw({
    reserves: Array.from({ length: 201 }, (_, i) =>
      reserve({ asset: `C${i}`.padEnd(56, 'X'), supplied: 1, borrowed: 0 }),
    ),
  });

  it('both factors report cannot-assess, not maximally safe', async () => {
    const f = await factors(starved);
    assert.equal(f.liquiditySafety!.value, 0, 'a filtered-empty set is undefined, not 100');
    assert.equal(f.utilizationSafety!.value, 0);
  });

  it('distinguishes "all too small" from "the pool is empty"', async () => {
    const filtered = await factors(starved);
    const empty = await factors(makeRaw({ reserves: [] }));
    for (const key of ['liquiditySafety', 'utilizationSafety'] as const) {
      assert.notEqual(filtered[key]!.detail, empty[key]!.detail);
      assert.match(filtered[key]!.detail, /below the minimum scorable size/);
      assert.doesNotMatch(filtered[key]!.detail, /worst reserve/);
    }
  });
});

// ---------------------------------------------------------------------------
// oracleSafety reports every stale reserve, not one tie-break winner.
//
// The score was never wrong; the explanation was. With two feeds both pinned at
// freshness 0, the old detail named whichever came last in iteration order — so
// a $4.00 dust reserve was reported as the cause while a reserve thirteen times
// larger, equally dead, went unmentioned. That is what the bug report was filed on.
// oracleSafety is deliberately NOT size-filtered (METHODOLOGY.md §2), so the
// only fix owed here is an honest explanation.
// ---------------------------------------------------------------------------

describe('oracleSafety — a tie names every reserve in it', () => {
  /** K2's live shape: two fresh feeds, two dead ones of very different ages. */
  const mixedStaleness = makeRaw({
    reserves: [
      reserve({ asset: 'CUSDCAAAA', supplied: 54, ageSeconds: 19_599 }),
      reserve({ asset: 'CXLMAAAAA', supplied: 1_450, ageSeconds: 167 }),
      reserve({ asset: 'CPYUSDAAA', supplied: 4, ageSeconds: 39_955 }),
      reserve({ asset: 'CSOLVAAAA', supplied: 37, ageSeconds: 17 }),
    ],
  });

  it('names both dead feeds, not just the worse one', async () => {
    const f = await factors(mixedStaleness);
    assert.equal(f.oracleSafety!.value, 0);
    assert.match(f.oracleSafety!.detail, /2 of 4 reserves tied at the worst score/);
    assert.match(f.oracleSafety!.detail, /CUSDCA…/, 'the larger dead reserve must appear');
    assert.match(f.oracleSafety!.detail, /CPYUSD…/, 'the dust dead reserve must appear too');
  });

  it('does not mention the reserves that are actually fresh', async () => {
    const f = await factors(mixedStaleness);
    assert.doesNotMatch(f.oracleSafety!.detail, /CXLMAA…/);
    assert.doesNotMatch(f.oracleSafety!.detail, /CSOLVA…/);
  });

  it('still names a single reserve when only one is worst', async () => {
    // The common case must not get more verbose to serve the tie case.
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CFRESHAAA', ageSeconds: 10 }),
          reserve({ asset: 'CSTALEAAA', ageSeconds: 40_000 }),
        ],
      }),
    );
    assert.match(f.oracleSafety!.detail, /^worst reserve \(CSTALE…\)/);
  });

  it('scores the dust reserve exactly as it scores any other (§2 is not size-filtered)', async () => {
    // Pinning the decision that came out of it: a reserve too small for §4/§5
    // still counts
    // in full here. §2 measures a vulnerability, and a stale price on a dust
    // reserve is an open door rather than a small room — nothing stops an
    // attacker supplying into it at the stale price. Size-filtering §2 would
    // blind it to the newly-listed-thin-asset shape the YieldBlox incident ran
    // through, which is the exact scenario this factor exists to catch.
    const dustOnlyStale = makeRaw({
      reserves: [
        reserve({ asset: 'CBIGAAAAA', supplied: 1_000_000, ageSeconds: 10 }),
        reserve({ asset: 'CDUSTAAAA', supplied: 1, ageSeconds: 40_000 }),
      ],
    });
    const f = await factors(dustOnlyStale);
    assert.equal(f.oracleSafety!.value, 0, 'a dust reserve must still be able to sink this factor');
    assert.match(f.oracleSafety!.detail, /CDUSTA…/);
    // And it is genuinely excluded from the factors that DO filter by size.
    assert.equal(sub(f.liquiditySafety!, 'excludedReserves'), null);
  });
});

describe('oracleSafety — per-feed price ages are disclosed', () => {
  it('shows both ends of the spread, not just the graded worst', async () => {
    // The finding this exists for: one oracle, one batchAdapter source, some
    // feeds seconds-fresh and others untouched for hours. A reader seeing
    // oracleSafety 0 could not previously tell those apart from a dead oracle.
    const f = await factors(
      makeRaw({
        reserves: [
          reserve({ asset: 'CUSDCAAAA', ageSeconds: 21_421 }),
          reserve({ asset: 'CXLMAAAAA', ageSeconds: 177 }),
          reserve({ asset: 'CPYUSDAAA', ageSeconds: 41_777 }),
          reserve({ asset: 'CSOLVAAAA', ageSeconds: 27 }),
        ],
      }),
    );
    const ages = f.oracleSafety!.components!.find((c) => c.id === 'priceAges')!;
    assert.equal(ages.value, null, 'a disclosure is never graded');
    assert.match(ages.detail, /41777s/);
    assert.match(ages.detail, /27s/, 'the fresh end must be visible too');
    assert.match(ages.detail, /2 of 4 past the protocol's own 3600s staleness limit/);
  });

  it('does not let the disclosure move the score', async () => {
    // It republishes inputs priceFreshness already used. If it ever gained a
    // numeric value it would double-count the same staleness.
    const f = await factors(makeRaw({ reserves: [reserve({ ageSeconds: 41_777 })] }));
    const scored = f.oracleSafety!.components!.filter((c) => c.value !== null).map((c) => c.id);
    assert.deepEqual(scored, ['priceFreshness', 'deviationBound']);
  });
});

// ---------------------------------------------------------------------------
// Operational state — published, never scored
// ---------------------------------------------------------------------------

describe('operationalState — router pause and per-reserve flags', () => {
  const open = { active: true, frozen: false, borrowingEnabled: true, paused: false };

  it('reports active when the router is open and every reserve is unrestricted', () => {
    const s = adapter.operationalState(makeRaw());
    assert.equal(s.level, OperationalLevel.Active);
    assert.equal(s.source, 'router.is_paused() = false');
    assert.deepEqual(s.blocked, []);
  });

  it('reports exitDisabled on a global pause — funds cannot leave', () => {
    // The sharpest difference from Blend, and the reason the shared type is
    // built on blocked operations rather than on either protocol's vocabulary:
    // storage::is_paused is checked at the top of validate_withdraw and
    // validate_repay as well as validate_supply/borrow/liquidation, so a paused
    // K2 traps deposits in a way no Blend status can.
    const s = adapter.operationalState(makeRaw({ paused: true }));
    assert.equal(s.level, OperationalLevel.ExitDisabled);
    assert.deepEqual(s.blocked, ['supply', 'withdraw', 'borrow', 'repay', 'liquidate']);
    assert.equal(s.origin, 'admin');
    assert.match(s.detail, /withdrawals/);
  });

  it('reports a frozen reserve as entryDisabled — exit stays open, as on Blend', () => {
    const s = adapter.operationalState(
      makeRaw({ reserves: [reserve({ flags: { frozen: true } })] }),
    );
    assert.equal(s.level, OperationalLevel.EntryDisabled);
    assert.deepEqual(s.blocked, ['supply', 'borrow']);
  });

  it('reports borrowing-disabled on a reserve as borrowingDisabled', () => {
    const s = adapter.operationalState(
      makeRaw({ reserves: [reserve({ flags: { borrowingEnabled: false } })] }),
    );
    assert.equal(s.level, OperationalLevel.BorrowingDisabled);
    assert.deepEqual(s.blocked, ['borrow']);
  });

  it('treats an inactive reserve exactly like a paused one', () => {
    // validate_withdraw rejects both `!is_active()` and `is_paused()`, so a
    // depositor is equally stuck either way and the two must not classify apart.
    const inactive = adapter.operationalState(
      makeRaw({ reserves: [reserve({ flags: { active: false } })] }),
    );
    const paused = adapter.operationalState(
      makeRaw({ reserves: [reserve({ flags: { paused: true } })] }),
    );
    assert.equal(inactive.level, OperationalLevel.ExitDisabled);
    assert.equal(paused.level, OperationalLevel.ExitDisabled);
  });

  it('takes the worst reserve, not the first or the majority', () => {
    // The real K2 shape: an open router and a mixed reserve set. Publishing
    // "active" here would say a market is fine while an asset in it is halted.
    const s = adapter.operationalState(
      makeRaw({
        reserves: [
          reserve({ asset: 'CUSDCAAAAA', flags: open }),
          reserve({ asset: 'CXLMAAAAAA', flags: open }),
          reserve({ asset: 'CPYUSDAAAA', flags: { paused: true } }),
        ],
      }),
    );
    assert.equal(s.level, OperationalLevel.ExitDisabled);
    assert.match(s.source, /CPYUSD/, 'names the reserve that bound');
  });

  it('names the router, not a reserve, when a global pause makes both true', () => {
    const s = adapter.operationalState(
      makeRaw({ paused: true, reserves: [reserve({ flags: { paused: true } })] }),
    );
    assert.equal(s.source, 'router.is_paused() = true');
  });

  it('publishes the raw flags verbatim so a reader can check them on chain', () => {
    const s = adapter.operationalState(
      makeRaw({ reserves: [reserve({ asset: 'CFROZENAAA', flags: { frozen: true } })] }),
    );
    assert.match(s.source, /active=true frozen=true borrowing_enabled=true paused=false/);
  });

  it('never reports notOperational — K2 publishes no unopened state', () => {
    for (const flags of [open, { frozen: true }, { paused: true }, { active: false }]) {
      const s = adapter.operationalState(
        makeRaw({ paused: false, reserves: [reserve({ flags })] }),
      );
      assert.notEqual(s.level, OperationalLevel.NotOperational);
    }
  });

  it('ignores the oracle own pause — that is an oracle fact, not a gating one', () => {
    // oracleConfig.paused stays captured and unscored. Folding it in here would
    // report the same condition twice, in a field defined as "which operations
    // the market refuses" — which a paused oracle does not by itself change.
    const raw = makeRaw();
    const withPausedOracle = { ...raw, oracleConfig: { ...raw.oracleConfig, paused: true } };
    assert.deepEqual(adapter.operationalState(withPausedOracle), adapter.operationalState(raw));
  });

  it('stamps asOf from the fetch clock', () => {
    assert.equal(
      adapter.operationalState(makeRaw()).asOf,
      new Date(FETCHED_AT * 1000).toISOString(),
    );
  });
});

describe('operationalState never reaches a score', () => {
  it('produces a byte-identical factor map however restricted the market is', async () => {
    // The K2 half of the check in blend.test.ts. Live K2 has never been paused
    // and every reserve has always been open, so nothing but a synthetic case
    // can prove pause state is inert — and inert is the entire decision.
    const baseline = await factors(makeRaw());
    const restricted = [
      makeRaw({ paused: true }),
      makeRaw({ reserves: [reserve({ flags: { paused: true } })] }),
      makeRaw({ reserves: [reserve({ flags: { frozen: true } })] }),
      makeRaw({ reserves: [reserve({ flags: { active: false } })] }),
      makeRaw({ reserves: [reserve({ flags: { borrowingEnabled: false } })] }),
    ];
    for (const [i, raw] of restricted.entries()) {
      assert.deepEqual(await factors(raw), baseline, `restricted case ${i} moved a factor`);
    }
  });

  it('scores the same however restricted the market is', async () => {
    const raws = [
      makeRaw(),
      makeRaw({ paused: true }),
      makeRaw({ reserves: [reserve({ flags: { paused: true } })] }),
    ];
    const scores = await Promise.all(
      raws.map(async (raw) => adapter.score(await factors(raw)).score),
    );
    assert.equal(new Set(scores).size, 1, `restrictions produced different scores: ${scores}`);
  });
});
