// Tests for ./fetch.ts's read-side verdicts: the oracle-legibility precondition
// and the "no such contract function" discrimination it rests on.
//
// No RPC here either — these are the pure decisions `fetchBlendRawData` makes
// ABOUT what it read, which is the part that can be pinned without a network.
// The scoring those reads feed is in ./score.test.ts.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { LedgerEntries, ledgerKeyId } from '../ledger-entries.ts';
import {
  ORACLE_GRADING_READS,
  decodeReserve,
  isMissingContractFunction,
  oracleNotGradable,
  reserveConfigKey,
  reserveDataKey,
} from './index.ts';
import type { OracleGradingReads } from './index.ts';

// ---------------------------------------------------------------------------
// The oracle-legibility precondition (METHODOLOGY.md §2)
// ---------------------------------------------------------------------------

describe('the oracle-legibility precondition', () => {
  // WHERE THESE INTERFACES COME FROM. Each list below is the complete set of
  // functions the deployed oracle EXPORTS, read on 2026-08-26 out of the
  // `contractspecv0` section of its own wasm via Soroban RPC's
  // getContractMethods — not probed by calling a guessed list of names, which
  // cannot tell "this contract lacks the method" from "this is a different
  // contract entirely". The wasm hash is recorded beside each so a future
  // upgrade that changes the answer shows up as a changed hash rather than as a
  // mysteriously flipped assertion.
  //
  // WHAT THEY SHOW, and it is the finding that decided the precondition: the four
  // non-aggregator pools do NOT share one "plain SEP-40" shape. They are four
  // different contracts with four different wasm hashes doing four different
  // things — a bridge, a proxy, a deterministic bond pricer, a feed registry.
  // What they agree on is only the thing this precondition tests: not one of
  // them answers ANY of the three reads §2 grades against.
  const INTERFACES: { pool: string; wasm: string; note: string; methods: string[] }[] = [
    {
      pool: 'Blend Fixed V2 (scored)',
      wasm: '41df04894bf2d8291492326f7a6ab9c90a90cc9828e31990ce8aeeab42680bfd',
      note: 'Blend oracle-aggregator — the shape the adapter was written against',
      methods: [
        '__constructor',
        'add_asset',
        'add_base_asset',
        'add_oracle',
        'asset_configs',
        'assets',
        'base',
        'decimals',
        'lastprice',
        'max_age',
        'oracles',
        'set_admin',
      ],
    },
    {
      pool: 'YieldBlox (scored)',
      wasm: '8cf43882ff2e6757bef1900973ab26efb1b42b832a640a320a9b881fa501cf76',
      note: 'a different aggregator BUILD, same twelve exports',
      methods: [
        '__constructor',
        'add_asset',
        'add_base_asset',
        'add_oracle',
        'asset_configs',
        'assets',
        'base',
        'decimals',
        'lastprice',
        'max_age',
        'oracles',
        'set_admin',
      ],
    },
    {
      pool: 'Etherfuse (scored)',
      wasm: '65300c006c7b0151043be891f1f99872a25b20529d929db38fdfed96af966ff2',
      note: 'a third aggregator build — registered on the strength of this row',
      methods: [
        '__constructor',
        'add_asset',
        'add_base_asset',
        'add_oracle',
        'asset_configs',
        'assets',
        'base',
        'decimals',
        'lastprice',
        'max_age',
        'oracles',
        'set_admin',
      ],
    },
    {
      pool: 'Orbit',
      wasm: 'a71a844eec784d1a5ef201bbbd4c641980900fc128cb927b7c07720f7ae48cab',
      note: 'bridge oracle — ctor is (admin, stellar_oracle, other_oracle); publishes no base()',
      methods: ['__constructor', 'add_asset', 'decimals', 'lastprice', 'set_admin'],
    },
    {
      pool: 'Forex',
      wasm: '1d1c90d3b0135abf7a31cfdd7ebc358eba9d6bf44bbdc7a04386318a19d8631e',
      note: 'proxy oracle — CONFIG.base_oracle points one hop up at a SEP-40 feed',
      methods: ['decimals', 'lastprice', 'set_config', 'set_proxy', 'upgrade'],
    },
    {
      pool: 'Spectra PTs',
      wasm: '4a4441814cc6beb69692b0d11fe7bf83761146d0ab98a6f06750c2f4c37a12cd',
      note: 'deterministic zero-coupon-bond pricer — lastprice ignores its asset argument',
      methods: [
        'accept_ownership',
        'bump',
        'decimals',
        'get_description',
        'get_future_pt_value',
        'get_initial_implied_apy',
        'get_maturity',
        'get_owner',
        'get_pt',
        'get_start_time',
        'get_upgrader',
        'initialize',
        'lastprice',
        'price',
        'renounce_ownership',
        'set_future_pt_value',
        'set_upgrader',
        'transfer_ownership',
        'upgrade',
      ],
    },
    {
      pool: 'Solv',
      wasm: '5700be217a7b5d91324bdc529fd1e8047c275647c9c576aaa5a2ca46f64fd04a',
      note: 'SEP-40 feed registry — the only oracle here that implements SEP-40 at all',
      methods: [
        '__constructor',
        'accept_ownership',
        'add_feed',
        'assets',
        'base',
        'cancel_ownership_transfer',
        'change_owner',
        'decimals',
        'extend_entries_ttl',
        'lastprice',
        'price',
        'prices',
        'remove_feed',
        'resolution',
        'set_resolution',
        'update_feed',
        'upgrade',
      ],
    },
  ];

  /** What the runtime probe would conclude, derived from the real export list. */
  const answered = (methods: string[]): OracleGradingReads =>
    Object.fromEntries(
      ORACLE_GRADING_READS.map((read) => [read, methods.includes(read)]),
    ) as OracleGradingReads;

  const AGGREGATORS = ['Blend Fixed V2 (scored)', 'YieldBlox (scored)', 'Etherfuse (scored)'];

  for (const { pool, wasm, note, methods } of INTERFACES) {
    const aggregator = AGGREGATORS.includes(pool);

    it(`${aggregator ? 'grades' : 'refuses to grade'} ${pool} — ${note}`, () => {
      const verdict = oracleNotGradable('CORACLE…', answered(methods));
      if (aggregator) {
        assert.equal(verdict, null, `${pool} (wasm ${wasm}) should still be gradable`);
      } else {
        assert.ok(verdict, `${pool} (wasm ${wasm}) must not be scorable`);
        assert.match(verdict, /oracle-legibility precondition/);
        // A refusal that sends a reader nowhere is just a refusal.
        assert.match(verdict, /METHODOLOGY\.md §2/);
        assert.match(verdict, /oracle-not-gradable/);
      }
    });
  }

  it('names every missing read, not just the first one', () => {
    // "This oracle is not an aggregator" is ONE fact. Reporting it one method
    // per cycle would make a single property look like three separate problems,
    // and would take three failed runs to state completely.
    const verdict = oracleNotGradable('CORACLE…', answered(['decimals', 'lastprice']));
    for (const read of ORACLE_GRADING_READS) {
      assert.match(verdict ?? '', new RegExp(read), `verdict does not name ${read}`);
    }
  });

  it('refuses a partial aggregator rather than grading the half it can read', () => {
    // Not a shape seen on chain today, which is exactly why it is asserted.
    // §2 is min(priceFreshness, deviationBound), so an oracle publishing the
    // freshness anchors but no asset_configs would score the deviation half 0
    // on every reserve — a measured-looking 0 derived from an ABSENT mechanism
    // rather than a disabled one. That is the YieldBlox reading (max_dev
    // deliberately set to 0) applied to a pool that never made that choice.
    assert.ok(
      oracleNotGradable('CORACLE…', { max_age: true, oracles: true, asset_configs: false }),
    );
    assert.ok(
      oracleNotGradable('CORACLE…', { max_age: false, oracles: true, asset_configs: true }),
    );
  });

  it('quotes the oracle whose reads were missing', () => {
    // A verdict that does not name the contract cannot be checked by a reader.
    assert.match(oracleNotGradable('CAD2MCFU…', answered([])) ?? '', /CAD2MCFU…/);
  });
});

