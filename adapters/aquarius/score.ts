// Everything derived from already-fetched raw state: the two scored `dex`
// factors and the flag reading behind the live ungraded `operationalState`.
//
// Pure functions of `AquariusRawData` — no RPC, no clock, no instance state — so
// every rule in methodology/dex.md can be exercised from a fixture, including
// the ones no live pool is in today (a reverting role map, a matured upgrade
// deadline, a clawback-enabled issuer).
//
// TWO FACTORS, AND THERE IS NO DEPTH READ ANYWHERE IN THIS FILE. `depthSafety`
// was deferred by question A in methodology/dex.md — Aquarius publishes no
// on-chain unit of value to denominate a trade size in — so `estimate_swap` is
// not called, not stubbed and not flagged off, here or in ./fetch.ts. Dormant
// code for a deferred factor is how a deferral quietly becomes an
// implementation.
//
// NOTHING HERE READS `raw.poolType`, `raw.reserves`, `raw.totalShares` OR
// `raw.feeFraction`, and that is a property worth stating rather than an
// accident. Neither factor is size-sensitive (methodology/dex.md, "Size floor:
// none, and none pending") and neither depends on the curve, so all three pool
// types — and a fourth the router might one day deploy — go through one code
// path with nothing special-cased. `score.test.ts` pins it.

import { DEX_FACTORS, DexOperation, mostRestrictive, toDexOperationalState } from '@stenion/core';
import type {
  DexFactorMap,
  OperationalState,
  RiskFactor,
  RiskFactorComponent,
} from '@stenion/core';

import { AQUARIUS_ROLES } from './types.ts';
import type {
  AquariusRawData,
  AquariusRoleRaw,
  AquariusRolesRead,
  AquariusTokenRaw,
  AquariusUpgradeRaw,
} from './types.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

/** First 6 chars of an address, for detail strings. */
const short = (a: string): string => `${a.slice(0, 6)}…`;

/**
 * Minimum over a list — and **`0` over an empty one**, never 100.
 *
 * THE ONE HELPER IN THIS FILE THAT EXISTS FOR A BUG THAT ALREADY SHIPPED.
 * Lending's `liquiditySafety` and `utilizationSafety` returned **100** from a
 * `Math.min` over an empty filtered set on 2026-08-16 — "maximally safe", from
 * no data — and the correction is in lending's changelog. `Math.min()` with no
 * arguments is `Infinity`, which then clamps to 100; every "minimised over" rule
 * in methodology/dex.md is written to resolve to 0 when there is nothing to
 * minimise over. So the empty case is handled here, once, rather than at each of
 * the call sites.
 */
