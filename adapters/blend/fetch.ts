// Everything that reads the chain: Soroban RPC + Horizon, the decoders that
// turn ScVal into this adapter's raw shape, and the oracle-legibility
// precondition that decides whether a pool is readable at all.
//
// Nothing here scores. `fetchBlendRawData` is the whole of what the adapter's
// `fetchRawData` does — it takes the target explicitly rather than reading it
// off an instance, so the pool it reads is always the pool it was handed.

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
  contractDataKey,
  contractInstanceKey,
  readLedgerEntries,
  type LedgerEntries,
  type LedgerEntrySource,
} from '../ledger-entries.ts';
import { horizonFetch, rateLimitedServer } from '../rate-limit.ts';
import { NETWORK_PASSPHRASE } from './types.ts';
import type {
  AssetConfigNative,
  BlendAdminRaw,
  BlendOracleConfigRaw,
  BlendRawData,
  BlendReserveRaw,
  HorizonAccount,
  HorizonOps,
  OracleConfigNative,
  PoolConfigNative,
  PriceDataNative,
  ReserveConfigNative,
  ReserveDataNative,
} from './types.ts';

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/**
 * Decode a contract *instance* entry's storage (Config, Admin, BaseAssets…)
 * into a name->ScVal map.
 *
 * Takes the already-read entry rather than fetching it: which keys this
 * adapter reads is decided in `fetchBlendRawData`, where they are collected and
 * dispatched together. A null entry is the same failure it always was — a
 * contract with no instance entry is not a pool we can read.
 */
function instanceStorage(
  entry: xdr.LedgerEntryData | null,
  contractId: string,
): Map<string, xdr.ScVal> {
  if (entry === null) {
    throw new Error(`Blend: no instance entry for contract ${contractId}`);
  }
  const instance = entry.contractData().val().instance();
  const storage = instance.storage() ?? [];
  const out = new Map<string, xdr.ScVal>();
  for (const storageEntry of storage) {
    const name = scValToNative(storageEntry.key());
    if (typeof name === 'string') out.set(name, storageEntry.val());
  }
  return out;
}

/** Read one contract's instance storage on its own — one key, so nothing to batch it with. */
async function readInstanceStorage(
  server: LedgerEntrySource,
  contractId: string,
): Promise<Map<string, xdr.ScVal>> {
  const key = contractInstanceKey(contractId);
  const entries = await readLedgerEntries(server, [key]);
  return instanceStorage(entries.get(key), contractId);
}

/**
 * The `ResConfig` persistent-storage key for one reserve of one pool.
 *
 * Exported, with `reserveDataKey` and `decodeReserve`, for `fetch.test.ts`: a
 * batch spanning two pools is the case keyed demultiplexing exists for, and it
 * cannot be produced from live data without registering a second pool.
 */
export function reserveConfigKey(poolId: string, asset: string): xdr.LedgerKey {
  return contractDataKey(
    poolId,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ResConfig'), new Address(asset).toScVal()]),
  );
}

/** The `ResData` persistent-storage key for one reserve of one pool. */
export function reserveDataKey(poolId: string, asset: string): xdr.LedgerKey {
  return contractDataKey(
    poolId,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('ResData'), new Address(asset).toScVal()]),
  );
}

/**
 * Pull one reserve's ResConfig + ResData out of an already-read batch and
 * normalize field names.
 *
 * EACH ENTRY IS FOUND BY ITS OWN KEY. The previous per-reserve version asked
 * for the two keys in one call and then told them apart by SNIFFING the decoded
 * value (`'b_rate' in native` meant ResData), because a two-entry response
 * carried no other way to say which was which. That sniff cannot survive
 * batching: a batch holds every reserve of the pool, so "the entry with a
 * b_rate in it" no longer identifies a reserve, only a shape. Keyed lookup
 * removes the question — the ResData key returns this asset's ResData or
 * nothing at all.
 */
export function decodeReserve(
  entries: LedgerEntries,
  poolId: string,
  asset: string,
): Omit<BlendReserveRaw, 'price' | 'priceConfig'> {
  const configEntry = entries.get(reserveConfigKey(poolId, asset));
  const dataEntry = entries.get(reserveDataKey(poolId, asset));
  if (configEntry === null || dataEntry === null) {
    throw new Error(`Blend: missing ResConfig/ResData for asset ${asset} in pool ${poolId}`);
  }
  const config = scValToNative(configEntry.contractData().val()) as unknown as ReserveConfigNative;
  const data = scValToNative(dataEntry.contractData().val()) as unknown as ReserveDataNative;

  return {
    asset,
    config: {
      decimals: Number(config.decimals),
      cFactor: BigInt(config.c_factor),
      lFactor: BigInt(config.l_factor),
      util: BigInt(config.util),
      maxUtil: BigInt(config.max_util),
      enabled: config.enabled !== false,
    },
    data: {
      dRate: BigInt(data.d_rate),
      bRate: BigInt(data.b_rate),
      bSupply: BigInt(data.b_supply),
      dSupply: BigInt(data.d_supply),
    },
  };
}

