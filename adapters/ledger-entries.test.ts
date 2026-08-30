// Tests for ./ledger-entries.ts — the transport contract every adapter's reads
// now go through.
//
// No network. The whole point of `LedgerEntrySource` being a structural
// interface is that the three responses that matter here cannot be conjured
// from mainnet on demand: a batch that comes back SHORT because a key has no
// entry, a batch that comes back REORDERED, and a batch that does not come back
// at all. Each is a stand-in source that returns exactly that.
//
// The endpoint behaviours these assertions encode were confirmed live against
// https://mainnet.sorobanrpc.com on 2026-08-30 — 200-key ceiling, duplicate
// keys failing the whole call, absent keys omitted from the response. See the
// constants and function docs in ./ledger-entries.ts for the captured
// responses. What lives here is that this module HANDLES them, not that they
// are true; re-probe the endpoint, not this file, if that is in question.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Address, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
  MAX_LEDGER_KEYS_PER_CALL,
  contractInstanceKey,
  dedupeKeys,
  ledgerKeyId,
  readLedgerEntries,
  type LedgerEntryResultLike,
  type LedgerEntrySource,
} from './ledger-entries.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A deterministic, valid contract address — `i` distinguishes them, nothing more. */
function contractId(i: number): string {
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(i, 0);
  return StrKey.encodeContract(raw);
}

const EXTENSION_POINT = xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0]));

/**
 * A contract-data entry carrying `marker`, so a test can say which entry it got
 * back rather than only that it got one.
 */
function entryFor(contract: string, marker: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: EXTENSION_POINT,
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: nativeToScVal(marker),
    }),
  );
}

/** What `LedgerEntries.get` handed back, as the marker string it was built with. */
function markerOf(entry: xdr.LedgerEntryData | null): string | null {
  if (entry === null) return null;
  return entry.contractData().val().str().toString();
}

/**
 * A stand-in RPC that answers from a fixed key->entry table, recording every
 * batch it was asked for.
 *
 * `respond` is the hook the interesting cases hang off: it takes the entries
 * this source would naturally return and may reorder or drop them, which is
 * what lets a test reproduce a response the real endpoint gives only when an
 * entry genuinely does not exist.
 */
function fakeSource(
  table: ReadonlyMap<string, xdr.LedgerEntryData>,
  respond: (entries: LedgerEntryResultLike[]) => LedgerEntryResultLike[] = (e) => e,
): LedgerEntrySource & { calls: xdr.LedgerKey[][] } {
  const calls: xdr.LedgerKey[][] = [];
  return {
    calls,
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      calls.push(keys);
      const found: LedgerEntryResultLike[] = [];
      for (const key of keys) {
        const val = table.get(ledgerKeyId(key));
        // Absent keys are OMITTED, exactly as mainnet.sorobanrpc.com omits them.
        if (val !== undefined) found.push({ key, val });
      }
      return { entries: respond(found) };
    },
  };
}

// ---------------------------------------------------------------------------
// Demultiplexing
// ---------------------------------------------------------------------------

describe('readLedgerEntries demultiplexes by key, never by position', () => {
  // Two "pools" (A and B) plus one key that has no entry on chain. The response
  // is both SHORT and REORDERED, which is the pair of properties that makes
  // positional demultiplexing wrong rather than merely fragile.
  const poolA = contractId(1);
  const poolB = contractId(2);
  const absent = contractId(3);

  const table = new Map([
    [ledgerKeyId(contractInstanceKey(poolA)), entryFor(poolA, 'A')],
    [ledgerKeyId(contractInstanceKey(poolB)), entryFor(poolB, 'B')],
  ]);

  it('attributes each entry to the key that asked for it when one is missing', async () => {
    // Requested A, absent, B — so a positional read of the two-entry response
    // would hand B's entry back for `absent` and nothing back for B.
    const source = fakeSource(table);
    const entries = await readLedgerEntries(source, [
      contractInstanceKey(poolA),
      contractInstanceKey(absent),
      contractInstanceKey(poolB),
    ]);

    assert.equal(entries.size, 2, 'two of the three keys have entries');
    assert.equal(markerOf(entries.get(contractInstanceKey(poolA))), 'A');
    assert.equal(markerOf(entries.get(contractInstanceKey(poolB))), 'B');
    assert.equal(entries.get(contractInstanceKey(absent)), null);
    assert.equal(entries.has(contractInstanceKey(absent)), false);
  });

  it('survives a response returned in an order the request did not use', async () => {
    // Same three keys, response reversed. Nothing about the RPC contract
    // promises request order, and an entry misattributed this way would be a
    // wrong number published about a real address.
    const source = fakeSource(table, (found) => [...found].reverse());
    const entries = await readLedgerEntries(source, [
      contractInstanceKey(poolA),
      contractInstanceKey(absent),
      contractInstanceKey(poolB),
    ]);

    assert.equal(markerOf(entries.get(contractInstanceKey(poolA))), 'A');
    assert.equal(markerOf(entries.get(contractInstanceKey(poolB))), 'B');
    assert.equal(entries.get(contractInstanceKey(absent)), null);
  });

  it('reads an absent key as absent and not as an error', async () => {
    // The Aquarius `UpgradeDeadline`/`FutureWASM` shape: a key whose absence is
    // a legitimate reading. Before batching it arrived as `entries.length === 0`
    // on a one-key call; it must still be a null and never a throw.
    const source = fakeSource(new Map());
    const entries = await readLedgerEntries(source, [contractInstanceKey(absent)]);
    assert.equal(entries.size, 0);
    assert.equal(entries.get(contractInstanceKey(absent)), null);
  });
});

