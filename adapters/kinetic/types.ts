// Mainnet wiring, the raw on-chain shape, and the adapter's options — the
// leaf of this adapter's module graph. Everything here is either a type or a
// constant; nothing reads the chain and nothing scores.

import { Networks } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Mainnet wiring — Kinetic (rebranded "K2", k2lend.com)
//
// K2 is a genuinely independent Soroban lending protocol (NOT a Blend pool —
// unlike YieldBlox, which turned out to be a community pool on Blend V2 and so
// was deliberately not given its own adapter; see CLAUDE.md step 9). It is an
// Aave-V3-style single-pool-multi-asset market: one router contract fronts up
// to 64 reserves (currently USDC, XLM, PYUSD, SolvBTC).
//
// Addresses come from K2's own published deployment (docs.k2lend.com/contracts),
// the same trust posture as Blend (protocol's own deploy config). The read
// interface below was confirmed field-by-field against the audited Rust source
// (Code4rena `code-423n4/2026-04-k2`) — no method or field is guessed:
//   - router.get_reserves_list() -> Vec<Address>
//   - router.get_current_reserve_data(asset) -> ReserveData { liquidity_index,
//       variable_borrow_index, a_token_address, debt_token_address,
//       configuration { data_low, data_high }, ... }
//   - router.is_paused() -> bool
//   - aToken/debtToken.total_supply() -> i128  (underlying units, index applied)
//   - price_oracle.get_asset_prices_vec_fresh(Vec<Asset>) -> Vec<PriceData>
//       { price: u128 (PRICE_PRECISION = 14 dp), timestamp: u64 }
// The oracle address and admin address are read live from the router's instance
// storage (keys "ORACLE" / "PADMIN"), not hardcoded — trustless.
//
// Why `get_asset_prices_vec_fresh` and not `get_asset_price_data`: the deployed
// kinetic_router does not call `get_asset_price_data` at all. Scanning the live
// router's wasm for the oracle method symbols it references shows
// `get_asset_prices_vec_fresh` present and `get_asset_price_data` absent, so the
// latter is a code path K2 never prices off. We read the method the protocol
// actually uses, so `oracleSafety` measures the prices the pool's own risk logic
// sees rather than a sibling method that merely happens to agree today.
// ---------------------------------------------------------------------------

export const NETWORK_PASSPHRASE = Networks.PUBLIC;

/** Public, key-less Soroban mainnet RPC (Stellar docs "Providers" list). Overridable for self-hosting. */
export const DEFAULT_RPC_URL = 'https://mainnet.sorobanrpc.com';

/** Public Horizon — needed for admin-account signer/activity data, which Soroban RPC does not expose. */
export const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/** K2 `kinetic_router` — the single entry point for the pool (docs.k2lend.com/contracts). */
export const KINETIC_ROUTER = 'CCTUJZLYFAW7ZNQD2SXMUZIHBUUJJICYRKWLZJ6SK6TGNAWNXOJIV6J7';

// Router instance-storage keys (symbol_short!), from kinetic-router/src/storage.rs.
export const ADMIN_KEY = 'PADMIN';
export const ORACLE_KEY = 'ORACLE';

/** Price-oracle instance-storage key holding the price cache TTL (no public getter exists). */
export const PRICE_CACHE_TTL_KEY = 'PriceCacheTtl';

// K2 fixed-point constants (contracts/shared/src/constants.rs).
/** Oracle price precision: PRICE_PRECISION = 14. The K2 oracle exposes no decimals() call — it's a protocol constant. */
export const PRICE_DECIMALS = 14;
/**
 * OPTIMAL_UTILIZATION_RATE = 0.8 (80%). K2 has no Blend-style per-reserve
 * `max_util` hard cap; its protocol-configured utilization stress line is the
 * interest-rate kink at 80%, past which borrow rates steepen sharply to
 * discourage further borrowing. `utilizationSafety` anchors to this (agreed
 * 2026-08-11; documented in METHODOLOGY.md as K2's per-protocol anchor).
 */
export const OPTIMAL_UTIL = 0.8;

// ReserveConfiguration is a two-word bitmap (shared/src/types.rs). data_low
// packs: LTV(0-13), liquidation_threshold(14-27), liquidation_bonus(28-41),
// decimals(42-49), flags(50-56), reserve_factor(57-70).
export const DECIMALS_SHIFT = 42n;
export const DECIMALS_MASK = 0xffn; // 8 bits (42-49)

// The per-reserve gating flags, from the same `data_low` word `decimals` comes
// out of — so reading them costs no extra RPC call. Bit positions and their
// meanings are from `ReserveConfiguration` in contracts/shared/src/utils.rs of
// the audited source (Code4rena `code-423n4/2026-04-k2`), which documents the
// layout and implements one accessor per flag.
//
// Bit 54-55 are a documented reserved gap and bit 56 is `flashloan_enabled`,
// which is deliberately not read: a market that has only stopped flash loans has
// not restricted any operation a depositor or borrower performs.
export const ACTIVE_BIT = 50n;
export const FROZEN_BIT = 51n;
export const BORROWING_ENABLED_BIT = 52n;
export const PAUSED_BIT = 53n;

// ---------------------------------------------------------------------------
// Raw on-chain shape (adapter-specific, per the Adapter<TRawData> contract)
// ---------------------------------------------------------------------------