/** Simulate a read-only contract call and return the raw ScVal result. */
async function readContractScv(
  server: rpc.Server,
  contractId: string,
  method: string,
  ...args: xdr.ScVal[]
): Promise<xdr.ScVal> {
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
    throw new Error(`Blend: simulation of ${method} on ${contractId} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`Blend: ${method} on ${contractId} returned no value`);
  return retval;
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
    throw new Error(`Blend: simulation of ${method} on ${contractId} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`Blend: ${method} on ${contractId} returned no value`);
  return scValToNative(retval);
}

/** Oracle asset argument: Asset::Stellar(Address). */
function stellarAssetArg(asset: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(asset).toScVal()]);
}

async function readOraclePrice(
  server: rpc.Server,
  oracleId: string,
  asset: string,
): Promise<BlendReserveRaw['price']> {
  const native = (await readContract(
    server,
    oracleId,
    'lastprice',
    stellarAssetArg(asset),
  )) as PriceDataNative | null;
  // lastprice returns Option<PriceData>; None decodes to null/undefined.
  if (!native || native.price === undefined) return null;
  return {
    value: BigInt(native.price),
    timestamp: Number(native.timestamp),
  };
}

// ---------------------------------------------------------------------------
// The oracle-legibility precondition
//
// METHODOLOGY.md §2, "The oracle-legibility precondition". `oracleSafety` grades
// two things, and BOTH anchors are parameters the pool's own price path has to
// publish: the freshness window comes from `oracles()[i].resolution` and
// `max_age()`, and the deviation bound from per-asset `max_dev` in
// `asset_configs()`. Those three reads are Blend's oracle-aggregator interface —
// they are not in SEP-40, which defines no staleness tolerance and no deviation
// bound at all.
//
// Not every Blend V2 pool runs an aggregator. Four live ones do not (probed
// 2026-08-26 by reading each oracle's contract spec out of its wasm):
// Orbit's bridge oracle, Forex's proxy, Spectra PTs' deterministic zero-coupon
// pricer and Solv's SEP-40 feed registry. They are four DIFFERENT contracts with
// four different wasm hashes — not one "non-aggregator shape" — and they agree
// on exactly one thing: none of them answers any of the three reads below.
//
// WHY THIS IS A HARD PRECONDITION AND NOT A FALLBACK. There is no weaker anchor
// to fall back to, only fabricated ones:
//
//   - The nearest candidate is SEP-40's `resolution()`, a publish interval
//     rather than a staleness tolerance. Solv publishes `resolution() = 43200`
//     (12 hours, and owner-mutable via `set_resolution`). Fed to
//     `freshnessWindow` with no `max_age` it yields {fresh: 43200, dead: 86400},
//     because STALE_CEILING_SECONDS clamps `dead` and not `fresh`. Solv's
//     genuinely stale feeds — measured at 10,285s and 21,739s old on 2026-08-26
//     — would both publish priceFreshness 100.
//   - Two of the four price off the ledger clock, so freshness is 100 BY
//     CONSTRUCTION and can never be anything else. Spectra's oracle computes a
//     bond accretion (its `lastprice` ignores the asset argument outright), and
//     Orbit's dominant reserve — 99.5% of that pool's value — returns exactly
//     1.0 at current ledger time touching no upstream contract. On an aggregator
//     §2b excludes such base assets; Orbit's bridge publishes no `base()`, so
//     there is nothing to detect them with.
//
// A fabricated 100 is worse than a fabricated 0, and ground rule 4 forbids both.
// So the pool is not scored at all — published instead through
// dashboard/app/lib/coverage.ts as `oracle-not-gradable`, the same shape the
// market-size floor uses one level up.
// ---------------------------------------------------------------------------

