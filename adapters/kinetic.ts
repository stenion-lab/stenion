import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';
// Types and values are imported separately — see the note in blend.ts: native
// type stripping is syntactic, so type-only names left in a value import
// survive into the running module and fail against core's CommonJS output.
import { RiskFactorType, freshnessWindow, scoreFactors } from '@stenion/core';
import type {
  Adapter,
  ProtocolMetadata,
  RiskFactor,
  RiskFactorMap,
  RiskScoreResult,
} from '@stenion/core';

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

const NETWORK_PASSPHRASE = Networks.PUBLIC;

/** Public, key-less Soroban mainnet RPC (Stellar docs "Providers" list). Overridable for self-hosting. */
const DEFAULT_RPC_URL = 'https://mainnet.sorobanrpc.com';

/** Public Horizon — needed for admin-account signer/activity data, which Soroban RPC does not expose. */
const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/** K2 `kinetic_router` — the single entry point for the pool (docs.k2lend.com/contracts). */
const KINETIC_ROUTER = 'CCTUJZLYFAW7ZNQD2SXMUZIHBUUJJICYRKWLZJ6SK6TGNAWNXOJIV6J7';

// Router instance-storage keys (symbol_short!), from kinetic-router/src/storage.rs.
const ADMIN_KEY = 'PADMIN';
const ORACLE_KEY = 'ORACLE';

/** Price-oracle instance-storage key holding the price cache TTL (no public getter exists). */
const PRICE_CACHE_TTL_KEY = 'PriceCacheTtl';

// K2 fixed-point constants (contracts/shared/src/constants.rs).
/** Oracle price precision: PRICE_PRECISION = 14. The K2 oracle exposes no decimals() call — it's a protocol constant. */
const PRICE_DECIMALS = 14;
/**
 * OPTIMAL_UTILIZATION_RATE = 0.8 (80%). K2 has no Blend-style per-reserve
 * `max_util` hard cap; its protocol-configured utilization stress line is the
 * interest-rate kink at 80%, past which borrow rates steepen sharply to
 * discourage further borrowing. `utilizationSafety` anchors to this (agreed
 * 2026-08-11; documented in METHODOLOGY.md as K2's per-protocol anchor).
 */
const OPTIMAL_UTIL = 0.8;

// ReserveConfiguration is a two-word bitmap (shared/src/types.rs). data_low
// packs: LTV(0-13), liquidation_threshold(14-27), liquidation_bonus(28-41),
// decimals(42-49), flags(50-56), reserve_factor(57-70). We only need decimals.
const DECIMALS_SHIFT = 42n;
const DECIMALS_MASK = 0xffn; // 8 bits (42-49)

// ---------------------------------------------------------------------------
// Raw on-chain shape (adapter-specific, per the Adapter<TRawData> contract)
// ---------------------------------------------------------------------------

export interface KineticReserveRaw {
  asset: string;
  /** underlying asset decimals, decoded from the ReserveConfiguration bitmap */
  decimals: number;
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
interface ReserveDataNative {
  a_token_address: string;
  debt_token_address: string;
  configuration: ReserveConfigurationNative;
}
interface PriceDataNative {
  price: number | bigint;
  timestamp: number | bigint;
}
/** price-oracle `OracleConfig` (only the fields oracleSafety reads). */
interface OracleConfigNative {
  max_price_change_bps: number | bigint;
  price_staleness_threshold: number | bigint;
}
/** price-oracle `AssetConfig`. */
interface AssetConfigNative {
  enabled?: boolean;
  max_age?: number | bigint | null;
  feed_id?: string | null;
  batch_adapter?: string | null;
  custom_oracle?: string | null;
  manual_override_price?: number | bigint | null;
  override_expiry_timestamp?: number | bigint | null;
}
interface HorizonAccount {
  thresholds?: { high_threshold?: number };
  signers?: unknown[];
}
interface HorizonOps {
  _embedded?: { records?: { created_at: string }[] };
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/** Read a contract's *instance* storage (holds PADMIN, ORACLE, PCONFIG for the router) into a name->ScVal map. */
async function readInstanceStorage(
  server: rpc.Server,
  contractId: string,
): Promise<Map<string, xdr.ScVal>> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const resp = await server.getLedgerEntries(key);
  if (resp.entries.length === 0) {
    throw new Error(`Kinetic: no instance entry for contract ${contractId}`);
  }
  const instance = resp.entries[0].val.contractData().val().instance();
  const storage = instance.storage() ?? [];
  const out = new Map<string, xdr.ScVal>();
  for (const entry of storage) {
    const name = scValToNative(entry.key());
    // Keys come in two shapes across K2's contracts: a bare symbol (the router's
    // `PADMIN`/`ORACLE`, written with symbol_short!) and a single-element enum
    // vec (the price oracle's `["PriceCacheTtl"]`, from a #[contracttype] key
    // enum). Index both by the same name so callers don't care which is used.
    if (typeof name === 'string') out.set(name, entry.val());
    else if (Array.isArray(name) && name.length === 1 && typeof name[0] === 'string') {
      out.set(name[0], entry.val());
    }
  }
  return out;
}

/** Simulate a read-only contract call and return the decoded native result. */
async function readContract(
  server: rpc.Server,
  contractId: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  // Simulation is side-effect-free and unsigned; a throwaway source account is fine.
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Kinetic: simulation of ${method} on ${contractId} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`Kinetic: ${method} on ${contractId} returned no value`);
  return scValToNative(retval);
}