describe('isMissingContractFunction separates a verdict from a run failure', () => {
  // Captured verbatim from mainnet on 2026-08-26 — simulating max_age() against
  // Orbit's bridge oracle. Kept in full rather than trimmed, because the whole
  // point of this function is that it matches what the host really returns.
  const REAL = new Error(
    'Blend: simulation of max_age on CAD2MCFUXSNE4NU3G3YQUIWRZYPAUIPN45NHQCEBGJXRGFXU62JQOTUU ' +
      'failed: HostError: Error(WasmVm, MissingValue)\n\nEvent log (newest first):\n' +
      '   0: [Diagnostic Event] contract:CAD2MCFUXSNE4NU3G3YQUIWRZYPAUIPN45NHQCEBGJXRGFXU62JQOTUU, ' +
      'topics:[error, Error(WasmVm, MissingValue)], data:["trying to invoke non-existent ' +
      'contract function", max_age]\n',
  );

  it('recognises the real host error for an absent function', () => {
    assert.equal(isMissingContractFunction(REAL, 'max_age'), true);
  });

  it('does not treat a transient RPC failure as a scorability verdict', () => {
    // THE ASYMMETRY THAT MATTERS. A 429 from the shared public RPC is the exact
    // failure the concurrency revert was caused by, and it arrives on these same
    // calls. If
    // it were read as "this oracle publishes no max_age", one bad five-minute
    // cycle would declare a working pool permanently ungradable.
    for (const message of [
      'Blend: simulation of max_age on CORACLE… failed: 429 Too Many Requests',
      'fetch failed',
      'Blend: max_age on CORACLE… returned no value',
      'HostError: Error(Storage, MissingValue)',
    ]) {
      assert.equal(
        isMissingContractFunction(new Error(message), 'max_age'),
        false,
        `treated a run failure as a verdict: ${message}`,
      );
    }
  });

  it('does not match an absent function against the wrong method name', () => {
    // The error names which function was missing. Reading Orbit's max_age
    // failure as evidence about asset_configs would report a fact never read.
    assert.equal(isMissingContractFunction(REAL, 'asset_configs'), false);
  });
});

