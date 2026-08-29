import type { OperationalState } from './operational-state';
import { ProtocolCategory, ProtocolMetadata, ScoreResult } from './types';
import type { FactorMapFor } from './weights';

/**
 * Version of the Adapter contract itself (not of any protocol). Bumped only
 * when the shape of the interface below changes in a way adapters must react
 * to — a required method, a changed signature, a new error model.
 *
 * 1 — fetchRawData / computeRiskFactors / score.
 * 2 — adds the required `operationalState(raw)` method (issue #15). Required,
 *     not optional, deliberately: an optional method is one every future adapter
 *     can quietly skip, which is precisely the retrofit debt that decision was
 *     made to stop accumulating. This constant exists so that forcing every
 *     implementor to update is a labelled event rather than a silent break, and
 *     this is the first time it has been used for one.
 * 3 — adds the required `metadata.category` field and a `TCategory` parameter
 *     that scopes `operationalState`'s vocabulary to it (issue #76). Required
 *     for the same reason `operationalState` was: a protocol with no category is
 *     not a protocol we know how to score, and an optional field would default
 *     the first adapter of every future category into lending's rulebook. Every
 *     implementor must name its category; nothing infers one.
 *
 * 4 — the factor map is DERIVED from `TCategory` rather than named by the
 *     adapter (issue #104). #103 had added a third parameter, `TFactors`,
 *     defaulted to `RiskFactorMap`, to make the first `dex` adapter compile —
 *     and recorded itself as unreviewed. This is that review, and it revised
 *     rather than affirmed: nothing tied `TFactors` to `TCategory`, so
 *     `Adapter<Raw, 'dex', RiskFactorMap>` compiled (a dex adapter scored on
 *     lending's five) and so did a map of invented keys. Both were checked, not
 *     supposed. `computeRiskFactors`/`score` now speak `FactorMapFor<TCategory>`
 *     — the key set `CATEGORY_FACTORS` declares for that category — so an
 *     adapter cannot publish factors its own rulebook does not name.
 *
 *     BUMPED, where #103's addition deliberately was not, because the bar is
 *     "a change adapters must react to" and this is one: an adapter that spelled
 *     three parameters must drop the third. A defaulted parameter nobody had to
 *     name was not; a removed one that someone did name is.
 */
export const ADAPTER_INTERFACE_VERSION = 4 as const;

/**
 * The contract every protocol adapter implements.
 *
 * Lifecycle, driven by the indexer on an interval:
 *   1. fetchRawData()       — pull raw on-chain state via Soroban RPC
 *   2. computeRiskFactors() — reduce raw state into the shared factor taxonomy
 *   3. score()               — reduce factors into a single comparable number
 *   4. operationalState()   — classify the market's live restrictions, unscored
 *
 * These are separate methods rather than one run() call so the
 * indexer can persist/inspect intermediate output, and so scoring logic
 * can be unit-tested against fixed factor inputs without touching RPC.
 *
 * Errors: adapters throw on failure (RPC unreachable, malformed response,
 * missing contract data, etc). The indexer is responsible for catching
 * per-adapter failures and recording a failed/stale run rather than
 * crashing the whole cycle — adapters themselves should not swallow errors.
 *
 * TRawData is intentionally adapter-specific: Blend's raw shape has
 * nothing in common with, say, YieldBlox's.
 *
 * TCategory is the rulebook this adapter is scored under. It is threaded through
 * `metadata` and `operationalState` so those two cannot disagree: an adapter
 * declaring `category: 'lending'` is checked against lending's operation
 * vocabulary, not against the union of every category's. Defaulted to the whole
 * union so a heterogeneous list (`Adapter<unknown>[]`, the indexer's run loop)
 * still types, exactly as it did before this parameter existed.
 *
 * THE FACTOR MAP IS DERIVED FROM `TCategory`, NOT A THIRD PARAMETER. Which
 * factors a category scores is declared once, in `CATEGORY_FACTORS`
 * (`./weights.ts`), and `FactorMapFor<TCategory>` is that declaration read as a
 * type. So an adapter cannot name its own key set: declaring `'dex'` and
 * returning lending's five is a compile error, and so is inventing a key no
 * rulebook has.
 *
 * That is the #104 revision of #103's `TFactors` parameter, and the reason for
 * it is that the parameter did not connect to anything. `RiskFactorMap` is
 * **lending's** map — `Record<RiskFactorType, …>`, its five keys fixed — and
 * `dex` scores `adminKeySafety` and `assetControlSafety`, so the first
 * non-lending adapter could not implement this interface at all; #103 opened it
 * up with a defaulted parameter to get that adapter compiling and flagged the
 * decision as unreviewed. The review found what the parameter allowed:
 * `Adapter<Raw, 'dex', RiskFactorMap>` and `Adapter<Raw, 'dex', { madeUpSafety }>`
 * both compiled, because nothing related the two parameters. Deriving relates
 * them.
 *
 * `FactorMapFor` DISTRIBUTES over the category union, which is what keeps the
 * default working: `TCategory` defaults to all of `ProtocolCategory` so that a
 * heterogeneous `Adapter<unknown>[]` still types, and the map then resolves to
 * the union of every category's — "some category's factors" — rather than to
 * their intersection, which is the latent bug `OperationFor` in
 * `operational-state.ts` records being fixed. Checked rather than assumed; see
 * that type's note in `./weights.ts`.
 */
export interface Adapter<
  TRawData = unknown,
  TCategory extends ProtocolCategory = ProtocolCategory,
> {
  readonly metadata: ProtocolMetadata<TCategory>;

  fetchRawData(): Promise<TRawData>;

  computeRiskFactors(rawData: TRawData): Promise<FactorMapFor<TCategory>>;

  score(factors: FactorMapFor<TCategory>): ScoreResult<FactorMapFor<TCategory>>;

  /**
   * The market's live operational state — which user operations its own gating
   * logic currently refuses. Published beside the score and **never scored**;
   * see `operational-state.ts` and METHODOLOGY.md for why.
   *
   * Takes the same raw data `computeRiskFactors` does, so no extra RPC round
   * trip is spent on it and the state published alongside a score is the state
   * that was true when that score's inputs were read. Synchronous for the same
   * reason: everything it needs is already in `rawData`, and an implementation
   * that has to await something is reaching for the chain a second time.
   *
   * Classify with `toOperationalState` (and `mostRestrictive` where a protocol
   * gates per reserve) rather than constructing the object by hand — that
   * function is the shared rule, and hand-rolling it is how two adapters come to
   * disagree about what "frozen" means.
   *
   * The operations this may report are `TCategory`'s, not a global set — see
   * `CATEGORY_OPERATIONS`. `OperationalLevel` is shared across categories and is
   * the same ladder for all of them.
   */
  operationalState(rawData: TRawData): OperationalState<TCategory>;
}