/**
 * One reserve's gating flags, decoded from the same ReserveConfiguration word as
 * its decimals.
 *
 * K2 gates PER RESERVE as well as globally, which Blend does not do at all — so
 * a K2 market can be open in USDC and halted in PYUSD. That is why these are
 * captured: without them, a market whose largest reserve is paused would publish
 * "active" on the strength of `router.is_paused() == false`.
 *
 * What each one blocks, read from `validate_supply` / `validate_withdraw` /
 * `validate_borrow` / `validate_repay` / `validate_liquidation` in
 * contracts/kinetic-router/src/validation.rs:
 *
 *   !active  — every operation on this reserve, withdrawals included
 *   paused   — every operation on this reserve, withdrawals included
 *   frozen   — supply and borrow; withdraw, repay and liquidate still work
 *   !borrowingEnabled — borrow only
 */
export interface KineticReserveFlags {
  /** bit 50 — false means the reserve is switched off entirely */
  active: boolean;
  /** bit 51 — no new exposure, but positions can still be closed */
  frozen: boolean;
  /** bit 52 */
  borrowingEnabled: boolean;
  /** bit 53 — a full halt on this one reserve */
  paused: boolean;
}

export interface KineticReserveRaw {
  asset: string;
  /** underlying asset decimals, decoded from the ReserveConfiguration bitmap */
  decimals: number;
  /** this reserve's own gating flags — see KineticReserveFlags */
  flags: KineticReserveFlags;
  /** aToken.total_supply() — total supplied, underlying base units (liquidity index applied) */
  suppliedRaw: bigint;
  /** debtToken.total_supply() — total variable debt, underlying base units (borrow index applied) */
  borrowedRaw: bigint;
  /** oracle reading for this asset, or null if the oracle had no usable price (unconfigured / PriceTooOld) */
  price: {
    value: bigint; // fixed point, PRICE_DECIMALS places
    timestamp: number; // unix seconds, the oracle's own publish time
  } | null;
  /** this asset's entry in the oracle's own `get_asset_config()`, or null if not whitelisted */
  priceConfig: {
    enabled: boolean;
    /** per-asset max acceptable price age, seconds (null when unset) */
    maxAge: number | null;
    /** which leg of the oracle's resolution cascade prices this asset */
    source: 'batchAdapter' | 'customOracle' | 'reflector';
    /** feed identifier on the upstream batch adapter, e.g. "XLM" */
    feedId: string | null;
    /** an admin-set price is currently in force for this asset */
    manualOverrideActive: boolean;
    /**
     * `get_last_price()` — the baseline the circuit breaker compares against.
     * Null/zero means the breaker has no baseline and, per the contract, lets
     * any price through (it fails *open*). See `oracleSafety`.
     */
    breakerBaseline: bigint | null;
  } | null;
}

/** The price oracle's own published configuration. */
export interface KineticOracleConfigRaw {
  /** `max_price_change_bps` — circuit breaker bound in basis points; 0 disables it */
  maxPriceChangeBps: number;
  /** `price_staleness_threshold` — global max price age, seconds */
  priceStalenessThreshold: number;
  /** `PriceCacheTtl` — how long the oracle reuses a price without re-reading, seconds */
  priceCacheTtl: number;
  /** `is_paused()` on the oracle itself (distinct from the router's pause) */
  paused: boolean;
}

export interface KineticAdminRaw {
  /** admin address from the router's instance storage (PADMIN) */
  address: string;
  /** true when the admin is a contract (C…) rather than a keypair account (G…) */
  isContract: boolean;
  /** null when admin is a contract (Horizon has no account entry for it) */
  account: {
    highThreshold: number;
    signerCount: number;
    recentOps: number;
    activityWindowDays: number;
  } | null;
}

export interface KineticRawData {
  routerId: string;
  oracleId: string;
  oraclePriceDecimals: number;
  /** router.is_paused() — global pause switch. Captured (like Blend's `status`) but not yet fed into a factor. */
  paused: boolean;
  admin: KineticAdminRaw;
  oracleConfig: KineticOracleConfigRaw;
  reserves: KineticReserveRaw[];
  fetchedAt: number; // unix seconds
}

// Shapes as they come back from scValToNative on the corresponding #[contracttype]
// structs — u32 fields decode to number, i128/u128/u64 to bigint, Address to string.
export interface ReserveConfigurationNative {
  data_low: number | bigint;
  data_high: number | bigint;
}
export interface ReserveDataNative {
  a_token_address: string;
  debt_token_address: string;
  configuration: ReserveConfigurationNative;
}
export interface PriceDataNative {
  price: number | bigint;
  timestamp: number | bigint;
}
/** price-oracle `OracleConfig` (only the fields oracleSafety reads). */
export interface OracleConfigNative {
  max_price_change_bps: number | bigint;
  price_staleness_threshold: number | bigint;
}
/** price-oracle `AssetConfig`. */
export interface AssetConfigNative {
  enabled?: boolean;
  max_age?: number | bigint | null;
  feed_id?: string | null;
  batch_adapter?: string | null;
  custom_oracle?: string | null;
  manual_override_price?: number | bigint | null;
  override_expiry_timestamp?: number | bigint | null;
}
export interface HorizonAccount {
  thresholds?: { high_threshold?: number };
  signers?: unknown[];
}
export interface HorizonOps {
  _embedded?: { records?: { created_at: string }[] };
}

export interface KineticAdapterOptions {
  rpcUrl?: string;
  horizonUrl?: string;
  routerId?: string;
}