/** Oracle asset argument: Asset::Stellar(Address) — SEP-40 shape, same as Blend's Reflector feed. */
function stellarAssetArg(asset: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(asset).toScVal()]);
}

function toPrice(native: PriceDataNative | null | undefined): KineticReserveRaw['price'] {
  if (!native || native.price === undefined) return null;
  return {
    value: BigInt(native.price),
    timestamp: Number(native.timestamp),
  };
}

/**
 * Price every reserve through the oracle method the router itself calls.
 *
 * `get_asset_prices_vec_fresh` returns Result<Vec<PriceData>, OracleError> for
 * the whole batch, so one unpriceable asset fails the entire call (a stale price
 * trips the in-contract PriceTooOld check; an unconfigured asset errors too). We
 * don't want a single bad reserve to cost us the protocol's whole score, so on a
 * batch failure we re-read each asset as a one-element batch — same method, same
 * code path — to isolate which reserves have no usable price. Those become null,
 * which oracleSafety scores as maximally unsafe, rather than aborting the run.
 */
async function readOraclePrices(
  server: rpc.Server,
  oracleId: string,
  assets: string[],
): Promise<KineticReserveRaw['price'][]> {
  const batchArg = xdr.ScVal.scvVec(assets.map(stellarAssetArg));
  try {
    const natives = (await readContract(
      server,
      oracleId,
      'get_asset_prices_vec_fresh',
      batchArg,
    )) as (PriceDataNative | null)[];
    if (Array.isArray(natives) && natives.length === assets.length) {
      return natives.map(toPrice);
    }
    // Length mismatch means we can't align prices to reserves; fall through to
    // the per-asset path rather than risk mispricing a reserve.
  } catch {
    // fall through
  }

  const out: KineticReserveRaw['price'][] = [];
  for (const asset of assets) {
    try {
      const natives = (await readContract(
        server,
        oracleId,
        'get_asset_prices_vec_fresh',
        xdr.ScVal.scvVec([stellarAssetArg(asset)]),
      )) as (PriceDataNative | null)[];
      out.push(Array.isArray(natives) ? toPrice(natives[0]) : null);
    } catch {
      out.push(null);
    }
  }
  return out;
}

/**
 * Read the price oracle's own published config.
 *
 * `PriceCacheTtl` has no public getter (the contract exports `set_price_cache_ttl`
 * but no matching read), so it comes from the oracle's instance storage — the
 * same way the router's ORACLE/PADMIN are read.
 */
async function readOracleConfig(
  server: rpc.Server,
  oracleId: string,
): Promise<KineticOracleConfigRaw> {
  const cfg = (await readContract(server, oracleId, 'get_oracle_config')) as OracleConfigNative;
  const paused = Boolean(await readContract(server, oracleId, 'is_paused'));

  let priceCacheTtl = 0;
  const instance = await readInstanceStorage(server, oracleId);
  const ttlScv = instance.get(PRICE_CACHE_TTL_KEY);
  if (ttlScv) priceCacheTtl = Number(scValToNative(ttlScv) as number | bigint);

  return {
    maxPriceChangeBps: Number(cfg.max_price_change_bps),
    priceStalenessThreshold: Number(cfg.price_staleness_threshold),
    priceCacheTtl,
    paused,
  };
}

