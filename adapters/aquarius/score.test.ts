// Fixture tests for the two `dex` factors and `operationalState` — everything
// in ./score.ts.
//
// WHY THESE EXIST: almost every rule methodology/dex.md publishes is
// unreachable from live data. All 340 Aquarius pools shared one admin posture in
// the 2026-08-27 census and every one of them read `UpgradeDeadline = 0`, so a
// pending upgrade, a matured deadline, a contract-held role, a short role map
// and a reverting `get_privileged_addrs()` can only be exercised from a
// synthetic fixture — and each of those is a branch the rulebook sends to the
// unsafe end. A suite built from mainnet alone would test one row of the table.
//
// THE CANNOT-ASSESS BRANCHES ARE THE POINT, not coverage. Lending shipped
// `liquiditySafety` and `utilizationSafety` returning **100** from a minimum over
// an empty set on 2026-08-16 — maximally safe, from no data — and the correction
// is in its changelog. methodology/dex.md wrote both factors' equivalents down
// before this adapter existed; every one of them is asserted below to be 0.
//
// The decoders these raw values are read out WITH are tested in ./fetch.test.ts;
// the captured-mainnet snapshots are ../snapshot.test.ts.
//
// Reached through `AquariusAdapter` rather than through ./score.ts's exports
// directly, the way both lending suites are: the class's `computeRiskFactors` /
// `operationalState` are pure delegators, and going through them keeps the
// delegation itself under test.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AquariusAdapter, unrecognisedPoolType } from './index.ts';
import type {
  AquariusIssuerFlagsRaw,
  AquariusIssuerRead,
  AquariusKillFlagsRaw,
  AquariusRawData,
  AquariusRoleRaw,
  AquariusRolesRead,
  AquariusRouterRaw,
  AquariusTokenRaw,
  AquariusUpgradeRaw,
} from './index.ts';
import { AQUARIUS_ROLES, AQUARIUS_ROUTER_ID } from './index.ts';
import { DEX_FACTORS, OperationalLevel } from '@stenion/core';
import type { DexFactorMap, RiskFactor } from '@stenion/core';

// ---------------------------------------------------------------------------
// Synthetic raw-state builders
// ---------------------------------------------------------------------------

const FETCHED_AT = 1_787_996_143;
const CLEAN_FLAGS: AquariusIssuerFlagsRaw = {
  authRequired: false,
  authRevocable: false,
  authImmutable: false,
  authClawbackEnabled: false,
};

/** A classic `G…` role holder Horizon answered for. */
function holder(o: {
  address?: string;
  signerCount?: number;
  highThreshold?: number;
  recentOps?: number;
}): AquariusRoleRaw['accounts'][number] {
  const address = o.address ?? 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return {
    status: 'read',
    address,
    account: {
      highThreshold: o.highThreshold ?? 0,
      signerCount: o.signerCount ?? 1,
      recentOps: o.recentOps ?? 0,
      activityWindowDays: 30,
    },
  };
}

/**
 * The seven roles, every one a lone key with no activity — a 40 across the
 * board — with per-role overrides. Seven is what `AquariusRolesRead` needs to be
 * `read` rather than `short`, so the default is a complete map.
 */
function roles(overrides: Partial<Record<string, AquariusRoleRaw>> = {}): AquariusRolesRead {
  return {
    status: 'read',
    roles: AQUARIUS_ROLES.map(
      (role) =>
        overrides[role] ?? {
          role,
          addresses: [`G${role}`],
          accounts: [holder({ address: `G${role}` })],
        },
    ),
  };
}

function token(
  o: { address?: string; symbol?: string; issuer?: AquariusIssuerRead } = {},
): AquariusTokenRaw {
  const issuer: AquariusIssuerRead = o.issuer ?? {
    status: 'read',
    issuer: 'GISSUERISSUERISSUERISSUERISSUERISSUERISSUERISSUERISSUER1',
    flags: CLEAN_FLAGS,
  };
  return {
    address: o.address ?? 'CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    isStellarAsset: issuer.status !== 'notApplicable',
    code: o.symbol ?? 'TKN',
    decimals: 7,
    symbol: o.symbol ?? 'TKN',
    issuer,
  };
}

/** A SAC whose issuer answered, with the four flags spelled out. */
const sac = (symbol: string, flags: Partial<AquariusIssuerFlagsRaw>): AquariusTokenRaw =>
  token({
    address: `C${symbol}`,
    symbol,
    issuer: { status: 'read', issuer: `G${symbol}`, flags: { ...CLEAN_FLAGS, ...flags } },
  });

const NO_UPGRADE: AquariusUpgradeRaw = {
  deadline: 0n,
  futureWasm: 'aa'.repeat(32),
  runningWasm: 'aa'.repeat(32),
  pending: false,
  stagedDiffers: false,
};

