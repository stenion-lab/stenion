/**
 * Operational state — live, measured, published, and deliberately NOT scored.
 *
 * This is the third category of published data, alongside scored factors and
 * the static Findings notes (see CLAUDE.md). It exists because pause/frozen
 * state is a real, changing, on-chain reading that changes how a score should
 * be read, but which nothing on chain lets us grade. That tension was resolved
 * by publishing it rather than scoring it; the full reasoning is in
 * METHODOLOGY.md, "Operational state is published, never scored".
 *
 * WHY THIS FILE IS NOT IN scoring.ts. `scoring.ts` is the shared *rulebook* —
 * every export in it feeds a factor value. Nothing here does, and nothing here
 * ever may: no function in this module is reachable from `scoreFactors`, and a
 * change to any of it cannot move a published number. Putting it beside the
 * rulebook would invite exactly the confusion the decision was made to avoid.
 *
 * WHY THESE ARE `as const` OBJECTS AND NOT `enum`s, unlike RiskFactorType. This
 * module is a leaf that tests import DIRECTLY (`./operational-state.ts`), and
 * Node's type-stripping loader rejects `enum` outright — it is a syntax that
 * emits code, not a type annotation it can erase. `RiskFactorType` gets away
 * with being an enum only because nothing imports `./types.ts` directly under
 * the test runner; reach for this shape in anything a test will load.
 *
 * WHAT IS SHARED AND WHAT IS NOT, on METHODOLOGY.md ground rule 1. The rule that
 * turns a set of blocked operations into a level lives here, once, so two
 * adapters cannot classify the same restriction two different ways. Reading
 * which operations a protocol has blocked is per-protocol input reading and
 * stays in the adapter, like every other raw read.
 *
 * WHAT IS PER CATEGORY. The *vocabulary* of operations (`CATEGORY_OPERATIONS`)
 * and the ordering and ladder that read it. `OperationalLevel` is shared across
 * every category — see `CATEGORY_OPERATIONS` for why that split falls where it
 * does.
 */

import type { ProtocolCategory } from './category';

/**
 * The operations a lending market can restrict, named by what a user is trying
 * to do rather than by any protocol's own method names.
 *
 * Deliberately a small closed set covering what a depositor or borrower can be
 * stopped from doing. It is NOT a complete list of every entry point either
 * protocol exposes — flash loans, auction bookkeeping and admin calls are all
 * omitted, because a state that blocks only those is not a state a reader of a
 * risk score needs to weigh.
 *
 * THIS IS LENDING'S VOCABULARY, and only lending's — see `CATEGORY_OPERATIONS`.
 * Its five members are unchanged: nothing was added, removed or renamed when the
 * vocabulary became category-scoped.
 */
export const PoolOperation = {
  /** deposit into the market */
  Supply: 'supply',
  /** take a deposit back out — the one that decides whether funds are trapped */
  Withdraw: 'withdraw',
  Borrow: 'borrow',
  Repay: 'repay',
  /** third-party liquidation of an unhealthy position */
  Liquidate: 'liquidate',
} as const;
export type PoolOperation = (typeof PoolOperation)[keyof typeof PoolOperation];

/**
 * The operations an AMM pool can restrict, named by what a user is trying to do
 * rather than by any protocol's own method names.
 *
 * Four, and they are read from Aquarius's own kill switches: every pool wasm
 * exports `get_is_killed_swap()`, `get_is_killed_deposit()` and
 * `get_is_killed_claim()`, plus `get_emergency_mode()`. `Withdraw` is in the
 * vocabulary despite having no kill switch anywhere in any of the three pool
 * wasms — and that absence is the single strongest fact about an AMM LP's exit
 * risk, so the word has to exist for a reading to be able to say withdrawals are
 * open. A vocabulary that could not express "withdrawals cannot be halted here"
 * would hide the finding rather than publish it.
 *
 * `Claim` is reward claiming, which is neither entry nor exit: an LP whose claim
 * is killed still has every unit of principal available to withdraw. It appears
 * in `blocked` and, deliberately, nowhere on the ladder — see
 * `toDexOperationalState`.
 *
 * SHAPED LIKE `PoolOperation`, NOT DERIVED FROM IT. `Withdraw` here and
 * `Withdraw` there are the same string because they are the same user intent;
 * nothing else overlaps, and neither set may be widened to accommodate the
 * other. See `CATEGORY_OPERATIONS`.
 */
