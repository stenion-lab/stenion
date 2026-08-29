// Tests for the Aquarius read-side decoders.
//
// WHAT THESE COVER, AND WHY THESE AND NOT OTHERS. Every case below is one live
// data cannot reach: all seven roles are present on every Aquarius contract
// today, no pool has ever reported an unknown `pool_type()`, and no contract has
// ever carried a pending upgrade. Those are exactly the branches whose
// behaviour is a rulebook decision — `methodology/dex.md` sends a short role map
// to the unsafe end, and claims nothing about an unrecognised pool type — so
// they are pinned here rather than left to be discovered the day Aquarius
// changes.
//
// The fetch itself is not tested: it is RPC and Horizon, covered by the frozen
// fixtures in adapters/fixtures/, which are real captured mainnet state.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { xdr } from '@stellar/stellar-sdk';

import {
  AQUARIUS_POOL_TYPES,
  AQUARIUS_ROLES,
  STELLAR_ASSET_EXECUTABLE,
  asPoolType,
  decodeRoles,
  instanceKeyName,
  parseAssetName,
  unrecognisedPoolType,
} from './index.ts';
import { aquariusConcentratedMainnet } from '../fixtures/aquarius/concentrated-mainnet.ts';
import { aquariusConstantProductMainnet } from '../fixtures/aquarius/constant-product-mainnet.ts';
import { aquariusStableMainnet } from '../fixtures/aquarius/stable-mainnet.ts';
import { aquariusWasmTokenMainnet } from '../fixtures/aquarius/wasm-token-mainnet.ts';

describe('asPoolType — the three types the router can deploy', () => {
  it('accepts exactly the three the chain reports', () => {
    // `constant_product`, NOT `standard`. Aquarius's documentation and issues
    // #100/#101 all say "standard"; the deployed contract returns
    // `constant_product`, read live from a pool of each type. This assertion is
    // the one that would fail if someone "corrected" the code to match the prose.
    assert.deepEqual([...AQUARIUS_POOL_TYPES], ['constant_product', 'stable', 'concentrated']);
    for (const t of AQUARIUS_POOL_TYPES) assert.equal(asPoolType(t), t);
  });

  it('rejects the documentation spelling rather than silently accepting it', () => {
    assert.equal(asPoolType('standard'), null);
  });

  it('rejects anything else, claiming nothing', () => {
    for (const value of [null, undefined, 42, '', 'CONSTANT_PRODUCT', {}, ['stable']]) {
      assert.equal(asPoolType(value), null, `${JSON.stringify(value)} must not be a pool type`);
    }
  });

  it('names the pool and the value it actually saw in the failure message', () => {
    // The message is what the indexer records on a failed run, so it has to be
    // enough to diagnose from alone — a bare "unrecognised pool" would send a
    // reader back to the chain to find out which pool and what it said.
    const message = unrecognisedPoolType('CPOOL', 'something_else');
    assert.match(message, /CPOOL/);
    assert.match(message, /something_else/);
    assert.match(message, /constant_product, stable, concentrated/);
  });
});