interface RawOpts {
  roles?: AquariusRolesRead;
  upgrade?: Partial<AquariusUpgradeRaw>;
  routerRoles?: AquariusRolesRead;
  routerUpgrade?: Partial<AquariusUpgradeRaw>;
  routerEmergency?: boolean;
  reserveTokens?: AquariusTokenRaw[];
  killed?: Partial<AquariusKillFlagsRaw>;
  emergencyMode?: boolean;
  poolType?: AquariusRawData['poolType'];
  reserves?: bigint[];
  totalShares?: bigint;
}

function makeRaw(o: RawOpts = {}): AquariusRawData {
  const reserveTokens = o.reserveTokens ?? [sac('XLM', {}), sac('AQUA', {})];
  const router: AquariusRouterRaw = {
    routerId: AQUARIUS_ROUTER_ID,
    contractName: 'AMMRouter',
    version: 200,
    emergencyMode: o.routerEmergency ?? false,
    roles: o.routerRoles ?? roles(),
    upgrade: { ...NO_UPGRADE, ...o.routerUpgrade },
  };
  return {
    poolId: 'CPOOLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    poolType: o.poolType ?? 'constant_product',
    tokens: reserveTokens.map((t) => t.address),
    reserves: o.reserves ?? reserveTokens.map(() => 1_000_000n),
    totalShares: o.totalShares ?? 1_000_000n,
    feeFraction: 30,
    protocolFeeFraction: 5000,
    info: { fee: 30, pool_type: o.poolType ?? 'constant_product' },
    shareId: 'CSHAREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    version: 200,
    killed: { swap: false, deposit: false, claim: false, ...o.killed },
    emergencyMode: o.emergencyMode ?? false,
    roles: o.roles ?? roles(),
    upgrade: { ...NO_UPGRADE, ...o.upgrade },
    reserveTokens,
    router,
    fetchedAt: FETCHED_AT,
  };
}

const adapter = new AquariusAdapter({
  pool: { id: 'aquarius-test', name: 'Aquarius test pool', poolId: 'CPOOLTEST' },
});

const factors = (raw: AquariusRawData): Promise<DexFactorMap> => adapter.computeRiskFactors(raw);
const admin = async (raw: AquariusRawData): Promise<RiskFactor> =>
  (await factors(raw)).adminKeySafety!;
const asset = async (raw: AquariusRawData): Promise<RiskFactor> =>
  (await factors(raw)).assetControlSafety!;
const sub = (f: RiskFactor, id: string) => f.components?.find((c) => c.id === id);

// ---------------------------------------------------------------------------

describe('the factor map itself', () => {
  it('publishes exactly the two factors the dex rulebook declares', async () => {
    // `dex` scores two, not lending's five: `utilizationSafety`,
    // `liquiditySafety` and `oracleSafety` have no referent in a spot AMM at all
    // (no borrow ledger, no cap, no price feed). A key here that is not in
    // `CATEGORY_FACTORS.dex` would be a factor with no published rule.
    const f = await factors(makeRaw());
    assert.deepEqual(Object.keys(f).sort(), Object.keys(DEX_FACTORS).sort());
  });

  it('takes every weight from DEX_FACTORS, never a literal', async () => {
    // Asserted against the object rather than against 0.55 / 0.45, so editing
    // the published weight table alone fails here — which is the whole reason
    // `core/src/weights.ts` exists. `scoring.test.ts` pins that table against
    // methodology/dex.md in both directions, so the chain runs
    // adapter -> weights.ts -> the published rulebook with no hand copy in it.
    const f = await factors(makeRaw());
    assert.equal(f.adminKeySafety!.weight, DEX_FACTORS.adminKeySafety.weight);
    assert.equal(f.assetControlSafety!.weight, DEX_FACTORS.assetControlSafety.weight);
  });

  it('scores by delegating to the shared weighted mean', async () => {
    // `score()` does nothing but call `scoreFactors`. Checked by hand so a
    // failure separates "a factor moved" from "the weighting moved". The
    // synthetic default is seven idle lone keys and two clean-but-mutable SACs:
    // 40x0.55 + 70x0.45 = 53.5 -> 54.
    const f = await factors(makeRaw());
    assert.equal(f.adminKeySafety!.value, 40);
    assert.equal(f.assetControlSafety!.value, 70);
    assert.equal(adapter.score(f).score, 54);
  });

  it('gives both factors a real detail string and an in-range whole number', async () => {
    for (const [key, factor] of Object.entries(await factors(makeRaw()))) {
      assert.ok(factor, `${key} must be populated`);
      assert.ok(factor.detail.length > 10, `${key} needs a real detail string`);
      assert.ok(Number.isInteger(factor.value), `${key} must be a whole number`);
      assert.ok(factor.value >= 0 && factor.value <= 100, `${key} out of range`);
    }
  });
});

// ---------------------------------------------------------------------------
// adminKeySafety
// ---------------------------------------------------------------------------