export const DexOperation = {
  /** trade one of the pool's assets for the other — the thing an AMM is for */
  Swap: 'swap',
  /** add liquidity: the LP entry path */
  Deposit: 'deposit',
  /** take liquidity back out — the one that decides whether funds are trapped */
  Withdraw: 'withdraw',
  /** claim accrued rewards; principal is unaffected either way */
  Claim: 'claim',
} as const;
export type DexOperation = (typeof DexOperation)[keyof typeof DexOperation];

/**
 * Each category's operation vocabulary, keyed by category.
 *
 * WHY THIS EXISTS. `operationalState` is a REQUIRED method on the adapter
 * interface (`ADAPTER_INTERFACE_VERSION` 2), so every adapter of every future
 * category has to satisfy it. But "which operations can be blocked" is not a
 * question with one answer across categories — it is a per-category vocabulary,
 * the way the factor set is. Leaving `PoolOperation` as the only vocabulary
 * would force the next category to either describe its restrictions in lending's
 * words or skip the method, and both are worse than saying which words belong to
 * which rulebook.
 *
 * TWO ENTRIES. `dex` is the second, and it registered exactly what this
 * design said it would: its own operation names here, its own canonical ordering
 * and its own classifier beside the lending ones below. **Not one lending
 * operation was renamed, added or removed** — renaming one would rewrite
 * `blocked` in every stored `operational_state` jsonb and in every API response,
 * for a change that moves no data.
 *
 * WHAT IS DELIBERATELY **NOT** CATEGORY-SCOPED: `OperationalLevel`. It is
 * already abstracted around "can a user still get out", which is the same
 * question for any market a user can put value into, and it is the hard-won part
 * of this module — the reason a shared representation is possible at all. It
 * stays one shared ladder, and `dex` joined it rather than forking it: see
 * `OperationalLevel.SwapDisabled` for what the second category cost that ladder
 * and why the alternative was worse.
 */
export const CATEGORY_OPERATIONS = {
  lending: PoolOperation,
  dex: DexOperation,
} as const satisfies Record<ProtocolCategory, Readonly<Record<string, string>>>;

/**
 * The operations one category can restrict.
 *
 * Defaulted to the whole union so a bare `OperationalState` still means "some
 * category's state" — which is what a storage row or an API response holds, since
 * neither is parameterized by the category of the protocol it describes.
 *
 * IT DISTRIBUTES OVER `C`, AND IT HAS TO. Written as the plain indexed access it
 * was while one category existed, `C = ProtocolCategory` indexes a UNION of
 * vocabulary objects, and `keyof` over a union is the keys they have in
 * COMMON — so the default silently resolved to `'withdraw'` alone the moment
 * `dex` was registered, the one operation both vocabularies name. That is the
 * exact inverse of what the default is for: a storage row would have been typed
 * as holding only withdrawals. Mapping over `C` and indexing the result unions
 * each category's operations instead, which is what "some category's state"
 * means. A third category cannot re-break it.
 *
 * WHY THE MAP IS HOISTED AND `C` APPEARS ONLY AS AN INDEX. Two shorter spellings
 * distribute correctly and both break assignability, so neither is a
 * simplification:
 *
 *   - `C extends ProtocolCategory ? … : never` — a conditional whose check type
 *     is an unresolved parameter is DEFERRED, so TS stops comparing
 *     `OperationalState<'lending'>` with `OperationalState<ProtocolCategory>`
 *     structurally and demands the type arguments match.
 *   - `{ [K in C]: … }[C]` — putting `C` in a mapped type's KEY position makes
 *     TS measure the parameter as invariant, with the same result.
 *
 * Either one breaks `toTarget<T>(adapter: Adapter<T>)` in the indexer: a
 * `<'lending'>` adapter stops being assignable to the heterogeneous run loop,
 * which is the one thing the default parameter exists to allow. Mapping over the
 * FIXED category union once, and indexing that with `C`, leaves `C` in a plain
 * indexed-access position — distributing over a union index, resolved eagerly,
 * measured covariantly. Don't inline it back.
 */
