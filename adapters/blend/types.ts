// Mainnet wiring, the raw on-chain shape, and the adapter's options — the
// leaf of this adapter's module graph. Everything here is either a type or a
// constant; nothing reads the chain and nothing scores.

import { Networks } from '@stellar/stellar-sdk';
import type { ProtocolDeployment, ProtocolLinks } from '@stenion/core';

// ---------------------------------------------------------------------------
// Mainnet wiring
//
// Addresses come from Blend's own deploy config (blend-utils/mainnet.contracts.json),
// cross-checked against docs.blend.capital/mainnet-deployments — not a third-party
// indexer.
//
// ONE ENGINE, MANY POOLS. Blend's factory deploys one contract per market, and
// every market runs the SAME pool wasm — verified rather than assumed: the Fixed
// V2 and YieldBlox V2 pools report the identical code hash
// (a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e), and the V2
// pool factory's `is_pool` returns true for both. So the read interface, the
// instance-storage keys and the fixed-point scalars below hold for every pool,
// and a second Blend market needs no new scoring code — only a new BlendPool
// entry. Same rule that moved `scoreFactors` into @stenion/core, applied to pool
// targeting: nothing per-pool is allowed to be logic.
//
// This is multi-pool TARGETING, not aggregation. Each pool is scored and ranked
// as its own registry entry from its own reserves, oracle and admin; pools are
// never summed into a single Blend number. Summing would hide exactly the
// per-market differences the score exists to show — the two live pools sit 30
// points apart on the same contract code.
// ---------------------------------------------------------------------------

export const NETWORK_PASSPHRASE = Networks.PUBLIC;

/** Public, key-less Soroban mainnet RPC (Stellar docs "Providers" list). Overridable for self-hosting. */
export const DEFAULT_RPC_URL = 'https://mainnet.sorobanrpc.com';

/** Public Horizon — needed for admin-account signer/activity data, which Soroban RPC does not expose. */
export const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/**
 * One Blend market this adapter can be pointed at.
 *
 * Everything here is IDENTITY — the slug, the display name, the pool contract,
 * the mark and the links. Deliberately nothing here is a threshold, a weight or
 * a formula: a field on this type that changed how a factor is computed would be
 * a per-pool rulebook, which METHODOLOGY.md ground rule 1 forbids. Adding a pool
 * must stay a data change.
 */
export interface BlendPool {
  /** registry slug — `protocols.id`, the public URL, and the API path segment */
  id: string;
  /** display name */
  name: string;
  /** the pool contract this entry is scored from */
  poolId: string;
  /** self-hosted mark, or omitted when the market publishes none (see ProtocolMetadata.logo) */
  logo?: string;
  links?: ProtocolLinks;
  /**
   * Set on every pool that is not the protocol's own flagship entry, so a reader
   * can tell a community market running Blend's contracts from Blend itself.
   * This is the field that stops a second Blend pool reading as a second
   * protocol — see ProtocolDeployment.
   */
  deployedOn?: ProtocolDeployment;
}

/**
 * Blend V2 "Fixed" pool (XLM:USDC:EURC) — Blend's flagship market and this
 * adapter's default target. Its on-chain pool `Name` is "Fixed"; the entry is
 * called "Blend" because it is the reference deployment of the protocol itself.
 */
export const BLEND_FIXED_V2: BlendPool = {
  id: 'blend',
  name: 'Blend',
  poolId: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  // Self-hosted copy of Blend's own mark, never a hotlink to their CDN.
  logo: '/assets/protocols/blend.svg',
  links: {
    site: 'https://www.blend.capital',
    docs: 'https://docs.blend.capital',
  },
};

/**
 * The YieldBlox pool on Blend V2 — a DAO-managed market, NOT an independent
 * protocol. Its on-chain pool `Name` is "YieldBlox", its admin is a Soroban
 * Governor contract rather than a keypair, and YieldBlox's own site describes it
 * as "a community-run DeFi lending protocol on the Stellar network, built on
 * Blend". It is scored as its own entry because its reserves, oracle aggregator
 * and admin are all its own — and carries `deployedOn` because its contract code
 * is not. Their own wording says the same thing this entry's label does, which is
 * the best evidence available that the label is not our interpretation.
 *
 * `logo` is a self-hosted copy of their own mark, taken from the 512x512
 * `icon-512.png` their web manifest publishes — never a hotlink. PNG rather than
 * SVG because they ship no vector mark: the site is a SvelteKit build whose only
 * inline SVGs are 24x24 `currentColor` UI glyphs, and its icon set is raster
 * throughout. That is the documented fallback (CONTRIBUTING.md, "The logo
 * asset"), same as Kinetic's.
 *
 * It clears the dark-tile check: the mark is a green glyph (#38af4a) on a fully
 * transparent field — sampled corners are alpha 0 and its opaque pixels average
 * luminance 147 — so nothing vanishes into the tile's #0a0816. Borrowing Blend's
 * mark, had none been available, would have been the worst option on the list:
 * it would assert precisely the identity this entry exists to deny.
 *
 * No `docs`: yieldblox.xyz publishes no documentation link, and a dead link is
 * worse than an absent one.
 */