/**
 * Read one asset's oracle config plus the circuit-breaker baseline.
 *
 * Both are per-asset public reads. `get_last_price` matters as much as the
 * config: the breaker only bites once a baseline exists, so a whitelisted asset
 * with no baseline is one the breaker currently lets through unchecked.
 */
async function readPriceConfig(
  server: rpc.Server,
  oracleId: string,
  asset: string,
  fetchedAt: number,
): Promise<KineticReserveRaw['priceConfig']> {
  let cfg: AssetConfigNative | null;
  try {
    cfg = (await readContract(
      server,
      oracleId,
      'get_asset_config',
      stellarAssetArg(asset),
    )) as AssetConfigNative | null;
  } catch {
    return null;
  }
  if (!cfg) return null;

  let breakerBaseline: bigint | null = null;
  try {
    const last = (await readContract(
      server,
      oracleId,
      'get_last_price',
      stellarAssetArg(asset),
    )) as number | bigint | null;
    breakerBaseline = last === null || last === undefined ? null : BigInt(last);
  } catch {
    breakerBaseline = null;
  }

  const expiry = cfg.override_expiry_timestamp;
  const manualOverrideActive =
    cfg.manual_override_price !== null &&
    cfg.manual_override_price !== undefined &&
    expiry !== null &&
    expiry !== undefined &&
    Number(expiry) > fetchedAt;

  const source: NonNullable<KineticReserveRaw['priceConfig']>['source'] =
    cfg.batch_adapter && cfg.feed_id
      ? 'batchAdapter'
      : cfg.custom_oracle
        ? 'customOracle'
        : 'reflector';

  return {
    enabled: cfg.enabled !== false,
    maxAge: cfg.max_age === null || cfg.max_age === undefined ? null : Number(cfg.max_age),
    source,
    feedId: cfg.feed_id ?? null,
    manualOverrideActive,
    breakerBaseline,
  };
}