type OperationsByCategory = {
  [K in ProtocolCategory]: (typeof CATEGORY_OPERATIONS)[K][keyof (typeof CATEGORY_OPERATIONS)[K]];
};

export type OperationFor<C extends ProtocolCategory = ProtocolCategory> = OperationsByCategory[C];

/**
 * How restricted a market is, named by what is blocked rather than by any
 * protocol's own label.
 *
 * This is the whole reason a shared representation is possible at all. Blend
 * calls its states Active / On-Ice / Frozen / Setup across a seven-value `u32`;
 * K2 has a boolean plus four per-reserve bits. Those vocabularies do not map
 * onto each other — but "can a depositor still get out?" is the same question
 * for both, and it is the question that matters most. Mapping on the protocols'
 * own labels instead would put Blend's Frozen (withdrawals fine) and K2's paused
 * (withdrawals blocked) in the same bucket, which is the single most misleading
 * thing this type could do.
 */
export const OperationalLevel = {
  /** nothing restricted */
  Active: 'active',
  /** cannot borrow; supplying and withdrawing both work */
  BorrowingDisabled: 'borrowingDisabled',
  /**
   * Cannot trade; depositing and withdrawing both work.
   *
   * ADDED FOR `dex`, and the reason it is a new rung rather than a reused one.
   * Aquarius's `kill_swap` halts the market while leaving both LP paths open —
   * there is no `kill_withdraw` in any of the three pool wasms — so a swap-killed
   * pool is genuinely open on entry and on exit.
   * Under the ladder as it stood it would have classified `Active`: true about
   * exit, and wrong about the market. `blocked: ['swap']` carried the fact, but
   * `level` is the field a reader scans, and a dead market reading "active" is
   * the kind of quiet misstatement this whole type exists to prevent.
   *
   * WHY NOT GENERALIZE `BorrowingDisabled` INSTEAD. This rung and that one are
   * the same idea — the market's own core activity is halted while capital can
   * still come and go — and one shared `CoreActivityDisabled` would say so more
   * honestly than two category-flavoured names do. It was rejected on cost, not
   * on merit: `borrowingDisabled` is a value stored in every historical
   * `operational_state` jsonb and published on the API, so renaming it is a
   * breaking change to stored data and to the public contract, in a change whose
   * entire purpose was to add a category. Two named rungs and an accurate
   * `level` beat one elegant rung and a migration nobody asked for. If a third
   * category brings a third such rung, that is the point to reconsider.
   *
   * They sit at equal severity in `LEVEL_RANK` and can never meet: `blocked`
   * carries one category's vocabulary, so nothing can produce both.
   */
  SwapDisabled: 'swapDisabled',
  /** cannot borrow or supply — no new exposure — but existing positions can still exit */
  EntryDisabled: 'entryDisabled',
  /** cannot withdraw: funds cannot leave the market */
  ExitDisabled: 'exitDisabled',
  /** the market was never opened for use (Blend's Setup); nobody has funds in it */
  NotOperational: 'notOperational',
} as const;
export type OperationalLevel = (typeof OperationalLevel)[keyof typeof OperationalLevel];

/**
 * Who could have put the market in this state, as far as the chain says.
 *
 * Published because it is the closest on-chain data comes to the question the
 * score cannot answer — whether a restriction is an admin responding to a threat
 * or a mechanism reacting to one. It is NOT that answer, and must never be
 * presented as one: `protocol` says the protocol's own rules forced the state,
 * not that the state is bad; `admin` says a human chose it, not why.
 *
 * `indeterminate` is a real reading, not a gap. Blend's status 3 is settable
 * both by an admin and by the backstop update path, so the value genuinely does
 * not say which happened, and K2's boolean carries no origin at all.
 */