/**
 * The three reads METHODOLOGY.md §2 grades `oracleSafety` against.
 *
 * Deliberately the grading reads only. `decimals()` and `lastprice()` are NOT
 * here: the other four factors need exactly those two and nothing else
 * (`suppliedUsd` prices reserves for §1 and for §4/§5's size filter), and every
 * oracle behind a V2 pool answers both. This precondition is about the two
 * anchors §2 needs, not about whether a pool can be read at all.
 */
export const ORACLE_GRADING_READS = ['max_age', 'oracles', 'asset_configs'] as const;

export type OracleGradingRead = (typeof ORACLE_GRADING_READS)[number];

/** Which of the §2 grading reads this oracle actually answered. */
export type OracleGradingReads = Record<OracleGradingRead, boolean>;

/**
 * Does this failure mean the contract has no such function, as opposed to
 * anything else that can go wrong on the way to it?
 *
 * The distinction is load-bearing and is the reason this is a named function
 * rather than a bare catch. "This oracle publishes no `max_age`" is a permanent
 * property of the deployed contract and a verdict on scorability. A timeout, a
 * 429 from the shared public RPC, or a malformed response is a transient RUN
 * failure. Treating the second as the first would let one bad five-minute cycle
 * declare a pool ungradable; treating the first as the second would retry a
 * call that can never succeed until the cycle budget ran out.
 *
 * Matched on both halves of what the host actually returns — the error code and
 * the diagnostic phrase, plus the method name — so a message that merely
 * contains the word "MissingValue" for some other reason does not qualify.
 * Sample, captured from mainnet on 2026-08-26:
 *
 *   HostError: Error(WasmVm, MissingValue)
 *   … topics:[error, Error(WasmVm, MissingValue)], data:["trying to invoke
 *   non-existent contract function", max_age]
 */
export function isMissingContractFunction(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Error(WasmVm, MissingValue)') &&
    message.includes('trying to invoke non-existent contract function') &&
    message.includes(method)
  );
}

/**
 * The precondition itself: null when this oracle can be graded, and the run's
 * failure message when it cannot.
 *
 * A MESSAGE RATHER THAN A SCORE, deliberately, and rather than an Error subclass
 * — the indexer records `error.message` on a failed run, and a subclass's `name`
 * is a runtime identifier the dashboard's bundler would rename in production
 * (see ProtocolMetadata.adapterRef for the bug that rule comes from).
 *
 * It names every missing read rather than only the first, because "this oracle
 * is not an aggregator" is one fact and reporting it one method per cycle would
 * make it look like three separate problems.
 */
export function oracleNotGradable(oracleId: string, answered: OracleGradingReads): string | null {
  const missing = ORACLE_GRADING_READS.filter((read) => !answered[read]);
  if (missing.length === 0) return null;
  return (
    `Blend: oracle ${oracleId} publishes no ${missing.join('(), no ')}(), so this pool ` +
    'fails the oracle-legibility precondition (METHODOLOGY.md §2) and is not scorable — ' +
    'oracleSafety has no on-chain anchor for either price staleness or deviation, and ' +
    'inventing one would publish a confident number from no data. Such a market belongs ' +
    'in coverage.ts as `oracle-not-gradable`, not in BLEND_POOLS.'
  );
}

/** Sentinel for a grading read the contract does not implement. */
const ABSENT = Symbol('absent');

/**
 * Run one §2 grading read, turning "no such function" into ABSENT and letting
 * every other failure escape as the run failure it is. See
 * `isMissingContractFunction` for why those two must not be conflated.
 */
async function gradingRead<T>(
  method: OracleGradingRead,
  run: () => Promise<T>,
): Promise<T | typeof ABSENT> {
  try {
    return await run();
  } catch (error) {
    if (isMissingContractFunction(error, method)) return ABSENT;
    throw error;
  }
}

/**
 * Read the oracle aggregator's own published config: the upstream feeds it
 * reads (`oracles()`) and the age beyond which it refuses a price (`max_age()`).
 *
 * These are the anchors `oracleSafety` grades freshness against — the
 * aggregator's numbers, not Stenion constants.
 *
 * `max_age()` and `oracles()` are passed in already-read rather than fetched
 * here, because they are two of the three reads the oracle-legibility
 * precondition probes: fetching them here as well would either double the RPC
 * calls or make the precondition unable to say which read was missing.
 *
 * `instance` arrives the same way, and for the batching reason rather than the
 * precondition one: the oracle's instance key travels in the same
 * `getLedgerEntries` call as every reserve's ResConfig/ResData, so it is read
 * before this function is reached rather than by it.
 */
