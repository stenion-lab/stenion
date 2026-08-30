// Everything that reads the chain: Soroban RPC + Horizon, and the bit-level
// decoders that turn K2's packed `ReserveConfiguration` words into this
// adapter's raw shape.
//
// Nothing here scores. `fetchKineticRawData` is the whole of what the adapter's
// `fetchRawData` does — it takes the target explicitly rather than reading it
// off an instance, so the router it reads is always the router it was handed.

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';

import {
  contractInstanceKey,
  readLedgerEntries,
  type LedgerEntrySource,
} from '../ledger-entries.ts';
import { horizonFetch, rateLimitedServer } from '../rate-limit.ts';
import {
  ACTIVE_BIT,
  ADMIN_KEY,
  BORROWING_ENABLED_BIT,
  DECIMALS_MASK,
  DECIMALS_SHIFT,
  FROZEN_BIT,
  NETWORK_PASSPHRASE,
  ORACLE_KEY,
  PAUSED_BIT,
  PRICE_CACHE_TTL_KEY,
  PRICE_DECIMALS,
} from './types.ts';
import type {
  AssetConfigNative,
  HorizonAccount,
  HorizonOps,
  KineticAdminRaw,
  KineticOracleConfigRaw,
  KineticRawData,
  KineticReserveFlags,
  KineticReserveRaw,
  OracleConfigNative,
  PriceDataNative,
  ReserveConfigurationNative,
  ReserveDataNative,
} from './types.ts';

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/**
 * Read a contract's *instance* storage (holds PADMIN, ORACLE, PCONFIG for the
 * router) into a name->ScVal map.
 *
 * KINETIC'S TWO INSTANCE READS CANNOT BE BATCHED WITH EACH OTHER, and that is a
 * property of the contracts rather than of this code: the oracle's address is
 * only learnable by reading the router's instance storage first, so the second
 * key does not exist until the first call has returned. Everything else this
 * adapter reads is a `simulateTransaction`, which takes one transaction per
 * call and has no batch form at all. So Kinetic issues the same two
 * `getLedgerEntries` calls after this change as before it — see
 * `fetchKineticRawData`. It goes through the shared batching module anyway, so
 * that no adapter keeps a private copy of key construction or of the
 * absent-entry contract.
 */
async function readInstanceStorage(
  server: LedgerEntrySource,
  contractId: string,
): Promise<Map<string, xdr.ScVal>> {
  const key = contractInstanceKey(contractId);
  const entry = (await readLedgerEntries(server, [key])).get(key);
  if (entry === null) {
    throw new Error(`Kinetic: no instance entry for contract ${contractId}`);
  }
  const instance = entry.contractData().val().instance();
  const storage = instance.storage() ?? [];
  const out = new Map<string, xdr.ScVal>();
  for (const storageEntry of storage) {
    const name = scValToNative(storageEntry.key());
    // Keys come in two shapes across K2's contracts: a bare symbol (the router's
    // `PADMIN`/`ORACLE`, written with symbol_short!) and a single-element enum
    // vec (the price oracle's `["PriceCacheTtl"]`, from a #[contracttype] key
    // enum). Index both by the same name so callers don't care which is used.
    if (typeof name === 'string') out.set(name, storageEntry.val());
    else if (Array.isArray(name) && name.length === 1 && typeof name[0] === 'string') {
      out.set(name[0], storageEntry.val());
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
  const acctResp = await horizonFetch(`${horizonUrl}/accounts/${address}`);
  if (!acctResp.ok) {
    throw new Error(
      `Kinetic: Horizon account fetch for admin ${address} failed (${acctResp.status})`,
    );
  }
  const acct = (await acctResp.json()) as HorizonAccount;

  const opsResp = await horizonFetch(
    `${horizonUrl}/accounts/${address}/operations?order=desc&limit=200`,
  );
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

/** The four gating flags out of the same `data_low` word — see KineticReserveFlags. */
export function decodeReserveFlags(cfg: ReserveConfigurationNative): KineticReserveFlags {
  const low = BigInt(cfg.data_low);
  const bit = (position: bigint) => ((low >> position) & 1n) === 1n;
  return {
    active: bit(ACTIVE_BIT),
    frozen: bit(FROZEN_BIT),
    borrowingEnabled: bit(BORROWING_ENABLED_BIT),
    paused: bit(PAUSED_BIT),
  };
}

// ---------------------------------------------------------------------------
// The fetch itself
// ---------------------------------------------------------------------------

/**
 * Read the Kinetic router into `KineticRawData`.
 *
 * Target is a parameter, not instance state: `routerId` is the only router this
 * reads, and the caller that supplies it is the same one that publishes the
 * identity built from it, so the two cannot drift.
 */
export async function fetchKineticRawData(target: {
  rpcUrl: string;
  horizonUrl: string;
  routerId: string;
}): Promise<KineticRawData> {
  const { rpcUrl, horizonUrl, routerId } = target;
  // Rate-limit retry lives in the server wrapper — see ../rate-limit.ts.
  const server = rateLimitedServer(rpcUrl);

  // Router instance storage → admin (PADMIN) and oracle (ORACLE) addresses.
  const instance = await readInstanceStorage(server, routerId);
  const adminScv = instance.get(ADMIN_KEY);
  const oracleScv = instance.get(ORACLE_KEY);
  if (!adminScv)
    throw new Error(`Kinetic: router ${routerId} has no ${ADMIN_KEY} in instance storage`);
  if (!oracleScv)
    throw new Error(`Kinetic: router ${routerId} has no ${ORACLE_KEY} in instance storage`);
  const adminAddress = scValToNative(adminScv) as string;
  const oracleId = scValToNative(oracleScv) as string;

  const paused = Boolean(await readContract(server, routerId, 'is_paused'));

  const reserveList = (await readContract(server, routerId, 'get_reserves_list')) as string[];
  if (!Array.isArray(reserveList) || reserveList.length === 0) {
    throw new Error(`Kinetic: router ${routerId} returned an empty reserve list`);
  }

  // Balances first, then one batched oracle read for every reserve at once —
  // the batch is the shape the router uses, and it keeps all prices on the
  // same oracle invocation rather than N independently-cached ones.
  const balances: Omit<KineticReserveRaw, 'price' | 'priceConfig'>[] = [];
  for (const asset of reserveList) {
    const rd = (await readContract(
      server,
      routerId,
      'get_current_reserve_data',
      new Address(asset).toScVal(),
    )) as ReserveDataNative;
    const decimals = decodeDecimals(rd.configuration);
    const flags = decodeReserveFlags(rd.configuration);
    // total_supply() returns underlying units with the current index applied,
    // so no RAY/index math is needed on our side.
    const suppliedRaw = BigInt(
      (await readContract(server, rd.a_token_address, 'total_supply')) as number | bigint,
    );
    const borrowedRaw = BigInt(
      (await readContract(server, rd.debt_token_address, 'total_supply')) as number | bigint,
    );
    balances.push({ asset, decimals, flags, suppliedRaw, borrowedRaw });
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

  const admin = await fetchAdmin(horizonUrl, adminAddress);

  return {
    routerId,
    oracleId,
    oraclePriceDecimals: PRICE_DECIMALS,
    paused,
    admin,
    oracleConfig,
    reserves,
    fetchedAt,
  };
}
