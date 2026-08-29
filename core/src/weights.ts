/**
 * Each category's factor declarations: which factors its rulebook scores, what
 * each one is weighted, and what to call it.
 *
 * WHY THIS EXISTS. A weight is a piece of the shared rulebook — METHODOLOGY.md
 * ground rule 1 — and until now the ten numbers that make up lending's weighting
 * were written out ten times, as `const weight = 0.25` literals inside the two
 * adapters' factor methods. Nothing but review stopped one of them drifting, and
 * a drift would not have been loud: both adapters would still have produced a
 * plausible score, from two different weightings, and only the totals would have
 * disagreed. That is precisely the failure `scoreFactors` was moved into core to
 * prevent, applied to the numbers the mean is taken over rather than to the mean
 * itself.
 *
 * WHY IT IS PER CATEGORY. A weight is only meaningful against a factor set, and
 * the factor set is what a category *is* — `utilizationSafety` weighted 0.20
 * means nothing to an AMM that has no borrow cap. So this is keyed the same way
 * `CATEGORY_OPERATIONS` and `METHODOLOGY_VERSIONS` are, and for the same reason:
 * a `Record<ProtocolCategory, …>` that has gained a key is a compile error at
 * every place a new category must be registered.
 *
 * TWO ENTRIES, AND ONLY ONE OF THEM IS WEIGHTED. `lending` is published in full;
 * `dex` (#100) declares its two factors and their labels with **no weights at
 * all**, because weights are a type-(b) judgment call under TAXONOMY.md Gate 1
 * and belong to their own review (#102) rather than being guessed alongside the
 * factor set. That is not a gap left implicit — see `CategoryFactors`, which
 * makes "weights pending" a distinct type rather than a missing field.
 *
 * WHY A LEAF WITH ONE TYPE-ONLY IMPORT. `weights.test.ts` and
 * `scoring.test.ts` both VALUE-import this module under `node --test`, whose
 * type-stripping loader resolves an import graph literally. The
 * `import type` below is erased before Node sees the file, so at runtime this
 * module imports nothing at all — the same shape `category.ts` and
 * `operational-state.ts` keep, and for the same reason. Don't add a value
 * import here.
 *
 * WHAT THIS IS NOT. It is not the dashboard's label table. `FACTOR_ORDER` in
 * `dashboard/app/lib/contract.ts` holds short *column headers* for a narrow
 * table, on the dashboard's own hand-maintained mirror of the API contract —
 * that mirror redeclares `RiskFactorMap` too, deliberately, so it does not
 * import core. The labels here are the canonical human names for the factors,
 * matching how METHODOLOGY.md titles each one.
 */

import type { ProtocolCategory } from './category';

/**
 * One factor's entry in a category's rulebook.
 *
 * `weight` is this factor's share of the overall score. A category's weights sum
 * to 1.00 — asserted in `weights.test.ts`, because the renormalization in
 * `scoreFactors` divides by the *observed* total and so would happily produce a
 * confident-looking number from a set that summed to 0.9.
 */
export interface FactorDeclaration {
  /** share of the overall score; a category's weights sum to 1.00 */
  readonly weight: number;
  /** canonical human name, e.g. "Oracle trustworthiness" */
  readonly label: string;
}

/**
 * A factor that has been admitted to a category's taxonomy but not yet weighted.
 *
 * It has NO `weight` property — not an optional one, not a zero, not a
 * placeholder. That is the entire point: `weight?: number` would make
 * `LENDING_FACTORS.oracleSafety.weight` read `number | undefined` at every
 * adapter call site to buy a state only one category is in, and an adapter that
 * read `undefined` into a `RiskFactor.weight` would produce `NaN * value` inside
 * `scoreFactors` and publish a score of 0 with no error anywhere. Omitting the
 * property makes that read a compile error instead.
 */
export interface UnweightedFactorDeclaration {
  /** canonical human name, e.g. "Executable depth" */
  readonly label: string;
}

/**
 * A category's factor set: which factors its rulebook names, and — when the
 * weight table has been reviewed — what each is weighted.
 *
 * A DISCRIMINATED UNION, BECAUSE "DECLARED" AND "SCORABLE" ARE DIFFERENT STATES.
 * TAXONOMY.md admits a category in two steps on purpose: the factor set with
 * every anchor named is reviewable on its own (Gate 0, 2, 3, 8), while the
 * weights are a type-(b) judgment call that Gate 1 requires be argued and
 * labelled as one. Guessing weights to fill the shape would smuggle unanchored
 * numbers past the gate the two-step review exists to satisfy, and a zero or a
 * `0.33` placeholder would be indistinguishable from a reviewed value the moment
 * anyone read it.
 *
 * So the intermediate state is typed rather than commented. `status` is the
 * discriminant; narrowing on it is what gives a caller access to `weight` at
 * all. `scoreFactors` is unaffected — it reads weights off the `RiskFactor`s an
 * adapter builds, never off this table — and remains unable to compute a `dex`
 * score for the plain reason that no adapter can construct a weighted `dex`
 * factor without a weight to put in it.
 *
 * `pendingWeights` is a state to LEAVE, not to live in. #102 turns `dex` into a
 * `published` entry with a weight table, and nothing should be built on the
 * assumption that a category can stay here.
 */