describe('adminKeySafety — role posture', () => {
  it('scores an N-of-M multisig 90 and a lone key 40', async () => {
    // Lending's tiers, adopted by reference rather than re-argued
    // (methodology/dex.md §1). `signerCount > 1 AND high_threshold > 1` is what
    // Stellar's own threshold model makes provably not a single point of
    // unilateral compromise.
    const multisig = roles({
      ...Object.fromEntries(
        AQUARIUS_ROLES.map((role) => [
          role,
          { role, addresses: ['G1'], accounts: [holder({ signerCount: 3, highThreshold: 2 })] },
        ]),
      ),
    });
    assert.equal((await admin(makeRaw({ roles: multisig, routerRoles: multisig }))).value, 90);
    assert.equal((await admin(makeRaw())).value, 40);
  });

  it('penalises 3 per operation, capped at 30', async () => {
    const withOps = (recentOps: number) =>
      roles({
        Admin: { role: 'Admin', addresses: ['G1'], accounts: [holder({ recentOps })] },
      });
    // 40 - 3x2 = 34; 40 - min(30, 3x200) = 10; never below the cap.
    assert.equal((await admin(makeRaw({ roles: withOps(2), routerRoles: withOps(2) }))).value, 34);
    assert.equal(
      (await admin(makeRaw({ roles: withOps(200), routerRoles: withOps(200) }))).value,
      10,
    );
    assert.equal(
      (await admin(makeRaw({ roles: withOps(9999), routerRoles: withOps(9999) }))).value,
      10,
    );
  });

  it('combines the seven roles by MIN — not max, not mean, not the first', async () => {
    // The rule methodology/dex.md labels an unvalidated judgment call, and the
    // one this test exists to pin. The seven values below are 90, 40, 40, 40,
    // 40, 40 and 20, in that order, so:
    //   min  -> 20   (correct)
    //   max  -> 90
    //   mean -> 44
    //   [0]  -> 90
    // Every wrong aggregation lands somewhere else, so this fails loudly.
    const spread = roles({
      Admin: {
        role: 'Admin',
        addresses: ['G1'],
        accounts: [holder({ signerCount: 3, highThreshold: 2 })],
      },
      SystemFeeAdmin: {
        role: 'SystemFeeAdmin',
        addresses: ['G7'],
        accounts: [holder({ recentOps: 7 })],
      },
    });
    const f = await admin(makeRaw({ roles: spread, routerRoles: spread }));
    assert.equal(f.value, 19); // 40 - 21
    assert.match(f.detail, /SystemFeeAdmin/);
    assert.doesNotMatch(f.detail, /binds at 90/);
  });

  it('minimises over every address a role holds, never addresses[0]', async () => {
    // `get_privileged_addrs()` returns `role -> Vec<Address>`. Every role holds
    // exactly one address today and the contract's own type permits several, so
    // taking `[0]` is correct on live data and wrong the day a co-holder is
    // added — the same class of bug #101 caught on the fetch side. The healthy
    // holder is deliberately FIRST, so `[0]` would score 90 and pass.
    const coheld = roles({
      Admin: {
        role: 'Admin',
        addresses: ['GSAFE', 'GRISKY'],
        accounts: [
          holder({ address: 'GSAFE', signerCount: 3, highThreshold: 2 }),
          holder({ address: 'GRISKY', recentOps: 200 }),
        ],
      },
    });
    const f = await admin(makeRaw({ roles: coheld, routerRoles: coheld }));
    assert.equal(f.value, 10);
    assert.match(sub(f, 'rolePosture')!.detail, /worst of 2 holders/);
  });

  it('reads the router role map as well as the pool one', async () => {
    // Both are the factor's declared anchors. The pool's own map is read per
    // pool rather than inherited because a per-pool `set_privileged_addrs`
    // exists — so a router that degraded while the pool stayed clean must still
    // bind, or the adapter cannot report the day the two diverge.
    const degraded = roles({
      Admin: { role: 'Admin', addresses: ['G1'], accounts: [holder({ recentOps: 200 })] },
    });
    const f = await admin(makeRaw({ routerRoles: degraded }));
    assert.equal(f.value, 10);
    assert.match(sub(f, 'rolePosture')!.detail, /^router:/);
  });
});

