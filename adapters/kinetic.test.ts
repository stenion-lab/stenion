// Fixture tests for KineticAdapter.computeRiskFactors, plus the one decode
// helper that is worth testing directly.
//
// WHY THESE EXIST: K2's half of methodology v2 turns on a rule Blend has no
// equivalent of — its circuit breaker fails *open*. `validate_price_change`
// returns Ok when there is no stored baseline, so a configured
// `max_price_change_bps` with no `get_last_price` is inert: configured, but not
// armed. That is exactly the newly-listed-thin-asset case the YieldBlox
// incident ran through, and no live K2 reserve is in that state today, so only
// a fixture can prove we score it as unbounded.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KineticAdapter, decodeDecimals } from './kinetic.ts';
import type { KineticRawData, KineticReserveRaw } from './kinetic.ts';
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
  } = o;

  const unit = BigInt(10) ** BigInt(decimals);
  return {
    asset,
    decimals,
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

// ---------------------------------------------------------------------------

describe('decodeDecimals — ReserveConfiguration bitmap', () => {
  // Bits 42-49 of data_low. An off-by-one in the shift or a wrong mask returns a
  // plausible number that silently rescales every balance for the reserve by a
  // power of ten, so the exact bit positions are pinned here.
  it('reads decimals out of bits 42-49', () => {
    for (const d of [0, 6, 7, 8, 18, 255]) {
      assert.equal(decodeDecimals({ data_low: BigInt(d) << 42n, data_high: 0n }), d);
    }
  });

  it('ignores the neighbouring fields packed around it', () => {
    // LTV/liquidation fields sit below bit 42; flags and reserve_factor above
    // bit 49. Setting all of them must not perturb the decimals read — which is
    // what proves both the shift and the 8-bit mask.
    const below = (1n << 42n) - 1n; // every bit under the decimals field
    const above = ((1n << 21n) - 1n) << 50n; // every bit above it
    assert.equal(decodeDecimals({ data_low: (7n << 42n) | below | above, data_high: 0n }), 7);
  });

  it('is not off by one in either direction', () => {
    // A shift of 41 would read this as 14, a shift of 43 as 3.
    assert.equal(decodeDecimals({ data_low: 7n << 42n, data_high: 0n }), 7);
    // And the mask is 8 bits, not 7: 255 must survive, not wrap to 127.
    assert.equal(decodeDecimals({ data_low: 255n << 42n, data_high: 0n }), 255);
  });

  it('accepts a number as well as a bigint', () => {
    assert.equal(decodeDecimals({ data_low: Number(7n << 42n), data_high: 0 }), 7);
  });
});

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
    assert.equal(tightness.value, null, 'tightness is disclosed, never scored (§2c)');
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