async function readOracleConfig(
  server: rpc.Server,
  oracleId: string,
  maxAgeNative: unknown,
  oraclesNative: unknown,
  instance: Map<string, xdr.ScVal>,
): Promise<BlendOracleConfigRaw> {
  const maxAge = Number(maxAgeNative as number | bigint);
  const oracles = oraclesNative as OracleConfigNative[];
  if (!Array.isArray(oracles) || oracles.length === 0) {
    throw new Error(`Blend: oracle ${oracleId} returned an empty oracles() list`);
  }

  // `base()` is a public read; the `BaseAssets` list has no getter, so it comes
  // from instance storage. Older aggregator deployments have no BaseAssets key
  // at all — the contract treats that as an empty list, and so do we.
  const baseAssets = new Set<string>();
  const base = (await readContract(server, oracleId, 'base')) as unknown;
  if (Array.isArray(base) && base[0] === 'Stellar' && typeof base[1] === 'string') {
    baseAssets.add(base[1]);
  }
  const baseAssetsScv = instance.get('BaseAssets');
  if (baseAssetsScv) {
    for (const entry of (scValToNative(baseAssetsScv) as unknown[]) ?? []) {
      if (Array.isArray(entry) && entry[0] === 'Stellar' && typeof entry[1] === 'string') {
        baseAssets.add(entry[1]);
      }
    }
  }

  return {
    maxAge,
    baseAssets: [...baseAssets],
    oracles: oracles.map((o) => ({
      index: Number(o.index),
      address: o.address,
      resolution: Number(o.resolution),
      decimals: Number(o.decimals),
    })),
  };
}

/**
 * Decode `asset_configs()` keyed by reserve address.
 *
 * Decoded from the raw ScVal map rather than via `scValToNative` on the whole
 * value: the map's keys are `Asset` enum vecs, and letting the SDK coerce those
 * into JS object keys would make us depend on its stringification of a
 * non-string key. Decoding each key on its own keeps the mapping explicit.
 *
 * Takes the already-read ScVal rather than fetching, for the same reason
 * `readOracleConfig` does: `asset_configs` is one of the three reads the
 * oracle-legibility precondition probes.
 */
function decodeAssetConfigs(
  scv: xdr.ScVal,
): Map<string, NonNullable<BlendReserveRaw['priceConfig']>> {
  const out = new Map<string, NonNullable<BlendReserveRaw['priceConfig']>>();
  for (const entry of scv.map() ?? []) {
    const key = scValToNative(entry.key()) as unknown;
    // Reserve keys are Asset::Stellar(Address) -> ['Stellar', 'C…'].
    if (!Array.isArray(key) || key[0] !== 'Stellar' || typeof key[1] !== 'string') continue;
    const cfg = scValToNative(entry.val()) as AssetConfigNative;
    const upstream = cfg.asset;
    out.set(key[1], {
      upstreamAsset: Array.isArray(upstream) ? `${upstream[0]}:${upstream[1]}` : 'unknown',
      oracleIndex: Number(cfg.oracle_index),
      maxDev: Number(cfg.max_dev),
    });
  }
  return out;
}

