// Tests for ./fetch.ts's bitmap decoders — the two reads that turn K2's packed
// `ReserveConfiguration` words into the raw shape everything else is computed
// from.
//
// No RPC here: these are the pure decodes, and they are pinned against known
// bitmaps because their failure mode is silent. An off-by-one in a shift or a
// wrong mask returns a plausible number or a plausible boolean, and live data
// cannot tell that apart from a real balance change or a real restriction. The
// scoring these feed is in ./score.test.ts.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeDecimals, decodeReserveFlags } from './index.ts';

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

describe('decodeReserveFlags — the gating bits of the same bitmap', () => {
  // Bits 50-53 of data_low, from ReserveConfiguration in contracts/shared/src/utils.rs.
  // Pinned individually because they sit next to the decimals field: a shift
  // that is off by one reads a plausible boolean out of the wrong bit and
  // publishes a restriction the market does not have, or hides one it does.
  const at = (bit: bigint) => decodeReserveFlags({ data_low: 1n << bit, data_high: 0n });

  it('reads each flag from its own bit', () => {
    assert.equal(at(50n).active, true);
    assert.equal(at(51n).frozen, true);
    assert.equal(at(52n).borrowingEnabled, true);
    assert.equal(at(53n).paused, true);
  });

  it('does not confuse a flag with a neighbouring one', () => {
    assert.deepEqual(at(50n), {
      active: true,
      frozen: false,
      borrowingEnabled: false,
      paused: false,
    });
    assert.deepEqual(at(53n), {
      active: false,
      frozen: false,
      borrowingEnabled: false,
      paused: true,
    });
  });

  it('is not disturbed by the decimals sitting immediately below it', () => {
    // decimals occupies 42-49; a full byte there must not bleed into bit 50.
    const cfg = { data_low: (255n << 42n) | (1n << 51n), data_high: 0n };
    assert.equal(decodeDecimals(cfg), 255);
    assert.deepEqual(decodeReserveFlags(cfg), {
      active: false,
      frozen: true,
      borrowingEnabled: false,
      paused: false,
    });
  });
});