describe('adminKeySafety — cannot-assess branches all resolve to 0', () => {
  it('scores 0 when get_privileged_addrs() reverts', async () => {
    const failed: AquariusRolesRead = { status: 'failed', reason: 'host invocation failed' };
    for (const raw of [makeRaw({ roles: failed }), makeRaw({ routerRoles: failed })]) {
      const f = await admin(raw);
      assert.equal(f.value, 0);
      assert.match(f.detail, /did not read: host invocation failed/);
    }
  });

  it('scores 0 on a SHORT role map rather than grading the roles that came back', async () => {
    // Seven were present on the router and all 340 pools. A short map means an
    // unexpected contract version or a role we cannot see, and grading the rest
    // would publish a posture assessment of an admin set we know is incomplete.
    const short: AquariusRolesRead = {
      status: 'short',
      roles: [{ role: 'Admin', addresses: ['G1'], accounts: [holder({})] }],
      missing: ['PauseAdmin', 'RewardsAdmin'],
    };
    const f = await admin(makeRaw({ roles: short }));
    assert.equal(f.value, 0);
    assert.match(f.detail, /missing PauseAdmin, RewardsAdmin/);
  });

  it('scores 0 for a contract-held role — NOT lending’s neutral 60', async () => {
    // The one deliberate departure from lending's tiers. Lending's 60 is
    // anchored to a contract admin being a known, named structure it chose not
    // to grade; an Aquarius role that is not a classic account is a structure we
    // did not expect and cannot describe, and a neutral score for an unexpected
    // reading is an invented number.
    const contractHeld = roles({
      PauseAdmin: {
        role: 'PauseAdmin',
        addresses: ['CCONTRACT'],
        accounts: [{ status: 'contract', address: 'CCONTRACT' }],
      },
    });
    const f = await admin(makeRaw({ roles: contractHeld, routerRoles: contractHeld }));
    assert.equal(f.value, 0);
    assert.match(f.detail, /is a contract address/);
    assert.notEqual(f.value, 60);
  });

  it('scores 0 when a role account lookup fails', async () => {
    const lookupFailed = roles({
      RewardsAdmin: {
        role: 'RewardsAdmin',
        addresses: ['GREWARDS'],
        accounts: [{ status: 'failed', address: 'GREWARDS', reason: 'Horizon returned 503' }],
      },
    });
    const f = await admin(makeRaw({ roles: lookupFailed, routerRoles: lookupFailed }));
    assert.equal(f.value, 0);
    assert.match(f.detail, /could not be read \(Horizon returned 503\)/);
  });

  it('scores 0 for a role that declares a holder but resolves none', async () => {
    // A minimum over an empty set is 0. This is the branch lending got wrong on
    // 2026-08-16, in the one shape this factor can reach it.
    const empty = roles({
      OperationsAdmin: { role: 'OperationsAdmin', addresses: ['GX'], accounts: [] },
    });
    const f = await admin(makeRaw({ roles: empty, routerRoles: empty }));
    assert.equal(f.value, 0);
    assert.match(f.detail, /no readable holder/);
  });
});

describe('adminKeySafety — the upgrade reaction window', () => {
  it('does not bind when UpgradeDeadline is 0', async () => {
    const f = await admin(makeRaw());
    assert.equal(sub(f, 'upgradeWindow')!.value, 100);
    assert.equal(f.value, 40); // role posture, unchanged
    assert.match(sub(f, 'upgradeWindow')!.detail, /UpgradeDeadline = 0 — no code change scheduled/);
  });

  it('caps the score at 40 while a deadline is still in the future', async () => {
    // Not a new constant: the single-master-key tier reused, because while a
    // change is scheduled the LP's only protection is a countdown whose LENGTH
    // cannot be read at all.
    const soon = { deadline: BigInt(FETCHED_AT + 3600), pending: true };
    const clean = roles(
      Object.fromEntries(
        AQUARIUS_ROLES.map((role) => [
          role,
          { role, addresses: ['G1'], accounts: [holder({ signerCount: 3, highThreshold: 2 })] },
        ]),
      ),
    );
    const f = await admin(makeRaw({ roles: clean, routerRoles: clean, upgrade: soon }));
    assert.equal(sub(f, 'rolePosture')!.value, 90);
    assert.equal(sub(f, 'upgradeWindow')!.value, 40);
    assert.equal(f.value, 40);
    assert.match(f.detail, /pending upgrade caps the score at 40/);
    assert.match(sub(f, 'upgradeWindow')!.detail, /is 3600s away/);
  });

  it('scores 0 once the deadline has matured — a reading, not a choice', async () => {
    const matured = { deadline: BigInt(FETCHED_AT - 60), pending: true };
    const f = await admin(makeRaw({ upgrade: matured }));
    assert.equal(sub(f, 'upgradeWindow')!.value, 0);
    assert.equal(f.value, 0);
    assert.match(sub(f, 'upgradeWindow')!.detail, /matured 60s ago/);
  });

  it('scores 0 when the contract carries no UpgradeDeadline entry at all', async () => {
    // `null` is not `0n`: one says the contract answered "nothing pending", the
    // other says this contract does not keep the field. Collapsing them would
    // read an unexpected contract version as a clean bill of health.
    const f = await admin(makeRaw({ upgrade: { deadline: null } }));
    assert.equal(sub(f, 'upgradeWindow')!.value, 0);
    assert.equal(f.value, 0);
    assert.match(sub(f, 'upgradeWindow')!.detail, /carries no UpgradeDeadline entry at all/);
  });

  it('reads the router upgrade state as well as the pool one', async () => {
    const f = await admin(makeRaw({ routerUpgrade: { deadline: null } }));
    assert.equal(sub(f, 'upgradeWindow')!.value, 0);
    assert.match(sub(f, 'upgradeWindow')!.detail, /^router carries no UpgradeDeadline/);
  });

  it('publishes FutureWASM without grading it', async () => {
    // Every contract read on 2026-08-29 carried a FutureWASM equal to its own
    // running hash, so presence is the quiescent state rather than the signal.
    // A reader wants to know WHICH code is staged; the deadline already carries
    // whether one is coming.
    const staged = await admin(
      makeRaw({ upgrade: { futureWasm: 'bb'.repeat(32), stagedDiffers: true } }),
    );
    const quiet = await admin(makeRaw());
    assert.equal(staged.value, quiet.value);
    assert.match(sub(staged, 'upgradeWindow')!.detail, /FutureWASM bbbbbbbb… differs from/);
    assert.match(sub(quiet, 'upgradeWindow')!.detail, /matches the running code/);
  });
});