async function fetchAdmin(horizonUrl: string, address: string): Promise<BlendAdminRaw> {
  const isContract = address.startsWith('C');
  if (isContract) {
    // Contract-governed admin: Horizon has no account entry to introspect. We record
    // the fact honestly rather than fabricating signer/activity data for it.
    return { address, isContract: true, account: null };
  }

  const windowDays = 30;
  const acctResp = await horizonFetch(`${horizonUrl}/accounts/${address}`);
  if (!acctResp.ok) {
    throw new Error(
      `Blend: Horizon account fetch for admin ${address} failed (${acctResp.status})`,
    );
  }
  const acct = (await acctResp.json()) as HorizonAccount;

  const opsResp = await horizonFetch(
    `${horizonUrl}/accounts/${address}/operations?order=desc&limit=200`,
  );
  if (!opsResp.ok) {
    throw new Error(`Blend: Horizon ops fetch for admin ${address} failed (${opsResp.status})`);
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
// The fetch itself
// ---------------------------------------------------------------------------

/**
 * Read one Blend pool into `BlendRawData`.
 *
 * Target is a parameter, not instance state: `poolId` is the only pool this
 * reads, and the caller that supplies it is the same one that publishes the
 * identity built from it, so the two cannot drift.
 */
export async function fetchBlendRawData(target: {
  rpcUrl: string;
  horizonUrl: string;
  poolId: string;
}): Promise<BlendRawData> {
  const { rpcUrl, horizonUrl, poolId } = target;
  // Rate-limit retry lives in the server wrapper, so every RPC read below gets
  // it without a call site knowing. See ../rate-limit.ts.
  const server = rateLimitedServer(rpcUrl);

  // Pool instance storage → Config (oracle, status) and Admin.
  const instance = await readInstanceStorage(server, poolId);
  const configScv = instance.get('Config');
  const adminScv = instance.get('Admin');
  if (!configScv) throw new Error(`Blend: pool ${poolId} has no Config in instance storage`);
  const poolConfig = scValToNative(configScv) as PoolConfigNative;
  const oracleId: string = poolConfig.oracle;
  const status = Number(poolConfig.status);
  const minCollateral =
    poolConfig.min_collateral === undefined ? 0n : BigInt(poolConfig.min_collateral);
  const adminAddress: string = adminScv
    ? (scValToNative(adminScv) as string)
    : (poolConfig.admin ?? '');

  // Reserve list is a public read method on the V2 pool.
  const reserveList = (await readContract(server, poolId, 'get_reserve_list')) as string[];
  if (!Array.isArray(reserveList) || reserveList.length === 0) {
    throw new Error(`Blend: pool ${poolId} returned an empty reserve list`);
  }

  const oracleDecimals = Number(await readContract(server, oracleId, 'decimals'));

  // The oracle-legibility precondition (METHODOLOGY.md §2). Probed BEFORE
  // anything is built from these reads, so a pool whose oracle cannot be
  // graded fails as one clean, explanatory run failure naming every missing
  // read — rather than as a raw `HostError: Error(WasmVm, MissingValue)` from
  // whichever call happened to go first.
  //
  // No extra RPC in the happy path: an aggregator answers all three, and these
  // are the same three calls the adapter always made.
  const maxAgeNative = await gradingRead('max_age', () =>
    readContract(server, oracleId, 'max_age'),
  );
  const oraclesNative = await gradingRead('oracles', () =>
    readContract(server, oracleId, 'oracles'),
  );
  const assetConfigsScv = await gradingRead('asset_configs', () =>
    readContractScv(server, oracleId, 'asset_configs'),
  );
  const notGradable = oracleNotGradable(oracleId, {
    max_age: maxAgeNative !== ABSENT,
    oracles: oraclesNative !== ABSENT,
    asset_configs: assetConfigsScv !== ABSENT,
  });
  if (notGradable) throw new Error(notGradable);

  // EVERY REMAINING LEDGER KEY, IN ONE CALL. The oracle's instance entry and
  // both persistent entries of every reserve are independent reads of the same
  // ledger, so they go out together rather than as 1 + 2N round trips against
  // an endpoint that rate-limits on request count. Nothing about WHEN they are
  // read changes what they say: a `getLedgerEntries` call is a snapshot of one
  // ledger either way, and reading them together is if anything more coherent
  // than reading them across N ledgers.
  //
  // Deliberately after the precondition throw, so a pool whose oracle cannot be
  // graded still costs the same reads it did before — the failure path did not
  // get more expensive to make the happy path cheaper.
  const oracleInstanceKey = contractInstanceKey(oracleId);
  const entries = await readLedgerEntries(server, [
    oracleInstanceKey,
    ...reserveList.flatMap((asset) => [
      reserveConfigKey(poolId, asset),
      reserveDataKey(poolId, asset),
    ]),
  ]);

  // Past the precondition, none of the three can still be ABSENT — that is
  // exactly what `oracleNotGradable` returning null means. The cast records
  // the invariant the compiler cannot carry across the throw above; the other
  // two are already `unknown` and are narrowed inside readOracleConfig.
  const oracleConfig = await readOracleConfig(
    server,
    oracleId,
    maxAgeNative,
    oraclesNative,
    instanceStorage(entries.get(oracleInstanceKey), oracleId),
  );
  const assetConfigs = decodeAssetConfigs(assetConfigsScv as xdr.ScVal);

  const reserves: BlendReserveRaw[] = [];
  for (const asset of reserveList) {
    const base = decodeReserve(entries, poolId, asset);
    const price = await readOraclePrice(server, oracleId, asset);
    reserves.push({ ...base, price, priceConfig: assetConfigs.get(asset) ?? null });
  }

  const admin = await fetchAdmin(horizonUrl, adminAddress);

  return {
    poolId,
    oracleId,
    oracleDecimals,
    status,
    minCollateral,
    admin,
    oracleConfig,
    reserves,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