async function fetchAdmin(horizonUrl: string, address: string): Promise<KineticAdminRaw> {
  const isContract = address.startsWith('C');
  if (isContract) {
    // Contract-governed admin: Horizon has no account entry to introspect. We
    // record the fact honestly rather than fabricating signer/activity data.
    return { address, isContract: true, account: null };
  }

  const windowDays = 30;
  const acctResp = await fetch(`${horizonUrl}/accounts/${address}`);
  if (!acctResp.ok) {
    throw new Error(
      `Kinetic: Horizon account fetch for admin ${address} failed (${acctResp.status})`,
    );
  }
  const acct = (await acctResp.json()) as HorizonAccount;

  const opsResp = await fetch(`${horizonUrl}/accounts/${address}/operations?order=desc&limit=200`);
  if (!opsResp.ok) {
    throw new Error(`Kinetic: Horizon ops fetch for admin ${address} failed (${opsResp.status})`);
  }
  const opsBody = (await opsResp.json()) as HorizonOps;
  const records = opsBody?._embedded?.records ?? [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const recentOps = records.filter((r) => {
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) && t >= cutoff;
  }).length;

  return {
    address,
    isContract: false,
    account: {
      highThreshold: Number(acct.thresholds?.high_threshold ?? 0),
      signerCount: Array.isArray(acct.signers) ? acct.signers.length : 0,
      recentOps,
      activityWindowDays: windowDays,
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

/** Map v from [a,b] linearly onto [0,100], clamped. Descending if a>b. */
function lerp01(v: number, a: number, b: number): number {
  if (a === b) return v >= a ? 100 : 0;
  return clamp(((v - a) / (b - a)) * 100);
}

/** First 6 chars of a contract address, for detail strings. */
const shortAsset = (a: string): string => `${a.slice(0, 6)}…`;

/**
 * Score every reserve on one sub-signal and keep the worst. Same convention as
 * every other factor: the binding constraint is the single weakest reserve.
 */
function worstBy(
  reserves: KineticReserveRaw[],
  score: (r: KineticReserveRaw) => { score: number; note: string },
): { score: number; note: string; asset: string } {
  let worst = { score: Number.POSITIVE_INFINITY, note: 'no reserves', asset: '' };
  for (const r of reserves) {
    const s = score(r);
    if (s.score <= worst.score) worst = { ...s, asset: r.asset };
  }
  return Number.isFinite(worst.score) ? worst : { score: 0, note: 'no reserves', asset: '' };
}

/** Underlying supplied/borrowed for a reserve, in human units (asset decimals applied). */
function reserveTotals(r: KineticReserveRaw): { supplied: number; borrowed: number } {
  const denom = 10 ** r.decimals;
  return {
    supplied: Number(r.suppliedRaw) / denom,
    borrowed: Number(r.borrowedRaw) / denom,
  };
}

/** USD value of supplied liquidity for a reserve, or null if no price. */
function suppliedUsd(r: KineticReserveRaw, priceDecimals: number): number | null {
  if (!r.price) return null;
  const { supplied } = reserveTotals(r);
  const priceFloat = Number(r.price.value) / 10 ** priceDecimals;
  return supplied * priceFloat;
}

/**
 * decimals packed in ReserveConfiguration.data_low bits 42-49.
 *
 * Exported for direct testing: this is bit-manipulation whose failure mode is
 * silent — an off-by-one in the shift or a wrong mask yields a plausible-looking
 * decimals value, which then scales every supplied/borrowed figure for the
 * reserve by a power of ten. Live data can't distinguish that from a real
 * balance change, so it's pinned against known bitmaps instead.
 */
export function decodeDecimals(cfg: ReserveConfigurationNative): number {
  return Number((BigInt(cfg.data_low) >> DECIMALS_SHIFT) & DECIMALS_MASK);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface KineticAdapterOptions {
  rpcUrl?: string;
  horizonUrl?: string;
  routerId?: string;
}

export class KineticAdapter implements Adapter<KineticRawData> {
  readonly metadata: ProtocolMetadata = {
    id: 'kinetic',
    name: 'Kinetic',
    chain: 'stellar',
  };

  private readonly rpcUrl: string;
  private readonly horizonUrl: string;
  private readonly routerId: string;

  constructor(opts: KineticAdapterOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
    this.horizonUrl = opts.horizonUrl ?? DEFAULT_HORIZON_URL;
    this.routerId = opts.routerId ?? KINETIC_ROUTER;
  }

  async fetchRawData(): Promise<KineticRawData> {
    const server = new rpc.Server(this.rpcUrl);

    // Router instance storage → admin (PADMIN) and oracle (ORACLE) addresses.
    const instance = await readInstanceStorage(server, this.routerId);
    const adminScv = instance.get(ADMIN_KEY);
    const oracleScv = instance.get(ORACLE_KEY);
    if (!adminScv)
      throw new Error(`Kinetic: router ${this.routerId} has no ${ADMIN_KEY} in instance storage`);
    if (!oracleScv)
      throw new Error(`Kinetic: router ${this.routerId} has no ${ORACLE_KEY} in instance storage`);
    const adminAddress = scValToNative(adminScv) as string;
    const oracleId = scValToNative(oracleScv) as string;

    const paused = Boolean(await readContract(server, this.routerId, 'is_paused'));

    const reserveList = (await readContract(
      server,
      this.routerId,
      'get_reserves_list',
    )) as string[];
    if (!Array.isArray(reserveList) || reserveList.length === 0) {
      throw new Error(`Kinetic: router ${this.routerId} returned an empty reserve list`);
    }

    // Balances first, then one batched oracle read for every reserve at once —
    // the batch is the shape the router uses, and it keeps all prices on the
    // same oracle invocation rather than N independently-cached ones.
    const balances: Omit<KineticReserveRaw, 'price' | 'priceConfig'>[] = [];
    for (const asset of reserveList) {
      const rd = (await readContract(
        server,
        this.routerId,
        'get_current_reserve_data',
        new Address(asset).toScVal(),
      )) as ReserveDataNative;
      const decimals = decodeDecimals(rd.configuration);
      // total_supply() returns underlying units with the current index applied,
      // so no RAY/index math is needed on our side.
      const suppliedRaw = BigInt(
        (await readContract(server, rd.a_token_address, 'total_supply')) as number | bigint,
      );
      const borrowedRaw = BigInt(
        (await readContract(server, rd.debt_token_address, 'total_supply')) as number | bigint,
      );
      balances.push({ asset, decimals, suppliedRaw, borrowedRaw });
    }

    const fetchedAt = Math.floor(Date.now() / 1000);
    const prices = await readOraclePrices(server, oracleId, reserveList);
    const oracleConfig = await readOracleConfig(server, oracleId);
    const priceConfigs: KineticReserveRaw['priceConfig'][] = [];
    for (const asset of reserveList) {
      priceConfigs.push(await readPriceConfig(server, oracleId, asset, fetchedAt));
    }
    const reserves: KineticReserveRaw[] = balances.map((b, i) => ({
      ...b,
      price: prices[i],
      priceConfig: priceConfigs[i],
    }));

    const admin = await fetchAdmin(this.horizonUrl, adminAddress);

    return {
      routerId: this.routerId,
      oracleId,
      oraclePriceDecimals: PRICE_DECIMALS,
      paused,
      admin,
      oracleConfig,
      reserves,
      fetchedAt,
    };
  }

  async computeRiskFactors(raw: KineticRawData): Promise<RiskFactorMap> {
    return {
      [RiskFactorType.CollateralSafety]: this.collateralSafety(raw),
      [RiskFactorType.OracleSafety]: this.oracleSafety(raw),
      [RiskFactorType.AdminKeySafety]: this.adminKeySafety(raw),
      [RiskFactorType.LiquiditySafety]: this.liquiditySafety(raw),
      [RiskFactorType.UtilizationSafety]: this.utilizationSafety(raw),
    };
  }

  // Concentration of supplied value across reserves, via a normalized HHI.
  // Identical formula/anchors to Blend (METHODOLOGY.md §1): HHI = Σ(share²),
  // mapped 1/n → 100 (even split) and 1 → 0 (all in one asset). Pure on-chain
  // supplied USD.
  private collateralSafety(raw: KineticRawData): RiskFactor {
    const weight = 0.2;
    const values = raw.reserves
      .map((r) => suppliedUsd(r, raw.oraclePriceDecimals))
      .filter((v): v is number => v !== null && v > 0);

    if (values.length === 0) {
      return {
        value: 0,
        weight,
        detail: 'no priced supplied value available to assess concentration',
      };
    }
    const n = values.length;
    if (n === 1) {
      return { value: 0, weight, detail: 'single priced reserve — fully concentrated' };
    }
    const total = values.reduce((a, b) => a + b, 0);
    const hhi = values.reduce((acc, v) => acc + (v / total) ** 2, 0);
    const minHhi = 1 / n;
    const value = clamp(((1 - hhi) / (1 - minHhi)) * 100);
    const topShare = Math.max(...values) / total;
    return {
      value: Math.round(value),
      weight,
      detail: `top reserve holds ${(topShare * 100).toFixed(0)}% of supplied value across ${n} reserves (HHI ${hhi.toFixed(2)})`,
    };
  }

  // Same rule as Blend (METHODOLOGY.md §2): a price is trustworthy only if it is
  // both current and bounded against a single large move. Worst reserve for each
  // sub-signal; the factor takes the binding constraint of the two.
  //
  // The per-protocol anchors differ because the readable parameters differ —
  // K2 has no publish-interval getter, so `fresh` anchors to its price cache TTL
  // (the window inside which K2 itself considers a price current) and `dead` to
  // the tighter of its per-asset max_age and its global staleness threshold.
  private oracleSafety(raw: KineticRawData): RiskFactor {
    const weight = 0.25;
    const { maxPriceChangeBps, priceStalenessThreshold, priceCacheTtl } = raw.oracleConfig;

    const worstFresh = worstBy(raw.reserves, (r) => {
      if (!r.price) return { score: 0, note: 'no usable oracle price' };
      const age = Math.max(0, raw.fetchedAt - r.price.timestamp);
      // Both are K2's own numbers; taking the tighter of the two is not a
      // Stenion threshold, it's the binding one of two protocol-declared limits.
      const declared = Math.min(
        r.priceConfig?.maxAge ?? priceStalenessThreshold,
        priceStalenessThreshold,
      );
      const { fresh, dead } = freshnessWindow(priceCacheTtl, declared);
      return {
        score: lerp01(age, dead, fresh),
        note: `${age}s old (fresh<${fresh}s, dead>${dead}s)`,
      };
    });

    // Binary, as for Blend — but K2's breaker fails *open* where Blend's aggregator
    // fails closed: `validate_price_change` returns Ok when there is no stored
    // baseline, so a configured bound with no `get_last_price` is inert. Both
    // conditions must hold for the bound to count as armed.
    const worstBound = worstBy(raw.reserves, (r) => {
      if (maxPriceChangeBps <= 0)
        return { score: 0, note: 'max_price_change_bps 0 — circuit breaker disabled' };
      if (!r.priceConfig) return { score: 0, note: 'asset not whitelisted on the oracle' };
      const baseline = r.priceConfig.breakerBaseline;
      if (baseline === null || baseline === 0n) {
        return { score: 0, note: 'no circuit-breaker baseline — breaker passes any price' };
      }
      return {
        score: 100,
        note: `breaker armed at ${maxPriceChangeBps}bps against a stored baseline`,
      };
    });

    const value = Math.min(worstFresh.score, worstBound.score);
    const overridden = raw.reserves.filter((r) => r.priceConfig?.manualOverrideActive);
    const sources = raw.reserves
      .map((r) => `${shortAsset(r.asset)} ${r.priceConfig?.source ?? 'unconfigured'}`)
      .join(', ');

    return {
      value: Math.round(value),
      weight,
      detail:
        worstBound.score === 0
          ? `worst reserve (${shortAsset(worstBound.asset)}) ${worstBound.note}`
          : `worst reserve (${shortAsset(worstFresh.asset)}) ${worstFresh.note}; circuit breaker armed on all reserves`,
      components: [
        {
          id: 'priceFreshness',
          label: 'Price freshness',
          value: Math.round(worstFresh.score),
          detail: `worst reserve (${shortAsset(worstFresh.asset)}) ${worstFresh.note}; anchored to K2's own cache TTL (${priceCacheTtl}s) and staleness threshold (${priceStalenessThreshold}s)`,
        },
        {
          id: 'deviationBound',
          label: 'Deviation bound',
          value: Math.round(worstBound.score),
          detail: `worst reserve (${shortAsset(worstBound.asset)}) ${worstBound.note}`,
        },
        {
          id: 'deviationTightness',
          label: 'Bound tightness (not scored)',
          value: null,
          detail: `max_price_change_bps ${maxPriceChangeBps} (${maxPriceChangeBps / 100}%), global. Measured against the last price the oracle served, so unlike Blend's per-publish-interval bound this has no fixed time spacing — the two are not comparable as numbers. Reported, not graded — see METHODOLOGY.md §2. Price sources: ${sources}.${overridden.length > 0 ? ` ADMIN PRICE OVERRIDE ACTIVE on ${overridden.map((r) => shortAsset(r.asset)).join(', ')}.` : ''}`,
        },
      ],
    };
  }

  // Admin key posture from Horizon — identical tier table to Blend
  // (METHODOLOGY.md §3): contract-governed → flagged neutral 60; single key →
  // 40; N-of-M multisig → 90; minus a capped activity penalty (−3/op, ≤−30).
  // K2's admin (PADMIN) is expected to be a governance contract (C…), which
  // Horizon can't introspect → neutral baseline, flagged in the detail.
  private adminKeySafety(raw: KineticRawData): RiskFactor {
    const weight = 0.2;
    const a = raw.admin;

    if (a.isContract || a.account === null) {
      return {
        value: 60,
        weight,
        detail: `admin is a contract (${a.address.slice(0, 6)}…) — not introspectable via Horizon; neutral baseline`,
      };
    }

    const { highThreshold, signerCount, recentOps, activityWindowDays } = a.account;
    const multisig = signerCount > 1 && highThreshold > 1;
    const base = multisig ? 90 : 40;
    const activityPenalty = Math.min(30, recentOps * 3);
    const value = clamp(base - activityPenalty);
    return {
      value: Math.round(value),
      weight,
      detail: `${multisig ? 'multisig' : 'single-key'} admin (${signerCount} signer(s), high-threshold ${highThreshold}), ${recentOps} op(s) in ${activityWindowDays}d`,
    };
  }

  // Free liquidity as a share of supplied value (1 − utilization), worst
  // reserve. Identical to Blend (METHODOLOGY.md §4): the absolute withdrawal
  // cushion, distinct from utilizationSafety's proximity-to-cap.
  private liquiditySafety(raw: KineticRawData): RiskFactor {
    const weight = 0.15;
    let worstRatio = 1;
    let worstAsset = '';
    let measured = 0;
    for (const r of raw.reserves) {
      const { supplied, borrowed } = reserveTotals(r);
      if (supplied <= 0) continue;
      measured++;
      const free = clamp(((supplied - borrowed) / supplied) * 100);
      if (free <= worstRatio * 100) {
        worstRatio = free / 100;
        worstAsset = r.asset;
      }
    }
    // METHODOLOGY.md §4 is a minimum over reserves with supplied > 0; over none
    // it is undefined, not 100. Same rule and same reasoning as Blend.
    if (measured === 0) {
      return {
        value: 0,
        weight,
        detail: 'no reserve has any supplied value — free liquidity cannot be assessed',
      };
    }
    return {
      value: Math.round(worstRatio * 100),
      weight,
      detail: `worst reserve (${worstAsset.slice(0, 6)}…) has ${(worstRatio * 100).toFixed(0)}% of supply as free liquidity`,
    };
  }

  // Proximity of live utilization to K2's protocol-configured utilization stress
  // line. K2 is Aave-V3-style and has NO Blend-style per-reserve `max_util` hard
  // cap; its configured danger line is the interest-rate kink at
  // OPTIMAL_UTILIZATION_RATE = 80%, past which borrow rates steepen sharply.
  // We anchor to that (same anchoring *pattern* as Blend's max_util — the
  // protocol's own on-chain utilization parameter — see METHODOLOGY.md §5):
  // headroom = (0.8 − util)/0.8, worst reserve wins.
  private utilizationSafety(raw: KineticRawData): RiskFactor {
    const weight = 0.2;
    let worst = 100;
    let worstAsset = '';
    let worstUtil = 0;
    let measured = 0;
    for (const r of raw.reserves) {
      const { supplied, borrowed } = reserveTotals(r);
      if (supplied <= 0) continue;
      measured++;
      const util = borrowed / supplied;
      const headroom = clamp(((OPTIMAL_UTIL - util) / OPTIMAL_UTIL) * 100);
      if (headroom <= worst) {
        worst = headroom;
        worstAsset = r.asset;
        worstUtil = util;
      }
    }
    // Only one "nothing to measure" case here, unlike Blend: K2's cap is the
    // OPTIMAL_UTILIZATION_RATE constant (0.8), so §5's `cap > 0` filter can
    // never exclude a reserve. There is deliberately no no-configured-cap branch
    // — it would be unreachable. If K2 ever exposes a readable per-reserve
    // optimal-util (see METHODOLOGY.md §5's second caveat), this needs Blend's
    // two-branch treatment.
    if (measured === 0) {
      return {
        value: 0,
        weight,
        detail: 'no reserve has any supplied value — utilization headroom cannot be assessed',
      };
    }
    return {
      value: Math.round(worst),
      weight,
      detail: `worst reserve (${worstAsset.slice(0, 6)}…) at ${(worstUtil * 100).toFixed(0)}% util vs ${(OPTIMAL_UTIL * 100).toFixed(0)}% optimal-utilization kink`,
    };
  }

  // Delegates to the shared rulebook in @stenion/core. The weighted mean is not
  // per-protocol (METHODOLOGY.md ground rule 1), so it must not be reimplemented
  // here — this method exists only to satisfy the Adapter interface.
  score(factors: RiskFactorMap): RiskScoreResult {
    return scoreFactors(factors);
  }
}

export const kineticAdapter = new KineticAdapter();