describe('adminKeySafety — route-(a) disclosures', () => {
  it('publishes the unreadable timelock duration and the Emergency Admin bypass, ungraded', async () => {
    // `value: null` is measured-and-deliberately-ungraded, never missing data.
    // Neither may move the number in either direction.
    const f = await admin(makeRaw());
    for (const id of ['timelockDuration', 'emergencyBypass']) {
      const c = sub(f, id);
      assert.ok(c, `${id} disclosure must be published`);
      assert.equal(c.value, null);
      assert.ok(c.detail.length > 40, `${id} needs a real disclosure string`);
    }
    assert.match(sub(f, 'timelockDuration')!.detail, /ADMIN_ACTIONS_DELAY/);
    assert.match(sub(f, 'emergencyBypass')!.detail, /Emergency Admin/);
  });
});

// ---------------------------------------------------------------------------
// assetControlSafety
// ---------------------------------------------------------------------------

describe('assetControlSafety — the per-token tiers', () => {
  const only = async (t: AquariusTokenRaw) => (await asset(makeRaw({ reserveTokens: [t] }))).value;

  it('scores a SAC with no issuer account at all 100', async () => {
    // Native XLM. A positive fact — "nobody can seize this" — and it must never
    // be routed like a non-applicable read, which is the opposite statement.
    assert.equal(
      await only(token({ symbol: 'XLM', issuer: { status: 'noIssuer', asset: 'native' } })),
      100,
    );
  });

  it('scores an immutable issuer with clean flags 100', async () => {
    assert.equal(await only(sac('LSP', { authImmutable: true })), 100);
  });

  it('scores clean-but-mutable 70, not 100', async () => {
    // `auth_revocable` is one SET_OPTIONS away for any issuer that has not set
    // `auth_immutable`, so "clean today" is a strictly weaker statement than
    // "cannot become dirty". Scoring it 100 would publish the reading as a
    // guarantee.
    assert.equal(await only(sac('AQUA', {})), 70);
  });

  it('scores a revocable issuer 40 and a clawback-enabled issuer 0', async () => {
    assert.equal(await only(sac('USDC', { authRevocable: true })), 40);
    assert.equal(await only(sac('SEIZE', { authClawbackEnabled: true })), 0);
    // Seizure strictly dominates freezing, so clawback binds even alongside it.
    assert.equal(await only(sac('BOTH', { authRevocable: true, authClawbackEnabled: true })), 0);
  });

  it('scores an issuer that is BOTH immutable and revocable 40 — the tier order is load-bearing', async () => {
    // `auth_immutable` freezes whatever the flags currently ARE, so it is a
    // credit only when what it freezes is clean. This issuer has made its freeze
    // power permanent. Testing immutability first would score it 100 and invert
    // the single case the order exists for.
    assert.equal(await only(sac('LOCKED', { authImmutable: true, authRevocable: true })), 40);
    assert.equal(
      await only(sac('LOCKEDCB', { authImmutable: true, authClawbackEnabled: true })),
      0,
    );
  });

  it('leaves auth_required out of the number and in the detail', async () => {
    // It gates who may ACQUIRE the asset; it does not let an issuer touch a
    // balance that already exists.
    assert.equal(await only(sac('GATED', { authRequired: true })), 70);
    const f = await asset(makeRaw({ reserveTokens: [sac('GATED', { authRequired: true })] }));
    assert.match(f.components![0]!.detail, /auth_required set \(read, not graded\)/);
  });
});

