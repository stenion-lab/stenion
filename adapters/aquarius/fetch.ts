// Everything that reads the chain for Aquarius: Soroban RPC + Horizon, and the
// decoders that turn ScVal into this adapter's raw shape.
//
// Nothing here scores. `fetchAquariusRawData` is the whole of what the
// adapter's `fetchRawData` does — it takes the target explicitly rather than
// reading it off an instance, so the pool it reads is always the pool it was
// handed.
//
// THE FAILURE POLICY, because it is the part that is easy to get subtly wrong.
// Adapters throw and the indexer records a failed run — that is the rule for a
// WHOLE-ENDPOINT outage: RPC unreachable, Horizon down, nothing decodes. But
// `methodology/dex.md` also requires that a LOCALIZED failure (one role, one
// issuer, one call that reverted) reach scoring as a reading that resolves to
// the unsafe end, not as a thrown cycle. So those are captured into tagged
// unions on the raw shape — `AquariusRolesRead`, `AquariusIssuerRead` — with
// the reason attached, and nothing is swallowed into a generic "fetch failed".
// The distinction is what stops a blip in our own network path publishing
// "dangerous admin control" across every pool at once.

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
  AQUARIUS_POOL_TYPES,
  AQUARIUS_ROLES,
  AQUARIUS_ROUTER_ID,
  NETWORK_PASSPHRASE,
} from './types.ts';
import type {
  AquariusIssuerRead,
  AquariusKillFlagsRaw,
  AquariusPoolType,
  AquariusRawData,
  AquariusRoleRaw,
  AquariusRolesRead,
  AquariusRouterRaw,
  AquariusTokenRaw,
  AquariusUpgradeRaw,
  HorizonAccount,
  HorizonOps,
} from './types.ts';

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

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
    throw new Error(`Aquarius: simulation of ${method} on ${contractId} failed: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`Aquarius: ${method} on ${contractId} returned no value`);
  return scValToNative(retval);
}

/**
 * A contract's instance entry: its executable and its instance storage.
 *
 * Returns null when the contract has no instance entry at all, which is a real
 * reading about the address rather than an error — the caller decides what it
 * means, because it means different things for a pool and for a token.
 */
async function readInstance(
  server: rpc.Server,
  contractId: string,
): Promise<{
  executableType: string;
  runningWasm: string | null;
  storage: Map<string, xdr.ScVal>;
} | null> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const resp = await server.getLedgerEntries(key);
  if (resp.entries.length === 0) return null;

  const instance = resp.entries[0].val.contractData().val().instance();
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of instance.storage() ?? []) {
    const name = instanceKeyName(entry.key());
    if (name !== null) storage.set(name, entry.val());
  }

  const executable = instance.executable();
  let runningWasm: string | null = null;
  try {
    runningWasm = Buffer.from(executable.wasmHash()).toString('hex');
  } catch {
    // A Stellar Asset Contract has no wasm hash — a real reading, not an error.
    runningWasm = null;
  }
  return { executableType: executable.switch().name, runningWasm, storage };
}

/**
 * The name an instance-storage entry is filed under.
 *
 * **AQUARIUS KEYS INSTANCE STORAGE WITH VEC-WRAPPED ENUM VARIANTS, NOT BARE
 * SYMBOLS**, and getting this wrong is not a decode nit — it silently empties
 * the map. A soroban `#[contracttype] enum DataKey` serializes a unit variant
 * `UpgradeDeadline` as `scvVec([scvSymbol("UpgradeDeadline")])`, which
 * `scValToNative` hands back as the ARRAY `["UpgradeDeadline"]`. An earlier
 * version of this function kept an entry only `if (typeof name === 'string')`
 * and therefore discarded **every** entry on **every** Aquarius contract —
 * reading 31 router entries and 33–40 pool entries as zero, and reporting
 * `UpgradeDeadline` as unreadable when it is sitting right there at `0n`.
 *
 * The failure mode is what makes this comment long: an over-strict filter here
 * produces an EMPTY map rather than an error, so it looks exactly like a
 * contract that stores nothing. Both shapes are accepted, and a compound key
 * (`["Balance", address]`, which `get_reserves` reads) is joined with `:` so it
 * is addressable rather than colliding with its own variant name.
 */
export function instanceKeyName(key: xdr.ScVal): string | null {
  const native = scValToNative(key);
  if (typeof native === 'string') return native;
  if (Array.isArray(native) && typeof native[0] === 'string') {
    return native.length === 1 ? native[0] : native.map((p) => String(p)).join(':');
  }
  return null;
}

/**
 * The executable discriminant that identifies a Stellar Asset Contract.
 *
 * Exported so `fetch.test.ts` pins the exact string rather than restating it —
 * the whole SAC/wasm split turns on this one comparison, and a typo in it would
 * silently route all 196 SAC tokens down the wasm disclosure path.
 */
export const STELLAR_ASSET_EXECUTABLE = 'contractExecutableStellarAsset';

// ---------------------------------------------------------------------------
// Pending upgrades
// ---------------------------------------------------------------------------

/**
 * Read a contract's pending-upgrade state out of instance storage.
 *
 * Both keys live in the contract's INSTANCE storage under vec-wrapped enum
 * variants — `scvVec(["UpgradeDeadline"])` — which is why `instanceKeyName`
 * exists and why getting that decode wrong made this whole signal look absent.
 * Confirmed live on 2026-08-29 across the router and pools of all three types;
 * a simulation footprint for `get_privileged_addrs()` reads *only* the instance
 * entry, which is independent proof the data is there rather than under a key
 * of its own.
 *
 * WHAT PENDING MEANS. `commit_upgrade` writes a deadline and `apply_upgrade`
 * refuses until it passes, so a non-zero `UpgradeDeadline` is the open reaction
 * window — exactly how long an LP has to withdraw before the code under their
 * money changes, anchored with no Stenion constant in it. A `0n` deadline is a
 * READ VALUE meaning no upgrade is scheduled, not a missing entry, and the two
 * are kept distinguishable: `deadline: null` is "no such entry", `0n` is "the
 * contract says none pending".
 *
 * `stagedDiffers` is carried beside it because the two are not the same
 * question. Every contract read on 2026-08-29 carried a `FutureWASM` equal to
 * its OWN running hash — staged code identical to live code, i.e. nothing
 * staged — so a `FutureWASM` naming anything else is the signal, not its mere
 * presence.
 *
 * The DURATION of the window remains unreadable: `ADMIN_ACTIONS_DELAY` is a
 * compile-time constant confirmed absent from all four deployed wasms, and
 * there is no `get_upgrade_deadline`/`get_future_wasm` getter. That stays a
 * route-(a) `value: null` disclosure — see methodology/dex.md.
 */
function readUpgrade(
  instance: { runningWasm: string | null; storage: Map<string, xdr.ScVal> } | null,
): AquariusUpgradeRaw {
  const storage = instance?.storage ?? new Map<string, xdr.ScVal>();

  const deadlineScv = storage.get('UpgradeDeadline');
  const deadline =
    deadlineScv === undefined
      ? null
      : BigInt(scValToNative(deadlineScv) as string | number | bigint);

  const wasmScv = storage.get('FutureWASM');
  const futureWasm = wasmScv === undefined ? null : describeWasmHash(scValToNative(wasmScv));
  const runningWasm = instance?.runningWasm ?? null;

  return {
    deadline,
    futureWasm,
    runningWasm,
    pending: deadline !== null && deadline > 0n,
    stagedDiffers: futureWasm !== null && runningWasm !== null && futureWasm !== runningWasm,
  };
}

/** A staged wasm hash arrives as bytes; render it hex, or null when it is not a hash. */
function describeWasmHash(value: unknown): string | null {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'string') return value;
  return null;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Decode `get_privileged_addrs()` into the role list.
 *
 * The contract returns `Map<Symbol, Vec<Address>>` — a role maps to a LIST of
 * addresses, not to one. Every role currently holds exactly one, but the
 * contract's own type permits several, and flattening to `[0]` would silently
 * drop a co-holder the day one is added.
 *
 * Exported for `fetch.test.ts`: this decode has to survive a short map and a
 * malformed one, and neither case can be produced from live data.
 */
export function decodeRoles(native: unknown): AquariusRolesRead {
  if (native === null || typeof native !== 'object' || Array.isArray(native)) {
    return {
      status: 'failed',
      reason: `get_privileged_addrs() returned ${native === null ? 'null' : typeof native}, not a role map`,
    };
  }

  const entries = Object.entries(native as Record<string, unknown>);
  const roles: AquariusRoleRaw[] = [];
  for (const [role, value] of entries) {
    // A single Address decodes to a bare string; tolerate it rather than
    // dropping the role, because losing a role silently is the one outcome
    // worse than reporting an unexpected shape.
    const addresses = Array.isArray(value)
      ? value.filter((a): a is string => typeof a === 'string')
      : typeof value === 'string'
        ? [value]
        : [];
    roles.push({ role, addresses, accounts: [] });
  }

  const seen = new Set(roles.map((r) => r.role));
  const missing = AQUARIUS_ROLES.filter((r) => !seen.has(r));
  if (missing.length > 0) return { status: 'short', roles, missing: [...missing] };
  return { status: 'read', roles };
}

/** Read one privileged account's Horizon posture. */
async function readRoleAccount(
  horizonUrl: string,
  address: string,
): Promise<AquariusRoleRaw['accounts'][number]> {
  // A contract-held role has no Horizon account entry to introspect. Recorded
  // honestly rather than fabricated — see AquariusRoleRaw.accounts.
  if (address.startsWith('C')) return { status: 'contract', address };

  const windowDays = 30;
  try {
    const acctResp = await fetch(`${horizonUrl}/accounts/${address}`);
    if (!acctResp.ok) {
      return {
        status: 'failed',
        address,
        reason: `Horizon account fetch returned ${acctResp.status}`,
      };
    }
    const acct = (await acctResp.json()) as HorizonAccount;

    const opsResp = await fetch(
      `${horizonUrl}/accounts/${address}/operations?order=desc&limit=200`,
    );
    if (!opsResp.ok) {
      return { status: 'failed', address, reason: `Horizon ops fetch returned ${opsResp.status}` };
    }
    const opsBody = (await opsResp.json()) as HorizonOps;
    const records = opsBody?._embedded?.records ?? [];
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const recentOps = records.filter((r) => {
      const t = Date.parse(r.created_at);
      return Number.isFinite(t) && t >= cutoff;
    }).length;

    return {
      status: 'read',
      address,
      account: {
        highThreshold: Number(acct.thresholds?.high_threshold ?? 0),
        signerCount: Array.isArray(acct.signers) ? acct.signers.length : 0,
        recentOps,
        activityWindowDays: windowDays,
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      address,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read the role map from one contract, then fill in each holder's Horizon posture. */
async function readRoles(
  server: rpc.Server,
  horizonUrl: string,
  contractId: string,
  accountCache: Map<string, AquariusRoleRaw['accounts'][number]>,
): Promise<AquariusRolesRead> {
  let decoded: AquariusRolesRead;
  try {
    decoded = decodeRoles(await readContract(server, contractId, 'get_privileged_addrs'));
  } catch (error) {
    // A revert here is a READING about the pool — "we could not read who
    // controls this" — which methodology/dex.md sends to the unsafe end. It is
    // not a run failure, so it is captured rather than rethrown.
    return {
      status: 'failed',
      reason: `get_privileged_addrs() on ${contractId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (decoded.status === 'failed') return decoded;

  for (const role of decoded.roles) {
    for (const address of role.addresses) {
      // Cached across the router and the pool within one fetch: the two report
      // the same seven accounts today, and reading each one twice would double
      // the Horizon cost of every pool to re-learn the same answer. The CACHE is
      // per-fetch and per-address — it never assumes the router's roles ARE the
      // pool's, which is the assumption AquariusRawData.roles exists to avoid.
      const cached = accountCache.get(address);
      const account = cached ?? (await readRoleAccount(horizonUrl, address));
      accountCache.set(address, account);
      role.accounts.push(account);
    }
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Reserve tokens
// ---------------------------------------------------------------------------

/**
 * Split a SAC's metadata name into asset code and issuer.
 *
 * Native XLM's name is the bare string `native` — it is a SAC with NO issuer
 * account, which is a different fact from "not a SAC" and from "we could not
 * read the issuer". Everything else is `CODE:ISSUER`.
 *
 * Exported for `fetch.test.ts`, which pins the `native` case: it is the single
 * most common token in the registry and the one a naive `CODE:ISSUER` split
 * gets wrong.
 */
export function parseAssetName(name: string): { code: string; issuer: string | null } | null {
  if (name === 'native') return { code: 'XLM', issuer: null };
  const colon = name.indexOf(':');
  if (colon <= 0) return null;
  const code = name.slice(0, colon);
  const issuer = name.slice(colon + 1);
  if (!issuer.startsWith('G')) return null;
  return { code, issuer };
}

/** Read an issuing account's flags from Horizon. */
async function readIssuerFlags(horizonUrl: string, issuer: string): Promise<AquariusIssuerRead> {
  try {
    const resp = await fetch(`${horizonUrl}/accounts/${issuer}`);
    if (!resp.ok) {
      // The token IS a SAC, so the read APPLIES and did not happen — the unsafe
      // end, never the wasm route-(a) disclosure. Conflating the two would
      // silently upgrade an unknown into an exemption.
      return {
        status: 'failed',
        issuer,
        reason: `Horizon issuer fetch returned ${resp.status}`,
      };
    }
    const acct = (await resp.json()) as HorizonAccount;
    return {
      status: 'read',
      issuer,
      flags: {
        authRequired: acct.flags?.auth_required === true,
        authRevocable: acct.flags?.auth_revocable === true,
        authImmutable: acct.flags?.auth_immutable === true,
        authClawbackEnabled: acct.flags?.auth_clawback_enabled === true,
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      issuer,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read one reserve token: what kind of contract it is, and who can control it. */
async function readToken(
  server: rpc.Server,
  horizonUrl: string,
  address: string,
): Promise<AquariusTokenRaw> {
  const instance = await readInstance(server, address);
  const isStellarAsset = instance?.executableType === STELLAR_ASSET_EXECUTABLE;

  let code: string | null = null;
  let symbol: string | null = null;
  let decimals: number | null = null;
  let issuer: AquariusIssuerRead = {
    status: 'failed',
    issuer: null,
    reason: `no contract instance entry for token ${address}`,
  };

  const metadataScv = instance?.storage.get('METADATA');
  const metadata =
    metadataScv === undefined
      ? null
      : (scValToNative(metadataScv) as { name?: string; symbol?: string; decimal?: number });
  if (metadata) {
    symbol = typeof metadata.symbol === 'string' ? metadata.symbol : null;
    decimals = typeof metadata.decimal === 'number' ? metadata.decimal : null;
  }

  if (!isStellarAsset) {
    // A wasm token has no issuer-flag equivalent. Route (a) — a disclosure, not
    // a zero and not a pass. Nine of the 205 distinct pool tokens are these.
    issuer = { status: 'notApplicable', reason: 'wasm-contract' };
    code = symbol;
  } else if (metadata && typeof metadata.name === 'string') {
    const parsed = parseAssetName(metadata.name);
    if (parsed === null) {
      issuer = {
        status: 'failed',
        issuer: null,
        reason: `SAC metadata name ${JSON.stringify(metadata.name)} is neither 'native' nor CODE:ISSUER`,
      };
    } else if (parsed.issuer === null) {
      // Native XLM: a SAC with no issuer account, so nothing can freeze or claw
      // it back. A POSITIVE fact, not an absent reading — see AquariusIssuerRead.
      code = parsed.code;
      issuer = { status: 'noIssuer', asset: 'native' };
    } else {
      code = parsed.code;
      issuer = await readIssuerFlags(horizonUrl, parsed.issuer);
    }
  }

  return { address, isStellarAsset, code, decimals, symbol, issuer };
}

// ---------------------------------------------------------------------------
// Pool type
// ---------------------------------------------------------------------------

/**
 * Narrow `pool_type()` to one of the three the router can deploy.
 *
 * Returns null for anything else rather than guessing. Aquarius's router can
 * only deploy the three wasm hashes it declares, so reaching that branch means
 * the pool is running code this adapter was never read against — the same
 * situation `BlendAdapter` handles for a status outside 0–6, and the same
 * response: claim nothing about it.
 *
 * Exported for `fetch.test.ts`; the rejecting branch cannot be produced live.
 */
export function asPoolType(value: unknown): AquariusPoolType | null {
  return typeof value === 'string' && (AQUARIUS_POOL_TYPES as readonly string[]).includes(value)
    ? (value as AquariusPoolType)
    : null;
}

/** The run-failure message for a pool whose type this adapter does not know. */
export function unrecognisedPoolType(poolId: string, value: unknown): string {
  return (
    `Aquarius: pool ${poolId} reports pool_type() = ${JSON.stringify(value)}, which is none of ` +
    `${AQUARIUS_POOL_TYPES.join(', ')}. This adapter was read against those three wasm hashes ` +
    'only, so nothing is claimed about this pool rather than guessing which curve it runs.'
  );
}

// ---------------------------------------------------------------------------
// The fetch itself
// ---------------------------------------------------------------------------

/** Read the protocol-wide router state shared by every pool. */
async function fetchRouter(
  server: rpc.Server,
  horizonUrl: string,
  accountCache: Map<string, AquariusRoleRaw['accounts'][number]>,
): Promise<AquariusRouterRaw> {
  const instance = await readInstance(server, AQUARIUS_ROUTER_ID);
  const [contractName, version, emergencyMode] = await Promise.all([
    readContract(server, AQUARIUS_ROUTER_ID, 'contract_name'),
    readContract(server, AQUARIUS_ROUTER_ID, 'version'),
    readContract(server, AQUARIUS_ROUTER_ID, 'get_emergency_mode'),
  ]);

  return {
    routerId: AQUARIUS_ROUTER_ID,
    contractName: String(contractName),
    version: Number(version),
    emergencyMode: emergencyMode === true,
    roles: await readRoles(server, horizonUrl, AQUARIUS_ROUTER_ID, accountCache),
    upgrade: readUpgrade(instance),
  };
}

/**
 * Read one Aquarius pool into `AquariusRawData`.
 *
 * Target is a parameter, not instance state: `poolId` is the only pool this
 * reads, and the caller that supplies it is the same one that publishes the
 * identity built from it, so the two cannot drift.
 */
export async function fetchAquariusRawData(target: {
  rpcUrl: string;
  horizonUrl: string;
  poolId: string;
}): Promise<AquariusRawData> {
  const { rpcUrl, horizonUrl, poolId } = target;
  const server = new rpc.Server(rpcUrl);

  // Shared across the router and this pool for the duration of ONE fetch. See
  // readRoles for why this is safe and what it deliberately does not assume.
  const accountCache = new Map<string, AquariusRoleRaw['accounts'][number]>();

  // Pool type first: everything after it is interpreted through it, and a pool
  // running unknown code should fail before any of it is read rather than after.
  const poolTypeNative = await readContract(server, poolId, 'pool_type');
  const poolType = asPoolType(poolTypeNative);
  if (poolType === null) throw new Error(unrecognisedPoolType(poolId, poolTypeNative));

  const instance = await readInstance(server, poolId);

  // Kill flags and emergency mode go through the GETTERS, never instance
  // storage — see AquariusKillFlagsRaw for the three reasons.
  const [
    tokensNative,
    reservesNative,
    totalSharesNative,
    feeNative,
    protocolFeeNative,
    killedSwap,
    killedDeposit,
    killedClaim,
    emergencyMode,
    infoNative,
    shareIdNative,
    versionNative,
  ] = await Promise.all([
    readContract(server, poolId, 'get_tokens'),
    readContract(server, poolId, 'get_reserves'),
    readContract(server, poolId, 'get_total_shares'),
    readContract(server, poolId, 'get_fee_fraction'),
    readContract(server, poolId, 'get_protocol_fee_fraction'),
    readContract(server, poolId, 'get_is_killed_swap'),
    readContract(server, poolId, 'get_is_killed_deposit'),
    readContract(server, poolId, 'get_is_killed_claim'),
    readContract(server, poolId, 'get_emergency_mode'),
    readContract(server, poolId, 'get_info'),
    readContract(server, poolId, 'share_id'),
    readContract(server, poolId, 'version'),
  ]);

  const tokens = Array.isArray(tokensNative)
    ? tokensNative.filter((t): t is string => typeof t === 'string')
    : [];
  if (tokens.length === 0) {
    throw new Error(`Aquarius: pool ${poolId} returned an empty token list`);
  }
  // Arity comes from get_tokens(), never from an assumed pair — three of the
  // 304 token sets have three members. See AquariusRawData.tokens.
  const reserves = (Array.isArray(reservesNative) ? reservesNative : []).map((r) => BigInt(r));

  const killed: AquariusKillFlagsRaw = {
    swap: killedSwap === true,
    deposit: killedDeposit === true,
    claim: killedClaim === true,
  };

  const reserveTokens: AquariusTokenRaw[] = [];
  for (const address of tokens) {
    reserveTokens.push(await readToken(server, horizonUrl, address));
  }

  const roles = await readRoles(server, horizonUrl, poolId, accountCache);
  const upgrade = readUpgrade(instance);
  const router = await fetchRouter(server, horizonUrl, accountCache);

  return {
    poolId,
    poolType,
    tokens,
    reserves,
    totalShares: BigInt(totalSharesNative as string | number | bigint),
    feeFraction: Number(feeNative),
    protocolFeeFraction: Number(protocolFeeNative),
    info: infoNative as Record<string, string | number | bigint>,
    shareId: String(shareIdNative),
    version: Number(versionNative),
    killed,
    emergencyMode: emergencyMode === true,
    roles,
    upgrade,
    reserveTokens,
    router,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
