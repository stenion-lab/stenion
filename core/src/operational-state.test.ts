// Tests for the shared operational-state classification.
//
// WHY THESE EXIST. This module is the one place two adapters could come to
// disagree about what "frozen" means, and unlike a factor there is no score to
// notice the drift — a wrong level publishes a wrong word beside a correct
// number, which is harder to spot than a wrong number. So the ladder is pinned
// here, on the cases live data cannot reach: Blend has never been anything but
// status 0/1 and K2 has never been paused, so every restricted state below is
// one no fixture will ever supply.
//
// Run with: pnpm --filter @stenion/core test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CATEGORY_OPERATIONS,
  DexOperation,
  OperationalLevel,
  PoolOperation,
  mostRestrictive,
  toDexOperationalState,
  toOperationalState,
} from './operational-state.ts';
import { PROTOCOL_CATEGORIES } from './category.ts';
import type { OperationalReading } from './operational-state.ts';

const AS_OF = new Date('2026-08-25T10:00:00.000Z');

// EXPLICITLY `<'lending'>`, where it used to rely on the default. While lending
// was the only category the default parameter WAS lending, so an unparameterized
// reading happened to satisfy `toOperationalState`. With `dex` registered the
// default is every category's vocabulary — correctly, that is what a storage row
// holds — and a lending classifier must not accept one. Saying which category
// these readings belong to is the fix, and it is the same thing the dex helper
// below does.
const reading = (
  over: Partial<OperationalReading<'lending'>> = {},
): OperationalReading<'lending'> => ({
  blocked: [],
  neverOpened: false,
  source: 'test',
  origin: 'indeterminate',
  detail: 'test',
  asOf: AS_OF,
  ...over,
});

const dexReading = (over: Partial<OperationalReading<'dex'>> = {}): OperationalReading<'dex'> => ({
  blocked: [],
  neverOpened: false,
  source: 'test',
  origin: 'indeterminate',
  detail: 'test',
  asOf: AS_OF,
  ...over,
});

describe('toOperationalState — the shared ladder', () => {
  it('calls nothing-blocked active', () => {
    assert.equal(toOperationalState(reading()).level, OperationalLevel.Active);
  });

  it('calls borrow-only borrowingDisabled — Blend On-Ice, K2 borrowing_enabled=false', () => {
    const state = toOperationalState(reading({ blocked: [PoolOperation.Borrow] }));
    assert.equal(state.level, OperationalLevel.BorrowingDisabled);
  });

  it('calls supply+borrow entryDisabled, and does NOT call it exitDisabled', () => {
    // This is the distinction the whole type exists for. Blend's Frozen blocks
    // supplying and borrowing while leaving withdrawals open, so a depositor can
    // still leave; calling that the same thing as K2's pause would be the single
    // most misleading output this module could produce.
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Supply, PoolOperation.Borrow] }),
    );
    assert.equal(state.level, OperationalLevel.EntryDisabled);
    assert.notEqual(state.level, OperationalLevel.ExitDisabled);
  });

  it('calls anything blocking withdrawals exitDisabled, whatever else it blocks', () => {
    // Withdraw is checked first precisely so it cannot be masked by the presence
    // of other blocked operations.
    const everything = toOperationalState(
      reading({
        blocked: [
          PoolOperation.Supply,
          PoolOperation.Withdraw,
          PoolOperation.Borrow,
          PoolOperation.Repay,
          PoolOperation.Liquidate,
        ],
      }),
    );
    assert.equal(everything.level, OperationalLevel.ExitDisabled);

    // Withdraw alone is not a state either protocol can produce, but the rule
    // must not depend on company: the ladder reads the operation, not the set.
    const alone = toOperationalState(reading({ blocked: [PoolOperation.Withdraw] }));
    assert.equal(alone.level, OperationalLevel.ExitDisabled);
  });

  it('lets neverOpened supersede the ladder rather than flattening into entryDisabled', () => {
    // Blend's Setup blocks exactly what its Frozen blocks, so without this the
    // two would be indistinguishable — and "never opened" is a different claim
    // from "restricted", not a more severe version of it.
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Supply, PoolOperation.Borrow], neverOpened: true }),
    );
    assert.equal(state.level, OperationalLevel.NotOperational);
  });

  it('publishes blocked in canonical order regardless of the order it was given', () => {
    // Two adapters reporting the same restriction must produce byte-identical
    // output, or a diff between them reads as a difference in state.
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Liquidate, PoolOperation.Borrow, PoolOperation.Supply] }),
    );
    assert.deepEqual(state.blocked, [
      PoolOperation.Supply,
      PoolOperation.Borrow,
      PoolOperation.Liquidate,
    ]);
  });

  it('deduplicates a repeated operation', () => {
    const state = toOperationalState(
      reading({ blocked: [PoolOperation.Borrow, PoolOperation.Borrow] }),
    );
    assert.deepEqual(state.blocked, [PoolOperation.Borrow]);
  });

  it('carries the reading through verbatim and stamps asOf as ISO', () => {
    const state = toOperationalState(
      reading({ source: 'PoolConfig.status = 4', origin: 'admin', detail: 'because' }),
    );
    assert.equal(state.source, 'PoolConfig.status = 4');
    assert.equal(state.origin, 'admin');
    assert.equal(state.detail, 'because');
    assert.equal(state.asOf, '2026-08-25T10:00:00.000Z');
  });
});