function worst(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

/**
 * The two `dex` factors — methodology/dex.md, weighted 0.55 / 0.45.
 *
 * Keyed by `DexFactorMap`, which is `keyof typeof DEX_FACTORS`, so a factor
 * added to or removed from `CATEGORY_FACTORS.dex` breaks this object rather than
 * letting the adapter publish a map the rulebook does not describe. Deliberately
 * NOT keyed off `RiskFactorType`: that enum is lending's five, and
 * `assetControlSafety` is not one of them.
 */
export function computeAquariusRiskFactors(raw: AquariusRawData): DexFactorMap {
  return {
    adminKeySafety: adminKeySafety(raw),
    assetControlSafety: assetControlSafety(raw),
  };
}

// ---------------------------------------------------------------------------
// 1. adminKeySafety — seven roles, and the upgrade reaction window
//    methodology/dex.md §1, weight 0.55
// ---------------------------------------------------------------------------

/**
 * One privileged account's posture, on lending's per-account tiers.
 *
 * THE INTEGERS ARE LENDING'S, ADOPTED BY REFERENCE RATHER THAN RE-ARGUED —
 * `90` for an N-of-M multisig, `40` for a single master key, `−3` per operation
 * capped at `−30`. methodology/dex.md §1 says why: the reading underneath is
 * identical on both sides (Stellar's account threshold model and a 30-day
 * operation count, from the same two Horizon calls), so a second set of integers
 * for one reading would be two rulebooks for one question.
 *
 * THE CONTRACT-ADDRESS BRANCH IS `0` HERE AND `60` IN LENDING, and that is the
 * one deliberate departure. Lending's 60 is anchored to a contract admin being a
 * *known, named* structure it chose not to grade; an Aquarius role that is not a
 * classic account is a structure we did not expect and cannot describe, and a
 * neutral score for an unexpected reading is an invented number.
 */
function accountScore(entry: AquariusRoleRaw['accounts'][number]): {
  value: number;
  note: string;
} {
  if (entry.status === 'contract') {
    return {
      value: 0,
      note: `${short(entry.address)} is a contract address — no signer set or activity to read`,
    };
  }
  if (entry.status === 'failed') {
    return { value: 0, note: `${short(entry.address)} could not be read (${entry.reason})` };
  }

  const { highThreshold, signerCount, recentOps, activityWindowDays } = entry.account;
  const multisig = signerCount > 1 && highThreshold > 1;
  const base = multisig ? 90 : 40;
  const activityPenalty = Math.min(30, recentOps * 3);
  return {
    value: clamp(base - activityPenalty),
    note:
      `${multisig ? 'multisig' : 'single-key'} ${short(entry.address)} ` +
      `(${signerCount} signer(s), high-threshold ${highThreshold}), ` +
      `${recentOps} op(s) in ${activityWindowDays}d`,
  };
}

/**
 * One role's score: the minimum over every address the role holds.
 *
 * MINIMISED OVER THE ADDRESSES, never `addresses[0]`. `get_privileged_addrs()`
 * returns `role -> Vec<Address>`, not `role -> Address` — every role holds
 * exactly one today, and the contract's own type permits several. Reading the
 * first would silently drop a co-holder the day one is added, which is the same
 * class of mistake the fetch side caught and fixed when it decoded the same
 * map; the scoring side must not reintroduce it.
 *
 * A role holding no readable address at all is `0` on `worst`'s empty rule —
 * "we could not read who controls this pool" is a statement about the pool, and
 * the unsafe end is the only honest place for it.
 */
function roleScore(role: AquariusRoleRaw): { value: number; note: string } {
  if (role.accounts.length === 0) {
    return {
      value: 0,
      note: `${role.role}: no readable holder among ${role.addresses.length} declared address(es)`,
    };
  }
  const scored = role.accounts.map(accountScore);
  const value = worst(scored.map((s) => s.value));
  const binding = scored.filter((s) => s.value === value).map((s) => s.note);
  return {
    value,
    note:
      scored.length === 1
        ? `${role.role} ${binding[0]}`
        : `${role.role} worst of ${scored.length} holders: ${binding.join(' / ')}`,
  };
}

/**
 * Role posture for one contract's role map, or the reading that says it could
 * not be assessed.
 *
 * Three of methodology/dex.md's cannot-assess branches land here and all three
 * resolve to **0**: the call reverted, it returned fewer than the seven expected
 * roles, or a role that came back cannot be graded. A short map in particular is
 * not partially graded — grading the roles that *did* come back would publish a
 * posture assessment of an admin set we know is incomplete.
 */
function rolePosture(read: AquariusRolesRead, where: string): { value: number; note: string } {
  if (read.status === 'failed') {
    return { value: 0, note: `${where} get_privileged_addrs() did not read: ${read.reason}` };
  }
  if (read.status === 'short') {
    return {
      value: 0,
      note:
        `${where} get_privileged_addrs() returned ${read.roles.length} of ` +
        `${AQUARIUS_ROLES.length} expected roles — missing ${read.missing.join(', ')}`,
    };
  }
  const scored = read.roles.map(roleScore);
  const value = worst(scored.map((s) => s.value));
  const binding = scored.filter((s) => s.value === value).map((s) => s.note);
  return {
    value,
    note: `${where}: worst of ${scored.length} roles — ${binding.join('; ')}`,
  };
}

/**
 * The upgrade reaction window, from `UpgradeDeadline` and the fetch clock.
 *
 * NO STENION CONSTANT IS IN THE MATURED BRANCH. What this grades is
 * `UpgradeDeadline − now`; once that is non-positive the measured warning is
 * zero, and the chain states both halves. The `40` in the open-window branch is
 * not a new constant either — it is the single-master-key tier reused, because
 * while a change is scheduled the LP's only remaining protection is a countdown
 * whose *length* cannot be read at all.
 *
 * `deadline === null` is NOT `0n` and must not be collapsed into it: one says
 * the contract answered "nothing pending", the other says this contract does not
 * keep the field this component reads. The second means an unexpected contract
 * version with half this factor's input missing — **0**, on the same reasoning a
 * short role map takes.
 */
function upgradeCeiling(
  upgrade: AquariusUpgradeRaw,
  fetchedAt: number,
  where: string,
): { value: number; note: string } {
  const { deadline, futureWasm, runningWasm, stagedDiffers } = upgrade;

  // Read but NOT graded — methodology/dex.md §1. Every contract read on
  // 2026-08-29 carried a FutureWASM equal to its own running hash, so presence
  // is the quiescent state rather than the signal; `UpgradeDeadline` is what says
  // a change is scheduled. A reader still wants to know which code is staged, so
  // it is published in the note.
  const staged =
    futureWasm === null
      ? 'no FutureWASM entry'
      : stagedDiffers
        ? `FutureWASM ${futureWasm.slice(0, 8)}… differs from the running ${String(runningWasm).slice(0, 8)}…`
        : `FutureWASM ${futureWasm.slice(0, 8)}… matches the running code`;

  if (deadline === null) {
    return {
      value: 0,
      note: `${where} carries no UpgradeDeadline entry at all — unexpected contract version (${staged})`,
    };
  }
  if (deadline === 0n) {
    return {
      value: 100,
      note: `${where} UpgradeDeadline = 0 — no code change scheduled (${staged})`,
    };
  }
  const now = BigInt(fetchedAt);
  if (deadline > now) {
    return {
      value: 40,
      note:
        `${where} upgrade scheduled — UpgradeDeadline ${deadline} is ${Number(deadline - now)}s ` +
        `away; the window is open, but its full length is not readable (${staged})`,
    };
  }
  return {
    value: 0,
    note:
      `${where} UpgradeDeadline ${deadline} matured ${Number(now - deadline)}s ago — applicable ` +
      `at the next ledger, with no warning left (${staged})`,
  };
}

/**
 * `adminKeySafety = min(rolePosture, upgradeCeiling)` — methodology/dex.md §1.
 *
 * BOTH COMPONENTS ARE MINIMISED OVER THE POOL **AND** THE ROUTER, because both
 * are the factor's declared anchors ("`get_privileged_addrs()` on the router and
 * on every pool") and because the cannot-assess table sends a revert "on the
 * router or on the pool" to 0. The two read identically on every pool sampled —
 * but a per-pool `set_privileged_addrs` exists, and a router upgrade changes the
 * code under every pool, so treating either as redundant would make the adapter
 * unable to report the day they diverge. methodology/dex.md's worked example
 * collapses them into one table because that fixture's two agree, not because
 * only one is read.
 */
function adminKeySafety(raw: AquariusRawData): RiskFactor {
  const weight = DEX_FACTORS.adminKeySafety.weight;

  const posture = binding(rolePosture(raw.roles, 'pool'), rolePosture(raw.router.roles, 'router'));
  const ceiling = binding(
    upgradeCeiling(raw.upgrade, raw.fetchedAt, 'pool'),
    upgradeCeiling(raw.router.upgrade, raw.fetchedAt, 'router'),
  );

  const value = Math.min(posture.value, ceiling.value);

  const components: RiskFactorComponent[] = [
    {
      id: 'rolePosture',
      label: 'Privileged role posture',
      value: posture.value,
      detail: posture.note,
    },
    {
      id: 'upgradeWindow',
      label: 'Upgrade reaction window',
      value: ceiling.value,
      detail: ceiling.note,
    },
    // Route (a) disclosures — methodology/dex.md §1, "Two limits, stated rather
    // than papered over". `value: null` means measured-and-deliberately-ungraded,
    // never missing data, and neither moves the number in either direction.
    {
      id: 'timelockDuration',
      label: 'Timelock duration',
      value: null,
      detail:
        'ADMIN_ACTIONS_DELAY is a compile-time constant with no getter, confirmed absent from all ' +
        'four deployed wasms, so the LENGTH of the upgrade window is not readable from the ' +
        'contract. The deadline and the current time are, which is why the window is graded as a ' +
        'state and never as a fraction remaining.',
    },
    {
      id: 'emergencyBypass',
      label: 'Emergency Admin bypass',
      value: null,
      detail:
        'Aquarius\'s own response to Certora H-01: "In the case of system vulnerability fixes, ' +
        'delay may be bypassed by the Emergency Admin role." So the reaction window is ' +
        'conditional on one single-signer key choosing not to skip it. Disclosed rather than ' +
        'folded in, because "a window exists" and "the window is unconditional" are different ' +
        'claims and only the first is true.',
    },
  ];

  return {
    value: Math.round(value),
    weight,
    detail:
      posture.value <= ceiling.value
        ? `role posture binds at ${posture.value} — ${posture.note}`
        : `a pending upgrade caps the score at ${ceiling.value} — ${ceiling.note}`,
    components,
  };
}

/**
 * The worse of two readings of the same quantity, keeping both notes with the
 * binding one first. Ties keep the FIRST argument, so callers pass the pool's
 * own reading ahead of the router's — when both say the same thing, the pool is
 * the one a reader of this pool's page came for.
 */
function binding(
  a: { value: number; note: string },
  b: { value: number; note: string },
): { value: number; note: string } {
  return a.value <= b.value
    ? { value: a.value, note: `${a.note} | ${b.note}` }
    : { value: b.value, note: `${b.note} | ${a.note}` };
}

// ---------------------------------------------------------------------------
// 2. assetControlSafety — can a third party freeze or seize what the pool holds
//    methodology/dex.md §2, weight 0.45
// ---------------------------------------------------------------------------

/**
 * One reserve token's tier, or `null` for a token this factor does not apply to.
 *
 * THE ORDER THE TIERS ARE TESTED IN IS LOAD-BEARING, and methodology/dex.md says
 * so: clawback before revocable, and both before immutable. `auth_immutable`
 * freezes whatever the flags currently *are*, so it is a credit only when what it
 * freezes is clean — an issuer that is both immutable and revocable has made its
 * freeze power permanent and scores **40**, not 100. Testing immutability first
 * would invert exactly that case.
 *
 * `auth_required` moves no number, deliberately: it gates who may *acquire* the
 * asset and does not let an issuer touch a balance that already exists. Read and
 * published in the note, not graded.
 *
 * THE FOUR ISSUER-READ ARMS ARE FOUR DIFFERENT FACTS AND MUST NOT COLLAPSE:
 *
 * - `noIssuer` (native XLM) is `100` — a positive fact, "nobody can seize this".
 * - `failed` is `0` — the token IS a SAC, so its flags are exactly what this
 *   factor grades, and we could not read them. Routing it like `notApplicable`
 *   would silently upgrade an unknown into an exemption, which methodology/dex.md
 *   calls the single most dangerous confusion available in this factor.
 * - `notApplicable` (a wasm contract, not a SAC) is `null` — route (a): excluded
 *   from the computation, disclosed by name, graded neither well nor badly.
 */
function tokenScore(token: AquariusTokenRaw): { value: number | null; note: string } {
  // Asset CODE first, then the contract's own `symbol()`. Native XLM reports
  // `symbol = native` and `code = XLM`, so symbol-first would label the most
  // common token in the registry "native" in every detail string it appears in.
  const name = `${token.code ?? token.symbol ?? 'token'} ${short(token.address)}`;
  const issuer = token.issuer;

  if (issuer.status === 'noIssuer') {
    return { value: 100, note: `${name}: native XLM — a SAC with no issuer account to act from` };
  }
  if (issuer.status === 'notApplicable') {
    return {
      value: null,
      note: `${name}: not a Stellar Asset Contract (${issuer.reason}) — issuer flags do not apply`,
    };
  }
  if (issuer.status === 'failed') {
    const who = issuer.issuer === null ? '' : ` ${short(issuer.issuer)}`;
    return {
      value: 0,
      note:
        `${name}: is a SAC, but its issuer${who} could not be read (${issuer.reason}) — ` +
        'the read applies and did not happen',
    };
  }

  const f = issuer.flags;
  const who = `${name}: issuer ${short(issuer.issuer)}`;
  const required = f.authRequired ? ', auth_required set (read, not graded)' : '';

  if (f.authClawbackEnabled) {
    return {
      value: 0,
      note: `${who} has auth_clawback_enabled — can seize the pool's balance${required}`,
    };
  }
  if (f.authRevocable) {
    return {
      value: 40,
      note: `${who} has auth_revocable — can freeze the pool's balance${required}`,
    };
  }
  if (f.authImmutable) {
    return {
      value: 100,
      note: `${who} is auth_immutable with revocable and clawback both clear — the flags can never change${required}`,
    };
  }
  return {
    value: 70,
    note: `${who} has all four flags clear but is not auth_immutable — one SET_OPTIONS from revocable${required}`,
  };
}

/**
 * `assetControlSafety = min(tokenScore)` over the pool's gradable reserves, and
 * **0 when none is gradable** — methodology/dex.md §2.
 *
 * MINIMISED OVER `reserveTokens`, WHOSE LENGTH IS THE SOURCE OF TRUTH FOR ARITY.
 * Three of the 304 token sets have three members and nothing here indexes `[0]`
 * or `[1]`, so a three-token stable pool scores through the identical path a pair
 * does.
 *
 * Because this is a minimum, the *lenient* tier is what binds for any pool
 * holding at least one freeze-capable asset: a pool of Circle USDC (revocable)
 * and two clean tokens publishes 40, not the 60 an average would give. That is
 * the worst-reserve convention every factor in this project uses, and it is the
 * point — an LP's exposure is not diluted by the assets that are fine.
 */
function assetControlSafety(raw: AquariusRawData): RiskFactor {
  const weight = DEX_FACTORS.assetControlSafety.weight;

  const scored = raw.reserveTokens.map((token) => ({ token, ...tokenScore(token) }));
  const graded = scored.filter((s): s is typeof s & { value: number } => s.value !== null);
  const value = worst(graded.map((s) => s.value));

  const components: RiskFactorComponent[] = scored.map((s) => ({
    id: `reserve:${s.token.address}`,
    label: s.token.code ?? s.token.symbol ?? s.token.address,
    value: s.value,
    detail: s.note,
  }));

  const excluded = scored.length - graded.length;
  const excludedNote =
    excluded === 0
      ? ''
      : ` (${excluded} of ${scored.length} excluded as non-SAC — disclosed, not graded)`;
  const bindingNotes = graded.filter((s) => s.value === value).map((s) => s.note);

  return {
    value: Math.round(value),
    weight,
    detail:
      graded.length === 0
        ? `no reserve token is gradable — all ${scored.length} are wasm contracts with no ` +
          'issuer-flag equivalent, so there is nothing to minimise over'
        : `worst of ${graded.length} gradable reserve(s)${excludedNote}: ${bindingNotes.join('; ')}`,
    components,
  };
}

// ---------------------------------------------------------------------------
// Live ungraded state — route (c), published beside the score and never in it
// ---------------------------------------------------------------------------

/**
 * The kill switches and emergency mode → the shared operational state. Not
 * scored; see methodology/publishing-rules.md.
 *
 * TWO READINGS, ROUTER FIRST — WITH ONE EXPLICIT EXCEPTION. The router's
 * `get_emergency_mode()` is the protocol-wide statement and the pool's own
 * switches are the local one, the same shape Kinetic's
 * global-pause-then-per-reserve reading takes. The router goes first because
 * `mostRestrictive` keeps the FIRST reading on a tie, and "the protocol is in
 * emergency mode" is the more informative of two *identical* classifications.
 *
 * THE EXCEPTION IS `claim`, AND IT IS A REAL FAILURE THIS ORDERING CAUSED.
 * `mostRestrictive` selects a whole reading, not a merged one, so whichever
 * reading loses takes its `blocked` list with it. `claim` deliberately has no
 * rung on the ladder — an LP whose reward claim is killed can still withdraw
 * every unit of principal — so a claim-killed pool ties the clean router at
 * `active`, the router wins the tie, and `blocked: ['claim']` is dropped on the
 * floor. That inverts the rule this whole method is written to satisfy: the
 * `blocked` list is what carries the truth, and `level` may not.
 *
 * So the pool reading goes first whenever it has anything to report, and the
 * router keeps the tie only when neither has. Both readings say the same thing
 * in that case — which is the exact condition `mostRestrictive` documents its
 * tie rule for — and nothing is lost either way. Caught by `score.test.ts`, not
 * reasoned about in advance.
 *
 * THERE IS NO `kill_withdraw`, so `withdraw` never appears in `blocked` and
 * `exitDisabled` is unreachable from Aquarius. The pool wasms export `kill_swap`,
 * `kill_deposit`, `kill_claim`, `kill_gauges_claim` and their `unkill_`
 * counterparts and no withdraw equivalent — a property of the deployed code, not
 * a promise — and `AquariusKillFlagsRaw` has no `withdraw` member, so this
 * function could not report one if it tried.
 *
 * EMERGENCY MODE BLOCKS NOTHING HERE, AND THAT IS A REFUSAL TO INVENT RATHER
 * THAN AN OVERSIGHT. Neither the rulebook's census of the contracts nor this
 * adapter's own reads established which user operations `get_emergency_mode()`
 * gates; the flag is read from a getter
 * and its authorisation effect was never confirmed against the wasm. Listing
 * operations it *might* refuse would put a guess into the one field defined as
 * "every operation the protocol's own gating logic currently refuses", so the
 * readings carry the flag verbatim in `source` and `detail` and claim nothing in
 * `blocked`. If a later read establishes what it gates, that is a change to this
 * function with a test, not a shrug.
 *
 * `neverOpened` IS FALSE ON EVERY PATH AND IS NEVER INFERRED FROM EMPTINESS.
 * `OperationalReading.neverOpened` is set only where the protocol publishes an
 * explicit "not opened yet" state, the way Blend does with `status == 6`.
 * Aquarius publishes none: a pool is live from creation, and 46 of the 340 hold
 * nothing. An empty Aquarius pool is an empty market, not an unopened one — and
 * there is no size floor to infer one from either (methodology/dex.md, "Size
 * floor: none, and none pending").
 */
export function aquariusOperationalState(raw: AquariusRawData): OperationalState<'dex'> {
  const asOf = new Date(raw.fetchedAt * 1000);

  const router = toDexOperationalState({
    blocked: [],
    neverOpened: false,
    source: `router.get_emergency_mode() = ${raw.router.emergencyMode}`,
    origin: raw.router.emergencyMode ? 'admin' : 'indeterminate',
    detail: raw.router.emergencyMode
      ? `the AMM router ${short(raw.router.routerId)} is in emergency mode; which operations that ` +
        'gates is not established from the deployed code, so nothing is claimed as blocked'
      : `the AMM router ${short(raw.router.routerId)} is not in emergency mode`,
    asOf,
  });

  const { swap, deposit, claim } = raw.killed;
  const blocked = [
    ...(swap ? [DexOperation.Swap] : []),
    ...(deposit ? [DexOperation.Deposit] : []),
    ...(claim ? [DexOperation.Claim] : []),
  ];

  const pool = toDexOperationalState({
    blocked,
    neverOpened: false,
    source:
      `get_is_killed_swap/_deposit/_claim = ${swap}/${deposit}/${claim}, ` +
      `get_emergency_mode() = ${raw.emergencyMode}`,
    // Every kill switch is an admin operation — `kill_swap` and its siblings take
    // a privileged address — so a set flag has a named origin. A clear pool says
    // `indeterminate` rather than claiming nothing has ever gated it.
    origin: blocked.length > 0 || raw.emergencyMode ? 'admin' : 'indeterminate',
    detail:
      (blocked.length === 0
        ? 'no kill switch is set on this pool'
        : `${blocked.join(', ')} halted by an Aquarius role`) +
      (raw.emergencyMode
        ? '; the pool is in emergency mode, published without a claim about what it gates'
        : '') +
      '. Withdrawals cannot be halted: the pool wasms export no kill_withdraw.',
    asOf,
  });

  // See the note above: router first for the tie's sake, pool first whenever the
  // pool has a restriction to report, so a rung-less operation is never dropped.
  return mostRestrictive(blocked.length > 0 ? [pool, router] : [router, pool]);
}