describe('decodeRoles — the role map, and what a short one means', () => {
  const full = () => Object.fromEntries(AQUARIUS_ROLES.map((r) => [r, [`G${r.toUpperCase()}`]]));

  /** Drop roles from a map, to build the short-map cases live data cannot produce. */
  const omit = (map: Record<string, unknown>, ...drop: string[]) =>
    Object.fromEntries(Object.entries(map).filter(([k]) => !drop.includes(k)));

  it('reads a full seven-role map', () => {
    const decoded = decodeRoles(full());
    assert.equal(decoded.status, 'read');
    assert.equal(decoded.status === 'read' && decoded.roles.length, 7);
  });

  it('keeps a role holding SEVERAL addresses, rather than taking the first', () => {
    // `get_privileged_addrs()` returns Map<Symbol, Vec<Address>> — confirmed
    // live. Every role holds exactly one address today, but the contract's own
    // type permits more, and flattening to [0] would silently drop a co-holder
    // the day one is added. That is a change in who controls the pool going
    // unreported, which is the failure adminKeySafety exists to catch.
    const decoded = decodeRoles({ ...full(), Admin: ['GONE', 'GTWO', 'GTHREE'] });
    assert.equal(decoded.status, 'read');
    const admin = decoded.status === 'read' && decoded.roles.find((r) => r.role === 'Admin');
    assert.deepEqual(admin && admin.addresses, ['GONE', 'GTWO', 'GTHREE']);
  });

  it('reports a SHORT map as short, naming exactly what is missing', () => {
    // methodology/dex.md: a map missing a role is either an unexpected contract
    // version or a role we cannot see, and grading the roles that DID come back
    // would publish a posture assessment of an admin set we know is incomplete.
    // Scoring sends this to 0; the fetch layer's job is to make it detectable
    // and attributable, which means naming the missing roles rather than a count.
    const short = omit(full(), 'PauseAdmin', 'RewardsAdmin');
    const decoded = decodeRoles(short);
    assert.equal(decoded.status, 'short');
    assert.deepEqual(decoded.status === 'short' && [...decoded.missing].sort(), [
      'PauseAdmin',
      'RewardsAdmin',
    ]);
    // The roles that DID come back are still carried — the reading is not
    // discarded, it is labelled.
    assert.equal(decoded.status === 'short' && decoded.roles.length, 5);
  });

  it('detects a short map even when the contract returns extra roles', () => {
    // An eighth role does not compensate for a missing one. Counting keys
    // against 7 would pass this; comparing against the expected SET catches it.
    const decoded = decodeRoles({ ...omit(full(), 'Admin'), SomeNewRole: ['GNEW'] });
    assert.equal(decoded.status, 'short');
    assert.deepEqual(decoded.status === 'short' && decoded.missing, ['Admin']);
  });

  it('fails a map that is not a map at all', () => {
    for (const value of [null, 'Admin', 42, ['Admin']]) {
      const decoded = decodeRoles(value);
      assert.equal(decoded.status, 'failed', `${JSON.stringify(value)} is not a role map`);
    }
  });

  it('tolerates a bare address where a vec was expected, rather than dropping the role', () => {
    // Losing a role silently is the one outcome worse than reporting an
    // unexpected shape: it would turn into a "short map" verdict about the
    // contract when the real problem was our decode.
    const decoded = decodeRoles({ ...full(), Admin: 'GBARE' });
    assert.equal(decoded.status, 'read');
    const admin = decoded.status === 'read' && decoded.roles.find((r) => r.role === 'Admin');
    assert.deepEqual(admin && admin.addresses, ['GBARE']);
  });
});

describe('parseAssetName — SAC metadata, and the native counter-example', () => {
  it('reads native XLM as a code with NO issuer', () => {
    // THE ONE THIS FUNCTION EXISTS FOR. Native XLM is a SAC whose metadata name
    // is the bare string `native`, not CODE:ISSUER — and it is the single most
    // common token in the registry. "No issuer account" is a POSITIVE fact
    // (nobody can freeze or claw back XLM), not an absent reading, so it must
    // not come back null and get routed like an unparseable name.
    assert.deepEqual(parseAssetName('native'), { code: 'XLM', issuer: null });
  });

  it('splits an ordinary CODE:ISSUER name', () => {
    assert.deepEqual(
      parseAssetName('AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'),
      {
        code: 'AQUA',
        issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
      },
    );
  });

  it('rejects a name whose issuer half is not an account', () => {
    // A contract address after the colon is not an issuer, and treating it as
    // one would send a Horizon lookup for an address that cannot have flags.
    assert.equal(parseAssetName('WRAP:CCONTRACTADDRESS'), null);
    assert.equal(parseAssetName('NOCOLON'), null);
    assert.equal(parseAssetName(':GISSUER'), null);
  });
});

describe('the SAC discriminant', () => {
  it('is the executable type, pinned as a literal', () => {
    // The whole SAC/wasm split turns on this one comparison — 196 of 205 pool
    // tokens take one branch and 9 take the other. A typo would route every SAC
    // down the wasm disclosure path, publishing "the read does not apply" for
    // tokens whose issuer flags are exactly what assetControlSafety grades.
    assert.equal(STELLAR_ASSET_EXECUTABLE, 'contractExecutableStellarAsset');
  });
});

describe('instanceKeyName — the decode whose bug hid a scored signal', () => {
  // THE REGRESSION GUARD FOR A REAL DEFECT. This function previously kept an
  // entry only `if (typeof name === 'string')`. Aquarius keys instance storage
  // with vec-wrapped enum variants, so that filter discarded EVERY entry on
  // EVERY contract — 31 on the router, 33-40 per pool — and made
  // `UpgradeDeadline` look unreadable when it is sitting there at 0n. It cost
  // half of `adminKeySafety`'s Gate 0 argument until it was caught.
  //
  // The failure mode is why this is pinned: an over-strict filter returns an
  // EMPTY MAP rather than throwing, so it is indistinguishable from a contract
  // that stores nothing. Nothing else in the adapter would have noticed.

  it('reads a vec-wrapped unit variant — the shape Aquarius actually uses', () => {
    const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('UpgradeDeadline')]);
    assert.equal(instanceKeyName(key), 'UpgradeDeadline');
  });

  it('still reads a bare symbol key', () => {
    assert.equal(instanceKeyName(xdr.ScVal.scvSymbol('Admin')), 'Admin');
  });

  it('joins a compound key rather than dropping it', () => {
    // `get_reserves()` reads ["Balance", <address>]. Collapsing it to "Balance"
    // would make two reserves collide on one map entry.
    const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), xdr.ScVal.scvSymbol('CTOKEN')]);
    assert.equal(instanceKeyName(key), 'Balance:CTOKEN');
  });

  it('returns null only for a key with no string head', () => {
    assert.equal(instanceKeyName(xdr.ScVal.scvU32(7)), null);
    assert.equal(instanceKeyName(xdr.ScVal.scvVec([xdr.ScVal.scvU32(7)])), null);
  });
});