export type OperationalOrigin = 'admin' | 'protocol' | 'indeterminate';

/**
 * One market's operational state, as published on the API beside its score.
 *
 * Every field is a reading or a direct restatement of one. Nothing here is
 * graded, weighted, or combined into anything — see the module comment.
 */
export interface OperationalState<C extends ProtocolCategory = ProtocolCategory> {
  /** the shared classification; the only derived field, and derived by `toOperationalState` */
  level: OperationalLevel;
  /**
   * The protocol's OWN raw reading, verbatim, so a reader can check it against
   * the chain: `"PoolConfig.status = 4"`, `"router.is_paused() = true"`. Never a
   * Stenion label — that is what `level` is for.
   */
  source: string;
  /**
   * Exactly which operations the state blocks, as read from the protocol's own
   * gating logic. Carried explicitly rather than derived from `level` because
   * the two are not equivalent: Blend's Setup blocks supply and borrow while
   * still permitting withdrawals, which no point on the level ladder describes.
   *
   * Drawn from the vocabulary of the category `C` — see `CATEGORY_OPERATIONS`.
   */
  blocked: OperationFor<C>[];
  /** see OperationalOrigin — who could have set this, never why */
  origin: OperationalOrigin;
  /** what was read and what it means for a user, in one sentence */
  detail: string;
  /** when the reading was taken, ISO 8601 — a live state is only true as of an instant */
  asOf: string;
}

/**
 * Severity order, used only to reduce several readings into one market-level
 * state (`mostRestrictive`).
 *
 * It ranks how restricted a market is, NOT how risky it is — nothing in this
 * module ranks risk. `NotOperational` sits at the top because a market that
 * never opened is unusable in full, which is the most restricted thing a market
 * can be; that is not a claim that it is worse for a depositor than
 * `ExitDisabled`, because a market that never opened has no depositors to be
 * worse for. It also cannot arise from reducing reserve-level readings — only a
 * whole-market signal produces it — so it never actually competes on this ladder
 * in practice.
 *
 * `BorrowingDisabled` AND `SwapDisabled` SHARE RANK 1 ON PURPOSE. They are the
 * same degree of restriction — the market's core activity is halted, capital can
 * still come and go — stated in two categories' vocabularies, and they cannot
 * compete: `mostRestrictive` reduces the readings of ONE market, whose `blocked`
 * is drawn from one category's operation set. Ordering them against each other
 * would assert a comparison that never happens and that nothing justifies.
 */
const LEVEL_RANK: Record<OperationalLevel, number> = {
  [OperationalLevel.Active]: 0,
  [OperationalLevel.BorrowingDisabled]: 1,
  [OperationalLevel.SwapDisabled]: 1,
  [OperationalLevel.EntryDisabled]: 2,
  [OperationalLevel.ExitDisabled]: 3,
  [OperationalLevel.NotOperational]: 4,
};

/** What an adapter reads; everything else on `OperationalState` is derived from it. */
export interface OperationalReading<C extends ProtocolCategory = ProtocolCategory> {
  /**
   * Every operation the protocol's own gating logic currently refuses. Order and
   * duplicates don't matter — the output is deduplicated and canonically ordered.
   *
   * Drawn from the vocabulary of the category `C` — see `CATEGORY_OPERATIONS`.
   */
  blocked: readonly OperationFor<C>[];
  /**
   * True only where the protocol publishes an explicit "not opened yet" state
   * (Blend's `status == 6`). Never inferred from emptiness, a zero balance, or
   * anything else: a market with nothing in it is an empty market, not an
   * unopened one, and the market-size floor already covers that case.
   */
  neverOpened: boolean;
  /** see OperationalState.source — the protocol's own reading, verbatim */
  source: string;
  origin: OperationalOrigin;
  detail: string;
  /** the fetch time the reading was taken at */
  asOf: Date;
}