describe('mostRestrictive — reducing several readings to one', () => {
  // Every level a LENDING reading can classify as. `swapDisabled` is excluded
  // because no lending reading can produce it — `blocked` here is lending's
  // vocabulary, which has no `swap` in it — and a `Record` over the full ladder
  // would demand a lending blocked-set for a rung lending cannot reach. The
  // `Exclude` is the assertion, not a workaround: it fails if `swapDisabled`
  // ever becomes reachable from these five operations.
  type LendingLevel = Exclude<OperationalLevel, typeof OperationalLevel.SwapDisabled>;

  const at = (level: LendingLevel, source: string) => {
    const blocked: Record<LendingLevel, PoolOperation[]> = {
      [OperationalLevel.Active]: [],
      [OperationalLevel.BorrowingDisabled]: [PoolOperation.Borrow],
      [OperationalLevel.EntryDisabled]: [PoolOperation.Supply, PoolOperation.Borrow],
      [OperationalLevel.ExitDisabled]: [PoolOperation.Withdraw],
      [OperationalLevel.NotOperational]: [PoolOperation.Supply],
    };
    return toOperationalState(
      reading({
        blocked: blocked[level],
        neverOpened: level === OperationalLevel.NotOperational,
        source,
      }),
    );
  };

  it('takes the worst, not the first or the most common', () => {
    // The K2 shape: an open router, three open reserves, one halted. Publishing
    // "active" here would say a market is fine while an asset in it is frozen.
    const worst = mostRestrictive([
      at(OperationalLevel.Active, 'router'),
      at(OperationalLevel.Active, 'usdc'),
      at(OperationalLevel.ExitDisabled, 'pyusd'),
      at(OperationalLevel.Active, 'xlm'),
    ]);
    assert.equal(worst.level, OperationalLevel.ExitDisabled);
    assert.equal(worst.source, 'pyusd');
  });

  it('keeps the first reading on a tie, so a global cause outranks a local one', () => {
    // A paused router also makes every reserve unusable. Both readings classify
    // the same, and "the router is paused" is the more informative of the two.
    const worst = mostRestrictive([
      at(OperationalLevel.ExitDisabled, 'router'),
      at(OperationalLevel.ExitDisabled, 'usdc'),
    ]);
    assert.equal(worst.source, 'router');
  });

  it('returns the single reading when there is only one', () => {
    assert.equal(mostRestrictive([at(OperationalLevel.Active, 'pool')]).source, 'pool');
  });

  it('throws on no readings rather than defaulting to active', () => {
    // "Nothing was read" is not "nothing is restricted". An adapter that
    // produced no reading has a bug, and publishing a clean bill of health from
    // it is the one failure mode this module must not have.
    assert.throws(() => mostRestrictive([]), /no operational readings/);
  });
});

// ---------------------------------------------------------------------------
// The category-scoped operation vocabulary
// ---------------------------------------------------------------------------