// ---------------------------------------------------------------------------
// Failure semantics
// ---------------------------------------------------------------------------

describe('a failed call is a failed run, never a set of empty entries', () => {
  it('propagates the throw rather than returning an empty batch', async () => {
    const source: LedgerEntrySource = {
      async getLedgerEntries() {
        throw new Error('Request failed with status code 429');
      },
    };

    await assert.rejects(
      () => readLedgerEntries(source, [contractInstanceKey(contractId(1))]),
      /429/,
      'a 429 must reach the indexer as the run failure it is',
    );
  });

  it('does not let a mid-batch failure publish the entries that did resolve', async () => {
    // Two chunks, second one fails. Returning the first chunk's entries would
    // report every key in the second as absent — a transport failure wearing an
    // absent-key costume, which is the exact confusion this module forbids.
    let call = 0;
    const source: LedgerEntrySource = {
      async getLedgerEntries(...keys: xdr.LedgerKey[]) {
        call += 1;
        if (call > 1) throw new Error('socket hang up');
        return { entries: keys.map((key) => ({ key, val: entryFor(contractId(1), 'x') })) };
      },
    };

    const keys = Array.from({ length: MAX_LEDGER_KEYS_PER_CALL + 1 }, (_, i) =>
      contractInstanceKey(contractId(i + 1)),
    );
    await assert.rejects(() => readLedgerEntries(source, keys), /socket hang up/);
  });
});

// ---------------------------------------------------------------------------
// What the endpoint refuses
// ---------------------------------------------------------------------------

describe('the request shapes mainnet.sorobanrpc.com refuses', () => {
  it('never sends a duplicate key, because one duplicate fails the whole call', async () => {
    // `[A, A]` comes back as `-32603: could not query captive core … 404` —
    // opaque, and it takes the other 200 keys down with it.
    const pool = contractId(1);
    const table = new Map([[ledgerKeyId(contractInstanceKey(pool)), entryFor(pool, 'A')]]);
    const source = fakeSource(table);

    const key = contractInstanceKey(pool);
    const entries = await readLedgerEntries(source, [key, key, key]);

    assert.equal(source.calls.length, 1);
    assert.equal(source.calls[0].length, 1, 'the repeated key is sent once');
    assert.equal(markerOf(entries.get(key)), 'A');
  });

  it('preserves first-seen order while deduping', () => {
    const [a, b] = [contractInstanceKey(contractId(1)), contractInstanceKey(contractId(2))];
    const deduped = dedupeKeys([a, b, a, b, a]);
    assert.deepEqual(deduped.map(ledgerKeyId), [a, b].map(ledgerKeyId));
  });

  it('never sends more than the 200-key ceiling in one call', async () => {
    // 201 keys is refused outright by the endpoint (`-32602: key count (201)
    // exceeds maximum supported (200)`), so the chunk boundary is a hard limit
    // rather than a tuning choice.
    const keys = Array.from({ length: MAX_LEDGER_KEYS_PER_CALL + 5 }, (_, i) =>
      contractInstanceKey(contractId(i + 1)),
    );
    const source = fakeSource(new Map());
    await readLedgerEntries(source, keys);

    assert.equal(source.calls.length, 2);
    assert.equal(source.calls[0].length, MAX_LEDGER_KEYS_PER_CALL);
    assert.equal(source.calls[1].length, 5);
    for (const call of source.calls) {
      assert.ok(call.length <= MAX_LEDGER_KEYS_PER_CALL);
    }
  });

  it('spends no round trip on an empty key list', async () => {
    const source = fakeSource(new Map());
    const entries = await readLedgerEntries(source, []);
    assert.equal(source.calls.length, 0);
    assert.equal(entries.size, 0);
  });
});
