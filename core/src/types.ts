export type Chain = 'stellar';

/**
 * The category registry — which rulebooks exist, and each one's version — lives
 * in its own leaf module so a `node --test` file can VALUE-import it. It cannot
 * live in this file: `RiskFactorType` below is an `enum`, which Node's
 * type-stripping loader refuses to load at all. See ./category.ts.
 */
import type { ProtocolCategory } from './category';

export type { ProtocolCategory };

/**
 * Off-chain places a reader can go to check a protocol for themselves.
 *
 * These are the protocol's OWN properties, listed because a score is only
 * useful next to the thing it scores — not because Stenion vouches for any of
 * them. Every consumer that renders these must carry the same disclaimer that
 * covers logos: presence here is not endorsement, partnership, or any
 * relationship. The dashboard renders them `rel="noopener noreferrer nofollow"`.
 *
 * Both members are optional because they are genuinely optional facts: a
 * protocol may publish no documentation site at all. Omit what doesn't exist
 * rather than pointing at a placeholder — a dead link is worse than no link.
 */
export interface ProtocolLinks {
  /** the protocol's own front page, e.g. "https://www.blend.capital" */
  site?: string;
  /** published user/developer documentation, if any */
  docs?: string;
}

/**
 * Set when an entry is a market running on ANOTHER protocol's contracts rather
 * than on its own — e.g. the YieldBlox pool, which is a community-managed pool
 * deployed on Blend V2 and running Blend's pool contract byte-for-byte.
 *
 * This exists because such an entry is otherwise indistinguishable from an
 * independent protocol, and presenting it as one would misrepresent the
 * ecosystem: a reader scanning the registry would count several protocols where
 * the chain has one codebase and several markets. Every consumer that renders a
 * protocol's identity MUST render this alongside it when present — that is the
 * whole reason the field is in the metadata rather than in a frontend lookup.
 *
 * It is deliberately NOT a link between registry entries. `host` is a display
 * name, not an id: Stenion's `blend` entry is itself one pool, so pointing at it
 * would claim "this runs on that entry", which is not what is true. What is true
 * is that both run the host protocol's contract, and that is what this says.
 *
 * Absent (undefined) is the normal case and means exactly "this protocol runs on
 * its own contracts" — never "we didn't check".
 */
export interface ProtocolDeployment {
  /** the host protocol's display name, e.g. "Blend" */
  host: string;
  /**
   * Short label naming the exact deployment, scannable in a registry row and
   * complete enough to stand alone, e.g. "Blend V2 pool". Written to be read at
   * a glance next to the protocol's name — not a sentence.
   */
  label: string;
}

export interface ProtocolMetadata<C extends ProtocolCategory = ProtocolCategory> {
  /** unique slug used as the primary key across storage and the API, e.g. "blend" */
  id: string;
  name: string;
  chain: Chain;
  /**
   * Which rulebook scores this protocol — see `ProtocolCategory`.
   *
   * REQUIRED, not optional, and deliberately so. The precedent is
   * `ADAPTER_INTERFACE_VERSION` 2's `operationalState`: an optional member is
   * one every future adapter can quietly skip, which is exactly the retrofit
   * debt that constant exists to make visible. A protocol with no category is
   * not a protocol we know how to score, so there is no honest default to fall
   * back to — and defaulting to `'lending'` would silently mis-file the first
   * adapter of every category that follows.
   *
   * Sits here with id/name/chain because it is the same kind of value: a fixed
   * string literal the adapter declares about itself, written to `protocols`
   * every cycle by `upsertProtocol` like the rest of its identity.
   *
   * IT IS ALSO A COMPARABILITY CLAIM, which is what makes it more than a label.
   * Two protocols' `safetyScore`s mean the same thing only when this field
   * agrees; scores across categories are computed from different factors under
   * different weights and are not comparable at all. Every consumer that ranks
   * protocols must scope the ranking to one category, and API.md says
   * so in the terms clients read.
   *
   * The generic parameter lets an adapter pin itself to one category
   * (`ProtocolMetadata<'lending'>`) so its `operationalState` vocabulary is
   * checked against the same category its metadata declares. Defaulted, so
   * every existing bare `ProtocolMetadata` keeps meaning "some category".
   */
  category: C;
  /**
   * Root-relative path to the protocol's logo as stored in the dashboard's
   * `public/` tree, e.g. "/assets/protocols/blend.svg".
   *
   * A PATH WE HOST, never a URL on the protocol's own CDN. Hotlinking breaks
   * whenever they reorganise their assets, and the resulting 404 shifts layout
   * on a page whose whole job is to be scannable. See CONTRIBUTING.md for the
   * asset spec (format, size, where the file goes).
   *
   * Omit when the protocol publishes no usable mark. That is a supported state,
   * not a gap: the dashboard renders a deliberate initials tile instead. Never
   * invent or redraw a mark to fill this in.
   */
  logo?: string;
  /**
   * The single on-chain contract this protocol's score is actually derived from
   * — Blend's pool, Kinetic's router. Published so a reader can open it in an
   * explorer and check the inputs behind a number rather than taking it on
   * faith; that verifiability is the whole pitch.
   *
   * MUST be the contract this adapter INSTANCE was configured with, not the
   * module default. Build it in the constructor from the resolved id (see
   * BlendAdapter) so an adapter pointed at a different pool cannot publish a
   * link to the pool it did not score.
   *
   * Stenion picks the explorer, not the adapter — this is the raw C-address,
   * and the dashboard builds the URL. That keeps the choice of explorer one
   * decision in one place instead of a string every adapter has to repeat.
   */
  contractId?: string;
  /** the protocol's own site/docs — see ProtocolLinks for the endorsement caveat */
  links?: ProtocolLinks;
  /**
   * Present only when this entry is a market on another protocol's contracts —
   * see ProtocolDeployment. Optional because independence is the normal case.
   */
  deployedOn?: ProtocolDeployment;
  /**
   * Which adapter produced this protocol's scores, e.g. "BlendAdapter".
   * Persisted to `protocols.adapter` and published on GET /api/v1/protocol/:id
   * as the provenance label a reader uses to find the adapter in the repo.
   *
   * MUST be a string literal. Never `this.constructor.name` or anything else
   * derived from a runtime identifier: the workspace packages are bundled and
   * minified into the dashboard's serverless functions, which renames the
   * classes. Deriving it is how every row in `protocols` came to read `w`
   * instead of `BlendAdapter`/`KineticAdapter` — correct in every test and in
   * local dev, wrong in the only environment that actually writes the data.
   * It sits here with id/name/chain because it is the same kind of value:
   * a fixed string the build cannot rewrite.
   */
  adapterRef: string;
}