/**
 * Canonical publication order for LENDING's `blocked`, so two lending adapters
 * reporting the same restriction produce byte-identical output. Deliberately the
 * order a user meets them in — get in, get out, then the borrow-side operations —
 * rather than alphabetical, which would put `borrow` before `supply` for no
 * reason.
 *
 * Per category, like the vocabulary it orders: a second category registers its
 * own ordering beside this one, because "the order a user meets them in" is a
 * statement about that category's operations.
 */
const ORDERED_LENDING_OPERATIONS: readonly PoolOperation[] = [
  PoolOperation.Supply,
  PoolOperation.Withdraw,
  PoolOperation.Borrow,
  PoolOperation.Repay,
  PoolOperation.Liquidate,
];

/**
 * LENDING's classification rule, applied identically to every lending protocol.
 *
 * SCOPED TO ONE CATEGORY because the ladder names lending's operations —
 * withdraw, supply, borrow. The `OperationalLevel` it produces is shared, but
 * the mapping from blocked operations onto that ladder is a statement about a
 * particular category's vocabulary, so it takes and returns
 * `<'lending'>`-parameterized types. A second category adds its own function
 * beside this one; it does not widen this one's signature and reinterpret these
 * rungs.
 *
 * The ladder is checked from the most restrictive down, so a state that blocks
 * several things is named by the worst of them:
 *
 *   withdraw blocked  -> ExitDisabled      (funds cannot leave)
 *   supply blocked    -> EntryDisabled     (no new exposure, exit still open)
 *   borrow blocked    -> BorrowingDisabled
 *   nothing blocked   -> Active
 *
 * `neverOpened` supersedes all of it, because "this market was never opened" is
 * a different statement from "this market restricts X" and would otherwise be
 * flattened into `EntryDisabled` on Blend.
 *
 * Repay and Liquidate deliberately do not appear on the ladder even though they
 * are reportable in `blocked`. Neither has a rung of its own: on both protocols
 * every state that blocks them also blocks withdrawals, so a rung would be
 * unreachable — and inventing an unreachable rung would suggest a distinction
 * the chain does not draw. They stay in `blocked` because they are true and a
 * reader weighing a halted market should see that liquidations have stopped too.
 */
export function toOperationalState(
  reading: OperationalReading<'lending'>,
): OperationalState<'lending'> {
  const blocked = ORDERED_LENDING_OPERATIONS.filter((op) => reading.blocked.includes(op));
  const level = reading.neverOpened
    ? OperationalLevel.NotOperational
    : blocked.includes(PoolOperation.Withdraw)
      ? OperationalLevel.ExitDisabled
      : blocked.includes(PoolOperation.Supply)
        ? OperationalLevel.EntryDisabled
        : blocked.includes(PoolOperation.Borrow)
          ? OperationalLevel.BorrowingDisabled
          : OperationalLevel.Active;

  return {
    level,
    source: reading.source,
    blocked,
    origin: reading.origin,
    detail: reading.detail,
    asOf: reading.asOf.toISOString(),
  };
}

/**
 * Canonical publication order for DEX's `blocked`, so two dex adapters reporting
 * the same restriction produce byte-identical output.
 *
 * The order a user meets them in, like lending's: trade first because that is
 * what a pool is for and what most readers came to check, then the LP lifecycle
 * in and out, then rewards. Not alphabetical, which would open on `claim` — the
 * one operation here that touches no principal.
 */
const ORDERED_DEX_OPERATIONS: readonly DexOperation[] = [
  DexOperation.Swap,
  DexOperation.Deposit,
  DexOperation.Withdraw,
  DexOperation.Claim,
];