export type CategoryFactors =
  | {
      /** display name of the category — also its `methodology/<category>.md` section heading */
      readonly label: string;
      /** the weight table is reviewed and published; scores may be computed */
      readonly status: 'published';
      readonly factors: Readonly<Record<string, FactorDeclaration>>;
    }
  | {
      readonly label: string;
      /** the factor set is admitted; its weight table is not yet reviewed */
      readonly status: 'pendingWeights';
      readonly factors: Readonly<Record<string, UnweightedFactorDeclaration>>;
    };

/**
 * Lending's five factors and their weights, in `RiskFactorType` order.
 *
 * These are METHODOLOGY.md's "Factor weights" table, and the two are pinned
 * against each other by `scoring.test.ts` — which parses the table out of the
 * document rather than restating it, so a drift in *either* direction fails.
 * Both adapters then pin themselves against this map, so the chain runs
 * adapter → here → the published rulebook with no hand-written copy in it.
 *
 * The weights themselves are an unvalidated judgment call and METHODOLOGY.md
 * says so; this module is where they live, not an argument that they are right.
 */
export const CATEGORY_FACTORS = {
  lending: {
    label: 'Lending',
    status: 'published',
    factors: {
      collateralSafety: { weight: 0.2, label: 'Collateral concentration' },
      oracleSafety: { weight: 0.25, label: 'Oracle trustworthiness' },
      adminKeySafety: { weight: 0.2, label: 'Admin key control' },
      liquiditySafety: { weight: 0.15, label: 'Free-liquidity depth' },
      utilizationSafety: { weight: 0.2, label: 'Utilization headroom' },
    },
  },

  /**
   * The DEX rulebook's two factors, admitted by #100 and published in
   * `methodology/dex.md`. **Weights deliberately absent — see #102.**
   *
   * TWO, NOT FIVE. `utilizationSafety`, `liquiditySafety` and `oracleSafety`
   * have no referent at all in a spot AMM: there is no borrow ledger and no cap,
   * `(supplied − borrowed) / supplied` is identically 1 for every pool, and
   * Aquarius reads no oracle — price comes from reserves or from tick state.
   * Reusing them would publish a number computed from nothing. `dex.md` records
   * that argument in full, and TAXONOMY.md Gate 0 is what required it.
   *
   * TWO, NOT THREE — `depthSafety` IS DEFERRED, NOT REJECTED. The rulebook
   * proposed it as the third factor and it is absent here because open question
   * A resolved to option 4: Aquarius has no on-chain unit of value to denominate
   * a trade size in, and every way of inventing one either fabricates a price
   * from mutable pool state or leaves 192 of 340 pools unscorable on the
   * category's flagship factor. It is not declared, because a declared factor
   * with no formula is a promise the rulebook does not keep.
   *
   * The decision was made on REVERSIBILITY. Adding a factor to a live category
   * later is additive and lands as a labelled version bump; walking back a
   * published depth denomination would mean revising stored scores, which this
   * project's own no-backfill rule forbids outright. Full argument, and why
   * options 1+3 and 2 were both declined, in `methodology/dex.md`.
   *
   * `adminKeySafety` IS THE SAME KEY LENDING USES, DELIBERATELY. It is not a
   * rephrasing of a lending factor — the question "who can change the rules"
   * really is the same question, and it is computed from entirely different data
   * on each side (Aquarius's seven named roles plus a two-step upgrade deadline;
   * a lending pool's single admin's signer set). Two categories using one name
   * for one question is what stops the taxonomy fragmenting into synonyms, so
   * the key is shared and the computation is not. Open question B on #100,
   * resolved this way and recorded in `dex.md` so it is not re-litigated. Note
   * that a shared KEY is not a comparability claim: the values are not
   * comparable across categories, for the same reason the overall scores are
   * not.
   */
  dex: {
    label: 'Dex',
    status: 'pendingWeights',
    factors: {
      adminKeySafety: { label: 'Admin key control' },
      assetControlSafety: { label: 'Issuer asset control' },
    },
  },
} as const satisfies Record<ProtocolCategory, CategoryFactors>;

/**
 * Lending's declarations, unwrapped — what the Blend and Kinetic adapters read.
 *
 * A convenience, not a second source: it is the same object
 * `CATEGORY_FACTORS.lending.factors` names. An adapter reads
 * `LENDING_FACTORS.oracleSafety.weight` where it used to write `0.25`.
 *
 * THERE IS DELIBERATELY NO `DEX_FACTORS` SIBLING. This alias exists for the
 * adapters that read it, and `dex` has none — nor can it have one before #102
 * supplies the weights an adapter would be reading. Adding the alias now would
 * publish a name whose only use is to be dereferenced for a `weight` that is not
 * there. It arrives with the weight table, in the same change as the adapter
 * that needs it.
 */
export const LENDING_FACTORS = CATEGORY_FACTORS.lending.factors;