/**
 * Closed set of risk dimensions every adapter reports against. This shared
 * taxonomy is what makes protocols comparable on the leaderboard/API —
 * adding a dimension here is a breaking change felt by every adapter, so
 * extend deliberately.
 *
 * Naming/polarity: every member is a `*Safety` dimension scored on the same
 * scale as the overall score — 0-100, higher = safer (see RiskFactor.value).
 * The name direction deliberately matches the value direction so a factor's
 * name never disagrees with its number (a `collateralSafety` of 70 means
 * well-diversified/safe, not 70%-concentrated). Do not add a member whose
 * name implies "higher = riskier".
 */
export enum RiskFactorType {
  CollateralSafety = 'collateralSafety',
  OracleSafety = 'oracleSafety',
  AdminKeySafety = 'adminKeySafety',
  LiquiditySafety = 'liquiditySafety',
  UtilizationSafety = 'utilizationSafety',
}

/**
 * A named sub-signal inside a factor.
 *
 * Two distinct uses, deliberately both allowed:
 *
 * - **Scored component** (`value` set): a sub-score that feeds its parent
 *   factor's `value`. The dashboard can show the breakdown so a composite
 *   factor isn't an opaque single number.
 * - **Disclosure** (`value` null): a real, readable on-chain quantity we
 *   publish but deliberately do *not* score, because scoring it would invent
 *   comparability the underlying data doesn't support. `detail` carries the raw
 *   figure. See METHODOLOGY.md §2d on why deviation-bound *tightness* is
 *   disclosed rather than graded.
 *
 * A null `value` is therefore never "missing data" — it means "measured, shown,
 * and intentionally not graded."
 */
export interface RiskFactorComponent {
  /** stable machine-readable key, e.g. "priceFreshness", "deviationBound" */
  id: string;
  /** short human label for display, e.g. "Price freshness" */
  label: string;
  /** 0-100, higher = safer — or null for a disclosure-only component (see above) */
  value: number | null;
  /** what this component measured, including the raw on-chain figure it came from */
  detail: string;
}

export interface RiskFactor {
  /** 0-100, higher = safer, same convention as the overall score */
  value: number;
  /** this factor's share of the overall score; weights of all non-null factors must sum to 1 */
  weight: number;
  /** short, human-readable explanation of what drove this value, e.g. "top 3 depositors hold 78% of collateral" */
  detail: string;
  /**
   * Optional breakdown of the sub-signals behind `value`. Additive and
   * optional: a factor computed from a single signal omits it, and consumers
   * that don't know about it are unaffected. Where present, the scored
   * components (those with a non-null `value`) are what `value` was derived
   * from — this is a view into the calculation, not extra commentary.
   */
  components?: RiskFactorComponent[];
}

/**
 * Every RiskFactorType key must be present. Use null for a factor that
 * genuinely doesn't apply to a given protocol (e.g. no oracle dependency)
 * rather than omitting the key, so the dashboard can render "N/A" instead
 * of silently dropping a column.
 */
export type RiskFactorMap = Record<RiskFactorType, RiskFactor | null>;

/**
 * Any category's factor map: factor keys to factors, with `null` for one that
 * genuinely doesn't apply.
 *
 * `RiskFactorMap` above is **lending's** map — its keys are exactly the five
 * `RiskFactorType` members. This is the shape all of them share, and it exists
 * for one reason: `scoreFactors` is the weighted mean, and a weighted mean does
 * not care which factors it is averaging. Typing that function against lending's
 * key set made the arithmetic look category-specific when it never was, and the
 * only way for a second category to reuse it would have been to copy it — which
 * is the drift `core/src/scoring.ts` exists to prevent.
 *
 * WHAT THIS IS NOT. It is not an invitation to invent factor keys per adapter.
 * Which keys a category scores is declared once in `CATEGORY_FACTORS`
 * (`core/src/weights.ts`) and fixed there; this type is only what the shared
 * arithmetic accepts, not a licence to widen a taxonomy.
 */
export type FactorMap = Record<string, RiskFactor | null>;

/**
 * The output of the shared weighted mean, parameterized by the factor map it
 * was computed from so the map comes back out at the type it went in as.
 *
 * Defaulted to `RiskFactorMap`, which is why `RiskScoreResult` below is exactly
 * the type it always was — every lending call site keeps its precise
 * five-key `factors`, and nothing downstream had to widen.
 */
export interface ScoreResult<M extends FactorMap = RiskFactorMap> {
  /** 0-100, higher = safer */
  score: number;
  factors: M;
  computedAt: Date;
}

/** A lending score result. Unchanged in shape — see `ScoreResult`. */
export type RiskScoreResult = ScoreResult<RiskFactorMap>;
