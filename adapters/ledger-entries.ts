// Batched `getLedgerEntries` reads, shared by every adapter.
//
// WHY THIS EXISTS. Adapters used to issue one `getLedgerEntries` call per
// ledger key — one per Blend reserve pair, one per Aquarius reserve token, one
// per contract instance. Soroban RPC takes up to 200 keys in a single call, so
// that was N round trips buying what one buys. The shared public endpoint
// (mainnet.sorobanrpc.com) rate-limits on request RATE, which is the exact
// failure mode of the concurrency-2 incident in architecture/ — so the number
// of requests a cycle issues is a load-bearing quantity, not a micro-optimisation.
//
// NOTHING HERE DECODES. It hands back `xdr.LedgerEntryData` keyed by the key
// that produced it; what an entry MEANS, and what its absence means, stays in
// the adapter that asked for it. That split is what lets batching be a pure
// transport change: no adapter's raw shape moves.
//
// THREE ENDPOINT BEHAVIOURS THIS MODULE IS BUILT AROUND, each confirmed against
// https://mainnet.sorobanrpc.com on 2026-08-30 by POSTing hand-built
// `getLedgerEntries` requests (see MAX_LEDGER_KEYS_PER_CALL, `dedupeKeys` and
// `readLedgerEntries` for what each one forces):
//
//   1. 200 keys is the ceiling, and 201 is REFUSED rather than truncated.
//   2. A DUPLICATE key fails the whole call, opaquely.
//   3. A key with no entry on chain is OMITTED from the response — the response
//      is shorter than the request, with no placeholder marking which one went.
//
// (3) is why demultiplexing is by key and never by array position, and it is
// not a theoretical hazard: the very first mixed probe sent 6 keys and got 4
// entries back, so a positional read would have attributed the Blend pool's
// instance entry to a bogus address.

import { Address, xdr } from '@stellar/stellar-sdk';

/**
 * The most keys one `getLedgerEntries` call accepts.
 *
 * CONFIRMED EMPIRICALLY, not read off a doc page and not carried over from
 * another chain's RPC. Probed against https://mainnet.sorobanrpc.com on
 * 2026-08-30 with batches of randomly-generated contract-instance keys: 1, 50,
 * 100, 150, 190, 199 and 200 keys all returned `200 OK` with a well-formed
 * (empty) result, and 201, 250, 500 and 1000 each came back as a JSON-RPC error
 *
 *   -32602: key count (201) exceeds maximum supported (200)
 *
 * The distinction that mattered was whether the endpoint refuses or silently
 * truncates — a silent truncation would turn an over-sized batch into a set of
 * entries that merely LOOK absent, which is the one failure this module must
 * never produce. It refuses, loudly, with the limit in the message.
 *
 * The registry is nowhere near this today (the largest single batch any adapter
 * builds is a Blend pool's oracle instance plus two keys per reserve), so
 * chunking is a guard against a future registry rather than a live code path —
 * which is exactly why it is tested rather than assumed.
 */
export const MAX_LEDGER_KEYS_PER_CALL = 200;

/**
 * The identity a ledger key is demultiplexed by: its canonical base64 XDR.
 *
 * XDR encoding is canonical, so a key we built and the same key echoed back by
 * the RPC (parsed by the SDK, re-serialized here) produce byte-identical
 * strings — verified live before this module was written. That is what makes a
 * string map safe where `===` on the parsed object would not be.
 */
export function ledgerKeyId(key: xdr.LedgerKey): string {
  return key.toXDR('base64');
}