// ---------------------------------------------------------------------------
// Reserve demultiplexing across a batched read
// ---------------------------------------------------------------------------

// `decodeReserve` reads one reserve out of a batch that holds every reserve of
// the pool — and, if cross-target batching ever lands, of several pools at once.
// That makes misattribution the sharp risk of this whole change: a reserve's
// ResData carries the supply figures that drive utilizationSafety and
// liquiditySafety, so pinning PoolB's b_supply onto PoolA's asset would publish
// a confident, wrong number about a real market.
//
// The two properties tested are the two the endpoint actually exhibits, both
// confirmed live on 2026-08-30: a key with no entry is OMITTED from the
// response (so the response is shorter than the request), and nothing promises
// the surviving entries come back in request order. Under the pre-batching
// code neither could bite, because a call carried one reserve's two keys and
// the decoder told them apart by sniffing the value for a `b_rate` field. Under
// batching that sniff identifies a SHAPE and not a reserve, which is why it was
// replaced by keyed lookup and why this suite exists.
describe('decodeReserve pulls a reserve out of a batch by key', () => {
  const POOL_A = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD';
  const POOL_B = 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS';
  const ASSET = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

  const EXTENSION_POINT = xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0]));

  function entry(contract: string, value: Record<string, unknown>): xdr.LedgerEntryData {
    return xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: EXTENSION_POINT,
        contract: new Address(contract).toScAddress(),
        key: xdr.ScVal.scvSymbol('unused'),
        durability: xdr.ContractDataDurability.persistent(),
        val: nativeToScVal(value),
      }),
    );
  }

  const resConfig = (cFactor: number) => ({
    decimals: 7,
    c_factor: cFactor,
    l_factor: 8_500_000,
    util: 7_500_000,
    max_util: 9_500_000,
    enabled: true,
  });
  const resData = (bSupply: number) => ({
    d_rate: 1_000_000_000,
    b_rate: 1_000_000_000,
    b_supply: bSupply,
    d_supply: 1,
  });

  // One batch, both pools, the SAME asset in each — the collision case. Pool A's
  // numbers and Pool B's are deliberately different so an attribution error
  // shows up as a wrong value rather than as a coincidence.
  function batch(entries: [xdr.LedgerKey, xdr.LedgerEntryData][]): LedgerEntries {
    return new LedgerEntries(new Map(entries.map(([k, v]) => [ledgerKeyId(k), v])));
  }

  it('keeps two pools apart when both hold the same asset', () => {
    const entries = batch([
      [reserveConfigKey(POOL_A, ASSET), entry(POOL_A, resConfig(5_000_000))],
      [reserveDataKey(POOL_A, ASSET), entry(POOL_A, resData(111))],
      [reserveConfigKey(POOL_B, ASSET), entry(POOL_B, resConfig(9_000_000))],
      [reserveDataKey(POOL_B, ASSET), entry(POOL_B, resData(222))],
    ]);

    const a = decodeReserve(entries, POOL_A, ASSET);
    const b = decodeReserve(entries, POOL_B, ASSET);

    assert.equal(a.config.cFactor, 5_000_000n);
    assert.equal(a.data.bSupply, 111n);
    assert.equal(b.config.cFactor, 9_000_000n);
    assert.equal(b.data.bSupply, 222n);
  });

  it('does not hand one pool the other pool\u2019s reserve when a key is missing', () => {
    // Pool A's ResData is absent — the real "entry does not exist" case. A
    // positional decoder over this three-entry batch would slide Pool B's
    // ResData into Pool A's slot and publish 222 as A's supply.
    const entries = batch([
      [reserveConfigKey(POOL_A, ASSET), entry(POOL_A, resConfig(5_000_000))],
      [reserveConfigKey(POOL_B, ASSET), entry(POOL_B, resConfig(9_000_000))],
      [reserveDataKey(POOL_B, ASSET), entry(POOL_B, resData(222))],
    ]);

    assert.throws(
      () => decodeReserve(entries, POOL_A, ASSET),
      /missing ResConfig\/ResData for asset .* in pool CAJJ/,
      'a missing entry must fail this reserve, not borrow another pool\u2019s',
    );

    // And the pool that IS complete is unaffected — one absent key fails one
    // reserve, exactly as one failed one-key call used to.
    const b = decodeReserve(entries, POOL_B, ASSET);
    assert.equal(b.data.bSupply, 222n);
  });

  it('tells ResConfig from ResData by key rather than by shape', () => {
    // The sniff this replaced keyed off `'b_rate' in native`. Here both entries
    // of one reserve are present and the decoder must still file each under the
    // right half — checked by giving them values that would swap visibly.
    const entries = batch([
      [reserveConfigKey(POOL_A, ASSET), entry(POOL_A, resConfig(5_000_000))],
      [reserveDataKey(POOL_A, ASSET), entry(POOL_A, resData(111))],
    ]);
    const a = decodeReserve(entries, POOL_A, ASSET);
    assert.equal(a.asset, ASSET);
    assert.equal(a.config.decimals, 7);
    assert.equal(a.config.maxUtil, 9_500_000n);
    assert.equal(a.data.dSupply, 1n);
  });
});