// ---------------------------------------------------------------------------

describe('the frozen fixtures — the decode bug, guarded at the data level', () => {
  // WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS ABOVE. `instanceKeyName` is
  // pinned against synthetic ScVals, which proves the function is right but not
  // that the adapter WIRED it to the real contracts correctly. The original
  // defect produced an empty instance-storage map and therefore a plausible
  // all-nulls `upgrade` block — every unit test still passed, and the fixtures
  // were typechecked by `satisfies` but asserted by nothing, so the false
  // negative rode all the way into a published finding.
  //
  // These assert against real captured mainnet state. If the key decode
  // regresses, `deadline` goes null here and this fails loudly.
  const FIXTURES = [
    ['constant_product', aquariusConstantProductMainnet],
    ['stable', aquariusStableMainnet],
    ['concentrated', aquariusConcentratedMainnet],
    ['wasm-token', aquariusWasmTokenMainnet],
  ] as const;

  it('reads UpgradeDeadline on every pool AND its router — never null', () => {
    for (const [label, fx] of FIXTURES) {
      for (const [where, up] of [
        ['pool', fx.upgrade],
        ['router', fx.router.upgrade],
      ] as const) {
        // `null` is the signature of the bug: it means "no such entry", which is
        // what an emptied instance map looks like. `0n` is the real reading.
        assert.notEqual(
          up.deadline,
          null,
          `${label}/${where}: UpgradeDeadline read as null — the instance-storage key ` +
            `decode has regressed (see instanceKeyName)`,
        );
        assert.equal(up.deadline, 0n, `${label}/${where}: expected no upgrade scheduled`);
        assert.equal(up.pending, false);
      }
    }
  });

  it('reads FutureWASM as each contract’s own running hash — nothing staged', () => {
    // Presence is not the signal; DIFFERENCE is. Every contract read on
    // 2026-08-29 staged code identical to its live code.
    for (const [label, fx] of FIXTURES) {
      for (const [where, up] of [
        ['pool', fx.upgrade],
        ['router', fx.router.upgrade],
      ] as const) {
        assert.match(String(up.futureWasm), /^[0-9a-f]{64}$/, `${label}/${where}: no FutureWASM`);
        assert.equal(up.futureWasm, up.runningWasm, `${label}/${where}: staged code differs`);
        assert.equal(up.stagedDiffers, false);
      }
    }
  });

  it('decodes every reserve token, and routes each issuer read to the right arm', () => {
    // The other half of what flows through readInstance: SAC metadata lives
    // under a BARE symbol key (`METADATA`), so this path was never broken — but
    // it shares the decoder, and nothing else asserts it against real data.
    const seen = new Set<string>();
    for (const [label, fx] of FIXTURES) {
      assert.equal(fx.reserveTokens.length, fx.tokens.length, `${label}: token count mismatch`);
      for (const t of fx.reserveTokens) {
        assert.ok(t.decimals !== null, `${label}: ${t.address} has no decimals`);
        seen.add(t.issuer.status);
      }
    }
    // All four arms of AquariusIssuerRead that live data can reach. `failed` is
    // deliberately absent — no captured issuer lookup failed, and a fixture
    // cannot manufacture one.
    assert.deepEqual([...seen].sort(), ['noIssuer', 'notApplicable', 'read']);
  });

  it('pins the three pool types, by the chain’s spelling', () => {
    assert.deepEqual(
      FIXTURES.map(([, fx]) => fx.poolType),
      ['constant_product', 'stable', 'concentrated', 'stable'],
    );
  });

  it('carries a three-token pool, so arity is exercised and not just asserted', () => {
    assert.equal(aquariusStableMainnet.tokens.length, 3);
    assert.equal(aquariusStableMainnet.reserves.length, 3);
  });
});