export const BLEND_YIELDBLOX_V2: BlendPool = {
  id: 'yieldblox',
  name: 'YieldBlox',
  poolId: 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS',
  logo: '/assets/protocols/yieldblox.png',
  links: {
    // Their canonical URL (rel=canonical resolves to the www host), not the
    // yieldblox.finance placeholder this entry originally shipped with.
    site: 'https://www.yieldblox.xyz',
  },
  deployedOn: {
    host: 'Blend',
    label: 'Blend V2 pool',
  },
};

/**
 * The Etherfuse pool on Blend V2 — a market run by Etherfuse, NOT an independent
 * protocol and not Blend's own. Its on-chain pool `Name` is "Etherfuse" and it
 * runs the same pool wasm (`a41fc53d…`) as the two entries above, so it is a
 * config entry and no new scoring code.
 *
 * WHICH DEPLOYMENT THIS IS, because there are three. Blend's V2 factory deployed
 * a pool named "Etherfuse" three times — `CALRF5I2…` (2025-11-21), `CADR6Q2U…`
 * and this one (both 2025-11-24). The other two are abandoned: read on
 * 2026-08-26 both hold **exactly 0 supplied and 0 borrowed across all five
 * reserves** and sit at `PoolConfig.status` 6 (Setup — never opened), while this
 * one held $133,523.47 supplied at status 1 (Active). The choice was made from
 * those balances, not from reward-zone membership — though this is also the only
 * one of the three in Blend's backstop reward zone.
 *
 * WHY THE NAME AND LINK ARE NOT A GUESS. Three of its five reserves are
 * Etherfuse's own tokenized-bond assets — CETES, USTRY and TESOURO, all issued
 * by `GCRYUGD5…` — and that issuer account's Horizon `home_domain` is
 * `etherfuse.com`, whose SEP-1 `stellar.toml` names `ORG_URL =
 * "https://etherfuse.com"` and lists the same issuer under `ACCOUNTS`. So the
 * link is chain-attested rather than a domain that merely matches the pool name.
 * `docs` is their published API documentation, verified by fetching it.
 *
 * NO `logo`, deliberately, and this is the documented designed state rather than
 * a gap (CONTRIBUTING.md, "The logo asset"): Etherfuse publishes only a 708×130
 * WORDMARK (`/logo-white.svg`, `/logo-black.svg`) and no square icon mark — no
 * `icon.svg`, no `apple-touch-icon`, nothing but a 256×256 `.ico`. A 5.4:1
 * wordmark in the 40px square tile renders as an illegible sliver, and cropping
 * or redrawing it to fit is exactly what that section forbids. The initials tile
 * stands.
 */
export const BLEND_ETHERFUSE_V2: BlendPool = {
  id: 'etherfuse',
  name: 'Etherfuse',
  poolId: 'CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI',
  links: {
    site: 'https://etherfuse.com',
    docs: 'https://docs.etherfuse.com',
  },
  deployedOn: {
    host: 'Blend',
    label: 'Blend V2 pool',
  },
};

/**
 * Every Blend market Stenion scores, in registration order.
 *
 * The indexer iterates this rather than naming pools one by one, so adding a
 * market is one entry here and nothing else — there is no second target list to
 * keep in step, which is how such lists come apart.
 */
export const BLEND_POOLS: readonly BlendPool[] = [
  BLEND_FIXED_V2,
  BLEND_YIELDBLOX_V2,
  BLEND_ETHERFUSE_V2,
];

// Fixed-point scalars from blend-contracts-v2/pool/src/constants.rs.
export const SCALAR_7 = 10n ** 7n; // c_factor, l_factor, util, max_util
export const SCALAR_12 = 10n ** 12n; // d_rate, b_rate (ReserveV2 rate decimals)

// ---------------------------------------------------------------------------
// Raw on-chain shape (adapter-specific, per the Adapter<TRawData> contract)
// ---------------------------------------------------------------------------

export interface BlendReserveRaw {
  asset: string;
  /** ReserveConfig, 7-decimal fixed point unless noted */
  config: {
    decimals: number;
    cFactor: bigint;
    lFactor: bigint;
    util: bigint;
    maxUtil: bigint;
    enabled: boolean;
  };
  /** ReserveData */
  data: {
    dRate: bigint; // 12-dec: bTokens/dTokens -> underlying
    bRate: bigint;
    bSupply: bigint; // supply shares
    dSupply: bigint; // debt shares
  };
  /** Oracle reading for this asset, or null if the oracle returned no price. */
  price: {
    value: bigint; // fixed point, `oracleDecimals` places
    timestamp: number; // unix seconds
  } | null;
  /**
   * This asset's entry in the oracle aggregator's own `asset_configs()`, or
   * null if the aggregator has no entry for it (in which case it cannot be
   * priced at all — `price` will also be null).
   */
  priceConfig: {
    /** the upstream asset the aggregator maps this reserve to, e.g. "Other:XLM" */
    upstreamAsset: string;
    /** index into BlendRawData.oracleConfig.oracles */
    oracleIndex: number;
    /**
     * Max single-step price deviation the aggregator will accept for this
     * asset, as a whole percent. 0 (or >= 100) disables the check entirely —
     * see `oracleSafety` and METHODOLOGY.md §2.
     */
    maxDev: number;
  } | null;
}