/** The ledger key for one entry in a contract's *persistent* contract-data storage. */
export function contractDataKey(contractId: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** The ledger key for a contract's *instance* entry (executable + instance storage). */
export function contractInstanceKey(contractId: string): xdr.LedgerKey {
  return contractDataKey(contractId, xdr.ScVal.scvLedgerKeyContractInstance());
}

/** One entry as the RPC returns it — narrowed to the two fields this module uses. */
export interface LedgerEntryResultLike {
  readonly key: xdr.LedgerKey;
  readonly val: xdr.LedgerEntryData;
}

/**
 * What `readLedgerEntries` needs of an RPC client.
 *
 * Structural rather than `rpc.Server`, so a test can supply a stand-in that
 * returns a chosen response — including the reordered, short and outright
 * failing ones that live data cannot be made to produce on demand. `rpc.Server`
 * satisfies it as-is; nothing is wrapped.
 */
export interface LedgerEntrySource {
  getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<{ entries: readonly LedgerEntryResultLike[] }>;
}

/**
 * A batch's results, addressed by the key that asked for them.
 *
 * There is deliberately NO index accessor and no array on this type. The class
 * exists so that "look the entry up by its key" is the only thing a caller can
 * express — positional access is not a discouraged option here, it is absent.
 *
 * `get` returning null for a key with no entry is the whole absence contract:
 * a key that does not exist on chain and a key that was never asked for are
 * indistinguishable, on purpose, because every adapter that reads an optional
 * entry (Aquarius's `UpgradeDeadline`/`FutureWASM`, an oracle's `BaseAssets`)
 * already had exactly one absence case to handle and must keep having one.
 */
export class LedgerEntries {
  private readonly byKey: ReadonlyMap<string, xdr.LedgerEntryData>;

  constructor(byKey: ReadonlyMap<string, xdr.LedgerEntryData>) {
    this.byKey = byKey;
  }

  /** The entry this key resolved to, or null when the RPC returned none for it. */
  get(key: xdr.LedgerKey): xdr.LedgerEntryData | null {
    return this.byKey.get(ledgerKeyId(key)) ?? null;
  }

  /** Did this key resolve to an entry? */
  has(key: xdr.LedgerKey): boolean {
    return this.byKey.has(ledgerKeyId(key));
  }

  /** How many entries came back — never assumed equal to how many keys were asked for. */
  get size(): number {
    return this.byKey.size;
  }
}

/**
 * Drop repeated keys, preserving first-seen order.
 *
 * NOT AN OPTIMISATION — a correctness requirement. Sending the same key twice
 * in one call fails the ENTIRE call on mainnet.sorobanrpc.com, and does it
 * opaquely: `[A]` and `[A, B]` both succeed, while `[A, A]` and `[A, B, A]`
 * both come back as
 *
 *   -32603: could not query captive core: http request failed with non-200
 *           status code (404)
 *
 * which names neither duplication nor a key. Batching is what makes duplicates
 * reachable at all — one call per key could not collide with itself — so the
 * dedupe has to sit here, at the point where several call sites' keys first
 * meet. A pool whose oracle instance is also read for its own sake, or a future
 * cross-target batch spanning two Aquarius pools that share a router, would
 * otherwise lose the whole call to a 404 that says nothing about why.
 *
 * Exported for `ledger-entries.test.ts`: this is the branch that cannot be
 * exercised from live data without deliberately breaking a live read.
 */
export function dedupeKeys(keys: readonly xdr.LedgerKey[]): xdr.LedgerKey[] {
  const seen = new Set<string>();
  const out: xdr.LedgerKey[] = [];
  for (const key of keys) {
    const id = ledgerKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

/** Split into groups of at most `size`, preserving order. */
export function chunkKeys(keys: readonly xdr.LedgerKey[], size: number): xdr.LedgerKey[][] {
  const out: xdr.LedgerKey[][] = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

/**
 * Read every key in one (or, past 200 keys, as few as possible) RPC call.
 *
 * FAILURE SEMANTICS, which are the reason this is not a three-line helper:
 *
 *   - A key with no entry on chain resolves to `null` from `LedgerEntries.get`.
 *     That is the same answer the caller got before batching, when a one-key
 *     call came back with `entries.length === 0`.
 *   - A call that FAILS — timeout, 429, malformed response — throws, and this
 *     function returns nothing at all. It never degrades a transport failure
 *     into "none of those keys exist", which would silently republish every
 *     optional-entry adapter path as its absent case and turn a run failure
 *     into a confident wrong reading. The indexer's per-target try/catch is
 *     where that throw belongs, exactly as before.
 *
 * Chunks are dispatched SEQUENTIALLY. Firing them concurrently would put back
 * the request burst that the concurrency-2 revert removed (architecture/); the
 * point of this module is fewer requests, not the same requests sooner.
 */
export async function readLedgerEntries(
  source: LedgerEntrySource,
  keys: readonly xdr.LedgerKey[],
): Promise<LedgerEntries> {
  const unique = dedupeKeys(keys);
  // No call at all for no keys: the RPC would accept an empty `keys` array, but
  // spending a round trip to learn nothing is the thing this module is against.
  if (unique.length === 0) return new LedgerEntries(new Map());

  const byKey = new Map<string, xdr.LedgerEntryData>();
  for (const group of chunkKeys(unique, MAX_LEDGER_KEYS_PER_CALL)) {
    const resp = await source.getLedgerEntries(...group);
    for (const entry of resp.entries ?? []) {
      // Keyed by the key the RPC ECHOES, never by this loop's position in the
      // request: absent keys are omitted from the response, so the two lists
      // are different lengths whenever anything is missing.
      byKey.set(ledgerKeyId(entry.key), entry.val);
    }
  }
  return new LedgerEntries(byKey);
}