describe('assetControlSafety — cannot-assess branches all resolve to 0', () => {
  it('scores a SAC whose issuer lookup failed 0, and does NOT route it as not-applicable', async () => {
    // The single most dangerous confusion available in this factor: the token IS
    // a SAC, so its issuer flags are exactly what this grades, and the read did
    // not happen. Treating it as "does not apply" would silently upgrade an
    // unknown into an exemption.
    const broken = token({
      symbol: 'USDC',
      issuer: { status: 'failed', issuer: 'GISSUER', reason: 'Horizon returned 504' },
    });
    const f = await asset(makeRaw({ reserveTokens: [sac('XLM', {}), broken] }));
    assert.equal(f.value, 0);
    assert.match(f.detail, /the read applies and did not happen/);
    assert.equal(f.components!.find((c) => c.label === 'USDC')!.value, 0);
    // Not counted as an exclusion — an exclusion is a disclosure, this is a zero.
    assert.doesNotMatch(f.detail, /excluded as non-SAC/);
  });

  it('scores 0 when NO reserve token is gradable — a minimum over an empty set', async () => {
    // Written down in methodology/dex.md before this adapter existed, precisely
    // because lending published a 100 from this shape first.
    const wasmOnly = [
      token({
        address: 'CW1',
        symbol: 'BnUSD',
        issuer: { status: 'notApplicable', reason: 'wasm-contract' },
      }),
      token({
        address: 'CW2',
        symbol: 'XAUM',
        issuer: { status: 'notApplicable', reason: 'wasm-contract' },
      }),
    ];
    const f = await asset(makeRaw({ reserveTokens: wasmOnly }));
    assert.equal(f.value, 0);
    assert.notEqual(f.value, 100);
    assert.match(f.detail, /no reserve token is gradable/);
    assert.deepEqual(
      f.components!.map((c) => c.value),
      [null, null],
    );
  });
});

describe('assetControlSafety — combination across reserves', () => {
  it('combines the reserves by MIN — not max, not mean, not the first', async () => {
    // Values 100, 70, 40 in that order, so:
    //   min  -> 40  (correct)
    //   max  -> 100
    //   mean -> 70
    //   [0]  -> 100
    // The worst asset is deliberately LAST, which is what makes "first element"
    // fail here as well as "max".
    const f = await asset(
      makeRaw({
        reserveTokens: [
          token({
            address: 'CXLM',
            symbol: 'XLM',
            issuer: { status: 'noIssuer', asset: 'native' },
          }),
          sac('AQUA', {}),
          sac('USDC', { authRevocable: true }),
        ],
      }),
    );
    assert.equal(f.value, 40);
    assert.match(f.detail, /worst of 3 gradable reserve\(s\)/);
    assert.match(f.detail, /USDC/);
  });

  it('scores a three-token stable pool with no pair assumption anywhere', async () => {
    // Three of the 304 token sets have three members, all of them `stable`
    // pools. Arity comes from `reserveTokens.length`; nothing indexes [0]/[1].
    const three = makeRaw({
      poolType: 'stable',
      reserveTokens: [sac('USDC', { authRevocable: true }), sac('USDx', {}), sac('yUSDC', {})],
    });
    const f = await asset(three);
    assert.equal(f.value, 40);
    assert.equal(f.components!.length, 3);
    // A fourth reserve changes the answer, so the arity is genuinely read.
    const four = await asset(
      makeRaw({
        poolType: 'stable',
        reserveTokens: [...three.reserveTokens, sac('SEIZE', { authClawbackEnabled: true })],
      }),
    );
    assert.equal(four.value, 0);
    assert.equal(four.components!.length, 4);
  });

  it('excludes a non-SAC reserve from the computation and names it', async () => {
    // Route (a): a disclosure is not a zero and not a pass. The pool below scores
    // exactly what its one gradable reserve scores.
    const f = await asset(
      makeRaw({
        reserveTokens: [
          sac('USDC', { authRevocable: true }),
          token({
            address: 'CWASM',
            symbol: 'USDC.w',
            issuer: { status: 'notApplicable', reason: 'wasm-contract' },
          }),
        ],
      }),
    );
    assert.equal(f.value, 40);
    assert.match(f.detail, /1 of 2 excluded as non-SAC — disclosed, not graded/);
    const disclosure = f.components!.find((c) => c.label === 'USDC.w')!;
    assert.equal(disclosure.value, null);
    assert.match(disclosure.detail, /issuer flags do not apply/);
  });

  it('publishes one component per reserve, in reserve order', async () => {
    const f = await asset(
      makeRaw({ reserveTokens: [sac('A', {}), sac('B', { authRevocable: true }), sac('C', {})] }),
    );
    assert.deepEqual(
      f.components!.map((c) => c.id),
      ['reserve:CA', 'reserve:CB', 'reserve:CC'],
    );
  });
});

// ---------------------------------------------------------------------------
// operationalState
// ---------------------------------------------------------------------------