describe('CATEGORY_OPERATIONS — vocabulary per category, ladder shared', () => {
  it('gives every category an operation vocabulary', () => {
    // `operationalState` is a REQUIRED adapter method, so a category with no
    // vocabulary is a category whose adapters cannot describe their own
    // restrictions. `satisfies` catches this at compile time; this catches the
    // runtime shape the adapters actually index into.
    for (const category of PROTOCOL_CATEGORIES) {
      const vocabulary = CATEGORY_OPERATIONS[category];
      assert.equal(typeof vocabulary, 'object', `${category} has no operation vocabulary`);
      assert.ok(Object.keys(vocabulary).length > 0, `${category}'s vocabulary is empty`);
    }
  });

  it("leaves lending's five operations exactly as they were", () => {
    // The whole of what scoping the vocabulary changed here is the TYPE — which
    // category's names these are. Not one member was added, removed or renamed, because renaming
    // one would change `blocked` in every stored operational_state jsonb and in
    // every API response, for a refactor that was supposed to move no data.
    assert.deepEqual(Object.values(CATEGORY_OPERATIONS.lending).sort(), [
      'borrow',
      'liquidate',
      'repay',
      'supply',
      'withdraw',
    ]);
  });

  it('registers lending against the same object PoolOperation exports', () => {
    // Not a copy. Two lists of the same five strings would be two things to keep
    // in sync, which is the shape this registry exists to avoid.
    assert.equal(CATEGORY_OPERATIONS.lending, PoolOperation);
  });

  it('keeps OperationalLevel shared across categories, not scoped to one', () => {
    // The deliberate half of the split: the ladder is abstracted around "can a
    // user still get out", which is the same question for any market a user can
    // put value into. If a future change moves these rungs into
    // CATEGORY_OPERATIONS-style per-category tables, the shared representation
    // this module exists for is gone — see its header.
    //
    // `swapDisabled` arrived with `dex` and did NOT fork the ladder: it
    // is a sixth rung on the one shared ladder, which is the whole point of
    // adding it here rather than giving dex a ladder of its own.
    assert.deepEqual(Object.values(OperationalLevel).sort(), [
      'active',
      'borrowingDisabled',
      'entryDisabled',
      'exitDisabled',
      'notOperational',
      'swapDisabled',
    ]);
  });

  it("registers dex's four operations, against the same object DexOperation exports", () => {
    assert.equal(CATEGORY_OPERATIONS.dex, DexOperation);
    assert.deepEqual(Object.values(CATEGORY_OPERATIONS.dex).sort(), [
      'claim',
      'deposit',
      'swap',
      'withdraw',
    ]);
  });

  it('shares only `withdraw` between the two vocabularies', () => {
    // Not an accident and not a coupling: `withdraw` is the same user intent in
    // both, and nothing else overlaps. If a future category's vocabulary starts
    // colliding on more of these, that is a sign the words are being reused for
    // different intents — which is exactly what per-category vocabularies exist
    // to prevent.
    const lending = new Set<string>(Object.values(CATEGORY_OPERATIONS.lending));
    const shared = Object.values(CATEGORY_OPERATIONS.dex).filter((op) => lending.has(op));
    assert.deepEqual(shared, ['withdraw']);
  });
});

// ---------------------------------------------------------------------------