/**
 * DEX's classification rule, applied identically to every AMM protocol.
 *
 * SCOPED TO ONE CATEGORY, exactly as `toOperationalState` is, and a sibling of
 * it rather than a widening of it: the ladder below names dex's operations, so
 * it takes and returns `<'dex'>`-parameterized types. The `OperationalLevel` it
 * produces is the shared one — that is the half that stayed shared.
 *
 * Checked from the most restrictive down, so a state blocking several things is
 * named by the worst of them:
 *
 *   withdraw blocked  -> ExitDisabled      (funds cannot leave)
 *   deposit blocked   -> EntryDisabled     (no new exposure, exit still open)
 *   swap blocked      -> SwapDisabled      (market halted, LPs unaffected)
 *   nothing blocked   -> Active
 *
 * `ExitDisabled` IS UNREACHABLE FROM AQUARIUS TODAY, AND THE RUNG STAYS ANYWAY.
 * There is no `kill_withdraw` in any of the three pool wasms — `kill_swap`,
 * `kill_deposit`, `kill_claim` and `kill_gauges_claim` are the complete set — so
 * no Aquarius role can block a withdrawal and nothing can currently produce this
 * level. The rung is not speculative: it is the top of the ladder every category
 * is measured against, and removing it here would mean a second dex protocol
 * that *can* freeze withdrawals had nowhere to say so. Aquarius's inability to
 * reach it is a fact about Aquarius, published as a Finding, not a shape the
 * shared type should take.
 *
 * `neverOpened` supersedes all of it, as it does for lending. Aquarius has no
 * unopened state to report it from — a pool exists once it is created and paid
 * for — so a dex reading sets it false; a pool holding nothing is an empty pool,
 * not an unopened one, and the size floor is what covers that (open question A).
 *
 * `Claim` deliberately does not appear on the ladder even though it is
 * reportable in `blocked`. An LP whose reward claim is killed can still withdraw
 * every unit of principal, so it restricts no path this ladder ranks — and
 * inventing a rung for it would suggest the chain draws a distinction it does
 * not. It stays in `blocked` because it is true and a reader weighing a pool
 * should see it. Same reasoning lending gives for Repay and Liquidate.
 */
export function toDexOperationalState(reading: OperationalReading<'dex'>): OperationalState<'dex'> {
  const blocked = ORDERED_DEX_OPERATIONS.filter((op) => reading.blocked.includes(op));
  const level = reading.neverOpened
    ? OperationalLevel.NotOperational
    : blocked.includes(DexOperation.Withdraw)
      ? OperationalLevel.ExitDisabled
      : blocked.includes(DexOperation.Deposit)
        ? OperationalLevel.EntryDisabled
        : blocked.includes(DexOperation.Swap)
          ? OperationalLevel.SwapDisabled
          : OperationalLevel.Active;

  return {
    level,
    source: reading.source,
    blocked,
    origin: reading.origin,
    detail: reading.detail,
    asOf: reading.asOf.toISOString(),
  };
}

/**
 * Reduce several readings to the one the market publishes: the most restricted.
 *
 * K2 gates per reserve as well as globally, so a market can be open in USDC and
 * halted in PYUSD. Publishing the *least* restricted reading would say a market
 * is fine while one of its assets is frozen; averaging is meaningless on a
 * categorical value. Taking the worst is the same convention every factor uses
 * for reserves, and for the same reason — the binding constraint is what a
 * reader needs.
 *
 * Ties keep the FIRST reading, so a caller that puts the market-wide reading
 * ahead of the per-reserve ones gets the market-wide `source` and `detail` when
 * both say the same thing. That is the more informative of two identical
 * classifications: "the router is paused" tells a reader more than "PYUSD is
 * paused" when both are true.
 *
 * Throws on an empty list rather than inventing an Active default — "no readings
 * at all" is not "nothing is restricted", and an adapter that produced none has
 * a bug that must not be published as a clean bill of health.
 */
export function mostRestrictive<C extends ProtocolCategory = ProtocolCategory>(
  states: readonly OperationalState<C>[],
): OperationalState<C> {
  if (states.length === 0) {
    throw new Error('mostRestrictive: no operational readings — cannot infer a state');
  }
  let worst = states[0];
  for (const state of states.slice(1)) {
    if (LEVEL_RANK[state.level] > LEVEL_RANK[worst.level]) worst = state;
  }
  return worst;
}