/** The oracle aggregator's own published configuration (all public reads). */
export interface BlendOracleConfigRaw {
  /** `max_age()` — seconds; a price older than this is refused outright */
  maxAge: number;
  /**
   * Assets the aggregator prices as the unit of account: its `Base` plus any
   * `BaseAssets`. `lastprice` short-circuits these to exactly 1.0 at the current
   * ledger time without consulting any upstream feed (see the contract's
   * `lastprice`), so they have no oracle price to grade — `oracleSafety`
   * excludes them rather than scoring them as unbounded.
   */
  baseAssets: string[];
  /** `oracles()` — the upstream feeds the aggregator reads */
  oracles: {
    index: number;
    address: string;
    /** upstream publish interval in seconds */
    resolution: number;
    decimals: number;
  }[];
}

export interface BlendAdminRaw {
  /** admin address from the pool's PoolConfig */
  address: string;
  /** true when the admin is a contract (C…) rather than a keypair account (G…) */
  isContract: boolean;
  /** null when admin is a contract (Horizon has no account entry for it) */
  account: {
    highThreshold: number;
    signerCount: number;
    /** operations on the admin account within the activity window */
    recentOps: number;
    activityWindowDays: number;
  } | null;
}

export interface BlendRawData {
  poolId: string;
  oracleId: string;
  oracleDecimals: number;
  /** pool status: 0 active, higher = increasingly frozen (see Blend docs) */
  status: number;
  /**
   * PoolConfig `min_collateral` — the smallest collateral value a position may
   * hold and still borrow, in the ORACLE's base-asset denomination (so divide by
   * 10^oracleDecimals to get USD; the Fixed V2 pool's oracle bases on
   * `Other:USD` at 7 decimals, making the live value of 50000000 exactly $5.00).
   *
   * Read because it is Blend's OWN dust guard: it is set where liquidating a
   * position stops being economically worthwhile, which is the same question
   * §4/§5's minimum-size filter asks. Kept raw rather than pre-divided so the
   * fixture records what the chain actually said.
   *
   * 0n when the pool declares none — a real state, not a missing read.
   */
  minCollateral: bigint;
  admin: BlendAdminRaw;
  oracleConfig: BlendOracleConfigRaw;
  reserves: BlendReserveRaw[];
  fetchedAt: number; // unix seconds, from chain-adjacent clock
}

export interface BlendAdapterOptions {
  rpcUrl?: string;
  horizonUrl?: string;
  /**
   * Which market to score. Defaults to Blend's flagship Fixed V2 pool.
   *
   * A whole BlendPool rather than a bare `poolId`, deliberately: target and
   * identity have to move together. A lone pool-id knob lets an instance read
   * one pool while publishing another pool's slug, name and links — the same
   * class of bug as `adapter: "w"`, and harder to catch, because every field
   * involved stays individually plausible.
   */
  pool?: BlendPool;
}

// Shapes as they come back from scValToNative on the corresponding #[contracttype]
// structs — u32 fields decode to number, i128/u64 to bigint, Address to string.
export interface ReserveConfigNative {
  decimals: number | bigint;
  c_factor: number | bigint;
  l_factor: number | bigint;
  util: number | bigint;
  max_util: number | bigint;
  enabled?: boolean;
}
export interface ReserveDataNative {
  d_rate: number | bigint;
  b_rate: number | bigint;
  b_supply: number | bigint;
  d_supply: number | bigint;
}
export interface PoolConfigNative {
  oracle: string;
  status: number | bigint;
  admin?: string;
  /** optional because a pool predating V2's dust guard simply has no such field */
  min_collateral?: number | bigint;
}
export interface PriceDataNative {
  price: number | bigint;
  timestamp: number | bigint;
}
/** oracle-aggregator `OracleConfig` (its struct, not the pool's PoolConfig). */
export interface OracleConfigNative {
  address: string;
  index: number | bigint;
  resolution: number | bigint;
  decimals: number | bigint;
}
/** oracle-aggregator `AssetConfig`; `asset` decodes to ['Stellar'|'Other', value]. */
export interface AssetConfigNative {
  asset: unknown;
  oracle_index: number | bigint;
  max_dev: number | bigint;
}
export interface HorizonAccount {
  thresholds?: { high_threshold?: number };
  signers?: unknown[];
}
export interface HorizonOps {
  _embedded?: { records?: { created_at: string }[] };
}