describe('operationalState', () => {
  const state = (o: RawOpts = {}) => adapter.operationalState(makeRaw(o));

  it('reads a pool with nothing killed as active', async () => {
    const s = state();
    assert.equal(s.level, OperationalLevel.Active);
    assert.deepEqual(s.blocked, []);
    assert.equal(s.origin, 'indeterminate');
  });

  it('classifies a killed swap as swapDisabled — the rung #100 question C added', async () => {
    // Under the ladder as it stood this would have read `active`: true about
    // exit, wrong about the market. `blocked` carried the fact and `level`, the
    // field a reader scans, did not.
    const s = state({ killed: { swap: true } });
    assert.equal(s.level, OperationalLevel.SwapDisabled);
    assert.deepEqual(s.blocked, ['swap']);
    assert.equal(s.origin, 'admin');
  });

  it('classifies a killed deposit as entryDisabled — exit is still open', async () => {
    const s = state({ killed: { deposit: true } });
    assert.equal(s.level, OperationalLevel.EntryDisabled);
    assert.deepEqual(s.blocked, ['deposit']);
  });

  it('names the worst rung when several switches are set, and orders blocked canonically', async () => {
    const s = state({ killed: { swap: true, deposit: true, claim: true } });
    assert.equal(s.level, OperationalLevel.EntryDisabled);
    // Swap, deposit, withdraw, claim — the order a user meets them in, not
    // alphabetical, which would open on `claim`.
    assert.deepEqual(s.blocked, ['swap', 'deposit', 'claim']);
  });

  it('reports a killed claim without moving the level — principal is unaffected', async () => {
    // An LP whose reward claim is killed can still withdraw every unit of
    // principal, so `claim` gets no rung. Same reasoning lending gives for
    // repay and liquidate.
    const s = state({ killed: { claim: true } });
    assert.equal(s.level, OperationalLevel.Active);
    assert.deepEqual(s.blocked, ['claim']);
  });

  it('never reports withdraw as blocked — there is no kill_withdraw to read', async () => {
    // The strongest single fact about an Aquarius LP's exit risk, and a property
    // of the deployed code. `exitDisabled` stays on the shared ladder for a
    // second DEX that CAN freeze withdrawals; Aquarius cannot reach it.
    for (const killed of [
      {},
      { swap: true },
      { deposit: true },
      { claim: true },
      { swap: true, deposit: true, claim: true },
    ]) {
      const s = state({ killed, emergencyMode: true, routerEmergency: true });
      assert.ok(!s.blocked.includes('withdraw' as never), 'withdraw must never appear');
      assert.notEqual(s.level, OperationalLevel.ExitDisabled);
    }
  });

  it('puts the router reading first, so a tie keeps the protocol-wide source', async () => {
    // `mostRestrictive` keeps the FIRST reading on a tie. "The router is in
    // emergency mode" tells a reader more than "this pool is clear" when both
    // classify the same.
    assert.equal(state().source, 'router.get_emergency_mode() = false');
    const emergency = state({ routerEmergency: true });
    assert.equal(emergency.source, 'router.get_emergency_mode() = true');
    assert.equal(emergency.origin, 'admin');
    assert.match(emergency.detail, /is in emergency mode/);
  });

  it('lets a real restriction beat the router tie-break', async () => {
    const s = state({ routerEmergency: true, killed: { deposit: true } });
    assert.equal(s.level, OperationalLevel.EntryDisabled);
    assert.match(s.source, /get_is_killed_swap/);
  });

  it('publishes emergency mode without claiming which operations it gates', async () => {
    // Neither #100's census nor #101's reads established what
    // `get_emergency_mode()` refuses. Listing operations it MIGHT refuse would
    // put a guess into the one field defined as "every operation the protocol's
    // own gating logic currently refuses".
    const s = state({ emergencyMode: true });
    assert.deepEqual(s.blocked, []);
    assert.equal(s.level, OperationalLevel.Active);
    assert.match(
      adapter.operationalState(makeRaw({ emergencyMode: true, killed: { swap: true } })).detail,
      /published without a claim about what it gates/,
    );
  });

  it('never infers neverOpened from emptiness', async () => {
    // Aquarius publishes no explicit "not opened yet" state — a pool is live
    // from creation, and 46 of the 340 simply hold nothing. An empty pool is an
    // empty market, and there is no size floor to infer one from either.
    const empty = state({ reserves: [0n, 0n], totalShares: 0n });
    assert.equal(empty.level, OperationalLevel.Active);
    assert.notEqual(empty.level, OperationalLevel.NotOperational);
    assert.deepEqual(empty.blocked, []);
  });

  it('stamps asOf from the fetch clock, not from when the test ran', async () => {
    assert.equal(state().asOf, new Date(FETCHED_AT * 1000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// The #15 invariant, re-grounded
// ---------------------------------------------------------------------------

describe('operationalState never reaches a score', () => {
  /**
   * Every operational state this adapter can publish: the eight kill-switch
   * combinations, crossed with the pool's and the router's emergency-mode flags.
   */
  const everyState = (): AquariusRawData[] => {
    const out: AquariusRawData[] = [];
    for (const swap of [false, true])
      for (const deposit of [false, true])
        for (const claim of [false, true])
          for (const emergencyMode of [false, true])
            for (const routerEmergency of [false, true])
              out.push(
                makeRaw({ killed: { swap, deposit, claim }, emergencyMode, routerEmergency }),
              );
    return out;
  };

  it('produces a byte-identical factor map across every operational state', async () => {
    // THE CORRECTNESS CHECK FOR THE WHOLE ROUTE-(C) DECISION (#15). If any kill
    // switch or emergency flag ever moves any factor, the rulebook has silently
    // acquired a third signal and the category version is wrong.
    //
    // RE-GROUNDED FROM WHAT #103 ORIGINALLY DESCRIBED. That issue built this
    // test around `estimate_swap` reverting on a swap-killed pool, which was the
    // one place the kill switches could have leaked into a number. There is no
    // `estimate_swap` call anywhere in this adapter — `depthSafety` is deferred
    // — so that failure mode does not exist. What remains is the invariant
    // itself, and it holds structurally: neither factor reads `killed` or
    // `emergencyMode` at all. This asserts it rather than trusting it, over all
    // 32 states rather than the one the issue named.
    const baseline = await factors(makeRaw());
    for (const raw of everyState()) {
      assert.deepEqual(
        await factors(raw),
        baseline,
        `killed=${JSON.stringify(raw.killed)} emergency=${raw.emergencyMode}/${raw.router.emergencyMode} moved a factor`,
      );
    }
  });

  it('scores the same in every operational state', async () => {
    const scores = new Set<number>();
    for (const raw of everyState()) scores.add(adapter.score(await factors(raw)).score);
    assert.equal(scores.size, 1, `restrictions produced different scores: ${[...scores]}`);
  });

  it('classifies genuinely differently across those same states', async () => {
    // The other half of the claim: the states are not inert everywhere, only in
    // the factor map. If `operationalState` collapsed to one answer this whole
    // suite would pass while publishing nothing.
    const levels = new Set(everyState().map((raw) => adapter.operationalState(raw).level));
    assert.deepEqual([...levels].sort(), ['active', 'entryDisabled', 'swapDisabled']);
  });
});

// ---------------------------------------------------------------------------
// Pool types
// ---------------------------------------------------------------------------

describe('the three pool types go through one code path', () => {
  it('produces an identical factor map for every pool type, including an unknown fourth', async () => {
    // Neither factor is size-sensitive and neither depends on the curve, so
    // nothing in ./score.ts reads `poolType`, `reserves`, `totalShares` or
    // `feeFraction`. That is what lets a `concentrated` pool — whose
    // `get_reserves` is NOT the tradable balance — be scored by the same code as
    // a constant-product one without either number being misread.
    const baseline = await factors(makeRaw({ poolType: 'constant_product' }));
    for (const poolType of ['stable', 'concentrated', 'balancer' as never] as const) {
      assert.deepEqual(
        await factors(makeRaw({ poolType })),
        baseline,
        `${poolType} moved a factor`,
      );
    }
  });

  it('reports an unrecognised pool type and claims nothing about it', async () => {
    // The fetch layer refuses such a pool before any of it is read
    // (`fetchAquariusRawData` throws), so there is no scored path to reach —
    // the same shape as `BlendAdapter.operationalState` handling a status
    // outside Blend V2's seven. What matters is that the message describes the
    // reading and makes no claim about the curve.
    const message = unrecognisedPoolType('CPOOL', 'balancer');
    assert.match(message, /reports pool_type\(\) = "balancer"/);
    assert.match(message, /constant_product, stable, concentrated/);
    assert.match(message, /nothing is claimed about this pool/);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('metadata', () => {
  it('names the pool this instance was handed, not a module default', async () => {
    // `contractId` must name the contract the score was derived from, or a wrong
    // reading gets attached to a real address in an explorer link. There is no
    // default pool at all — Aquarius has 340 and none is reviewed as the
    // flagship (#104).
    const a = new AquariusAdapter({ pool: { id: 'p1', name: 'One', poolId: 'CONE' } });
    const b = new AquariusAdapter({ pool: { id: 'p2', name: 'Two', poolId: 'CTWO' } });
    assert.equal(a.metadata.contractId, 'CONE');
    assert.equal(b.metadata.contractId, 'CTWO');
    assert.equal(a.metadata.id, 'p1');
  });

  it('declares the dex category and a literal adapterRef', async () => {
    // `adapterRef` must never come from `this.constructor.name`: the workspace
    // is bundled and minified into the dashboard's serverless functions, so a
    // derived name is right in every test and wrong in the only environment that
    // writes the data.
    assert.equal(adapter.metadata.category, 'dex');
    assert.equal(adapter.metadata.adapterRef, 'AquariusAdapter');
  });

  it('carries deployedOn when the pool declares one', async () => {
    const labelled = new AquariusAdapter({
      pool: {
        id: 'p3',
        name: 'Three',
        poolId: 'CTHREE',
        deployedOn: { host: 'Aquarius', label: 'Aquarius AMM pool' },
      },
    });
    assert.deepEqual(labelled.metadata.deployedOn, {
      host: 'Aquarius',
      label: 'Aquarius AMM pool',
    });
    assert.equal(adapter.metadata.deployedOn, undefined);
  });
});