describe('toDexOperationalState — the dex ladder', () => {
  it('calls nothing-blocked active', () => {
    assert.equal(toDexOperationalState(dexReading()).level, OperationalLevel.Active);
  });

  it('calls a swap-killed pool swapDisabled, NOT active — open question C', () => {
    // THE ASSERTION THIS RUNG EXISTS FOR. Aquarius's `kill_swap` halts the
    // market while both LP paths stay open. Under the ladder as it stood before
    // `dex` was admitted this classified `active` — true about exit, and wrong
    // about the market — and `level` is the field a reader scans.
    const state = toDexOperationalState(dexReading({ blocked: [DexOperation.Swap] }));
    assert.equal(state.level, OperationalLevel.SwapDisabled);
    assert.deepEqual(state.blocked, ['swap']);
  });

  it('calls a deposit-killed pool entryDisabled, and does NOT call it exitDisabled', () => {
    // The live case: two stable pools read `is_killed_deposit = true` on
    // 2026-08-27. No new LP exposure, and every existing LP can still leave.
    assert.equal(
      toDexOperationalState(dexReading({ blocked: [DexOperation.Deposit] })).level,
      OperationalLevel.EntryDisabled,
    );
    assert.equal(
      toDexOperationalState(dexReading({ blocked: [DexOperation.Swap, DexOperation.Deposit] }))
        .level,
      OperationalLevel.EntryDisabled,
    );
  });

  it('calls anything blocking withdrawals exitDisabled, whatever else it blocks', () => {
    // Unreachable from Aquarius — there is no `kill_withdraw` in any of the
    // three pool wasms — and pinned anyway: the rung is the top of the shared
    // ladder, and a second dex protocol that CAN freeze withdrawals must have
    // somewhere to say so.
    for (const blocked of [
      [DexOperation.Withdraw],
      [DexOperation.Swap, DexOperation.Withdraw],
      [DexOperation.Deposit, DexOperation.Withdraw],
      [DexOperation.Swap, DexOperation.Deposit, DexOperation.Withdraw, DexOperation.Claim],
    ]) {
      assert.equal(
        toDexOperationalState(dexReading({ blocked })).level,
        OperationalLevel.ExitDisabled,
      );
    }
  });

  it('gives claim no rung of its own — principal is untouched', () => {
    // Reportable, deliberately not rankable: an LP whose reward claim is killed
    // can still withdraw every unit of principal. Same reasoning lending gives
    // for repay and liquidate.
    const state = toDexOperationalState(dexReading({ blocked: [DexOperation.Claim] }));
    assert.equal(state.level, OperationalLevel.Active);
    assert.deepEqual(state.blocked, ['claim'], 'still published, just not on the ladder');
  });

  it('publishes blocked in canonical order regardless of the order it was given', () => {
    const state = toDexOperationalState(
      dexReading({
        blocked: [
          DexOperation.Claim,
          DexOperation.Withdraw,
          DexOperation.Deposit,
          DexOperation.Swap,
        ],
      }),
    );
    assert.deepEqual(state.blocked, ['swap', 'deposit', 'withdraw', 'claim']);
  });

  it('deduplicates a repeated operation', () => {
    const state = toDexOperationalState(
      dexReading({ blocked: [DexOperation.Swap, DexOperation.Swap] }),
    );
    assert.deepEqual(state.blocked, ['swap']);
  });

  it('lets neverOpened supersede the ladder, as it does for lending', () => {
    assert.equal(
      toDexOperationalState(dexReading({ neverOpened: true, blocked: [DexOperation.Swap] })).level,
      OperationalLevel.NotOperational,
    );
  });

  it('carries the reading through verbatim and stamps asOf as ISO', () => {
    const state = toDexOperationalState(
      dexReading({
        source: 'get_is_killed_swap() = true',
        origin: 'admin',
        detail: 'swaps halted; deposits and withdrawals open',
      }),
    );
    assert.equal(state.source, 'get_is_killed_swap() = true');
    assert.equal(state.origin, 'admin');
    assert.equal(state.detail, 'swaps halted; deposits and withdrawals open');
    assert.equal(state.asOf, '2026-08-25T10:00:00.000Z');
  });

  it('ranks swapDisabled level with borrowingDisabled and below entryDisabled', () => {
    // The two core-activity rungs are the same degree of restriction in two
    // vocabularies, so `mostRestrictive` must not prefer either — and a dex
    // reading that blocks deposits must still outrank one that blocks swaps.
    const swap = toDexOperationalState(dexReading({ blocked: [DexOperation.Swap], source: 'a' }));
    const entry = toDexOperationalState(
      dexReading({ blocked: [DexOperation.Deposit], source: 'b' }),
    );
    assert.equal(mostRestrictive([swap, entry]).source, 'b');
    assert.equal(mostRestrictive([entry, swap]).source, 'b');

    // Equal rank: ties keep the first reading, in both orders.
    const alsoSwap = toDexOperationalState(
      dexReading({ blocked: [DexOperation.Swap], source: 'c' }),
    );
    assert.equal(mostRestrictive([swap, alsoSwap]).source, 'a');
    assert.equal(mostRestrictive([alsoSwap, swap]).source, 'c');
  });
});

// ---------------------------------------------------------------------------

describe('the lending ladder is untouched by the second category', () => {
  it('classifies lending readings exactly as it did before categories existed', () => {
    // The regression guard for this issue. Same inputs, same ladder, same
    // outputs — the type changed and the behaviour did not.
    assert.equal(toOperationalState(reading()).level, OperationalLevel.Active);
    assert.equal(
      toOperationalState(reading({ blocked: [PoolOperation.Withdraw] })).level,
      OperationalLevel.ExitDisabled,
    );
    assert.equal(
      toOperationalState(reading({ blocked: [PoolOperation.Supply] })).level,
      OperationalLevel.EntryDisabled,
    );
    assert.equal(
      toOperationalState(reading({ blocked: [PoolOperation.Borrow] })).level,
      OperationalLevel.BorrowingDisabled,
    );
    assert.equal(
      toOperationalState(reading({ neverOpened: true })).level,
      OperationalLevel.NotOperational,
    );
  });

  it('cannot produce the dex rung from any lending reading', () => {
    // The other half of "no lending operation was renamed, added or removed":
    // adding a rung to a SHARED ladder is only safe if the categories that did
    // not ask for it cannot reach it. Every subset of lending's vocabulary,
    // with and without neverOpened — 64 readings — and none classifies as
    // `swapDisabled`.
    const ops = Object.values(PoolOperation);
    for (let mask = 0; mask < 1 << ops.length; mask++) {
      const blocked = ops.filter((_, i) => mask & (1 << i));
      for (const neverOpened of [false, true]) {
        assert.notEqual(
          toOperationalState(reading({ blocked, neverOpened })).level,
          OperationalLevel.SwapDisabled,
          `blocked=[${blocked.join(',')}] neverOpened=${neverOpened} reached a dex-only rung`,
        );
      }
    }
  });
});
