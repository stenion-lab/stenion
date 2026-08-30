// Mainnet wiring, the raw on-chain shape, and the adapter's options — the leaf
// of this adapter's module graph. Everything here is either a type or a
// constant; nothing reads the chain and nothing scores.
//
// SCOPE OF THIS FILE. This is the FETCH half only. `dex` ships with two factors
// — `adminKeySafety` and `assetControlSafety` — and this file reads nothing in
// order to produce a number: it is either a type or a constant throughout. The
// raw shape is nonetheless the place every pool-type divergence and every
// unreadable quantity has to be resolved, and those decisions outlive whichever
// formula eventually reads them.
//
// THERE IS NO DEPTH READ IN THIS ADAPTER, ANYWHERE. `estimate_swap` is not
// called, not stubbed and not flagged off. `depthSafety` was deferred by
// question A in `methodology/dex.md` — Aquarius publishes no unit of value to
// denominate a trade size in — and dormant code for a deferred factor is how a
// deferral quietly becomes an implementation. If depth is revisited, that is a
// fresh issue reopening option 4, not a commented-out call sitting here.

import { Networks } from '@stellar/stellar-sdk';
import type { ProtocolDeployment, ProtocolLinks } from '@stenion/core';

// ---------------------------------------------------------------------------
// Mainnet wiring
//
// Every address and every interface claim below was read from the deployed wasm
// and from ledger state, never from documentation — and for this protocol that
// is forced rather than preferred: `github.com/AquaToken/soroban-amm`, the
// repository Aquarius's own audit scope links to, returns 404. There is no
// source to check against, which is exactly the situation TAXONOMY.md Gate 8
// describes when it says to confirm reads against the contract.
//
// ONE WASM PER POOL TYPE, verified against the router's own declared hashes and
// re-confirmed live on 2026-08-29 (ledger 64,176,303):
//
//   constant_product  ae0da5a84b15805c5c7931ac567a8d1b34be3f26b483993d9ff80cb2c3de9852
//   stable            f1077e0b77da5e62d596e13aeae4160104cad99e7ef7f3183a6c9b6ec9e747cd
//   concentrated      12fca5a7a96577273b6d4184cf9c984036cda0e8f0594747e7b2933dced37ee6
//
// So a second Aquarius market is a config entry and no new scoring code, the
// same rule BLEND_POOLS runs under. Nothing on `AquariusPool` may be a
// threshold, weight or formula.
// ---------------------------------------------------------------------------

export const NETWORK_PASSPHRASE = Networks.PUBLIC;

/** Public, key-less Soroban mainnet RPC. Overridable for self-hosting. */
export const DEFAULT_RPC_URL = 'https://mainnet.sorobanrpc.com';

/** Public Horizon — admin signer/activity and issuer flags, which Soroban RPC does not expose. */
export const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/**
 * Aquarius's AMM router. Read for protocol-wide identity and for the role set
 * as the protocol declares it globally.
 *
 * `contract_name() = "AMMRouter"`, `version() = 200`, confirmed live.
 */
export const AQUARIUS_ROUTER_ID = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK';

/**
 * The seven privileged roles `get_privileged_addrs()` returns, in the order this
 * adapter publishes them.
 *
 * THE COUNT IS LOAD-BEARING, and it is why this is a constant rather than
 * "whatever keys came back". `methodology/dex.md` sends `adminKeySafety` to the
 * unsafe end when the role map is SHORT — a map missing a role is either an
 * unexpected contract version or a role we cannot see, and grading the roles
 * that did come back would publish a posture assessment of an admin set we know
 * is incomplete. Comparing against a fixed expected set is what makes "short"
 * detectable at all; counting the keys the chain returned against itself always
 * succeeds.
 *
 * All seven were present on the router and on every pool sampled on 2026-08-29.
 */
export const AQUARIUS_ROLES = [
  'Admin',
  'EmergencyAdmin',
  'EmergencyPauseAdmin',
  'PauseAdmin',
  'OperationsAdmin',
  'RewardsAdmin',
  'SystemFeeAdmin',
] as const;
export type AquariusRole = (typeof AQUARIUS_ROLES)[number];

/**
 * The three pool types the router can deploy, as `pool_type()` reports them.
 *
 * **`constant_product`, NOT `standard`.** The rulebook prose and this adapter's
 * own design notes both called the constant-product type "standard", which is
 * what Aquarius's own documentation calls it. The deployed contract returns the symbol
 * `constant_product` — read live on 2026-08-29 from a pool of each type. The
 * chain's spelling is the one in the code, because the code compares against
 * what the chain says; the prose is a naming discrepancy recorded in
 * `methodology/dex.md` rather than silently reconciled here.
 */
export const AQUARIUS_POOL_TYPES = ['constant_product', 'stable', 'concentrated'] as const;
export type AquariusPoolType = (typeof AQUARIUS_POOL_TYPES)[number];

/**
 * One Aquarius market this adapter can be pointed at.
 *
 * Everything here is IDENTITY — slug, display name, pool contract, mark, links.
 * Deliberately nothing here is a threshold, a weight or a formula: a field that
 * changed how a factor is computed would be a per-pool rulebook, which
 * methodology ground rule 1 forbids. Adding a pool must stay a data change.
 *
 * Shaped like `BlendPool` on purpose — the two adapters solve the same
 * targeting problem and there is no reason for them to solve it differently.
 */
export interface AquariusPool {
  /** registry slug — `protocols.id`, the public URL, and the API path segment */
  id: string;
  /** display name */
  name: string;
  /** the pool contract this entry is scored from */
  poolId: string;
  /** self-hosted mark, or omitted when the market publishes none */
  logo?: string;
  links?: ProtocolLinks;
  /**
   * Every Aquarius pool is a market on Aquarius's contracts rather than an
   * independent protocol, so an entry that is not Aquarius's own flagship
   * carries this — the same rule the YieldBlox pool on Blend carries it under.
   */
  deployedOn?: ProtocolDeployment;
}

/**
 * The XLM/USDC constant-product pool — the one Aquarius market registered.
 *
 * WHY ONE, AND WHY THIS ONE. Not because the rulebook excludes the other 339:
 * `dex` has **no size floor and no pending one** (`methodology/dex.md`,
 * "Size floor: none, and none pending"), because neither factor it scores is
 * size-sensitive — the same seven roles and the same issuers read on a pool
 * holding three stroops. Registration is a separate question about the indexer,
 * and the indexer's answer is a hard number: `cycleFeasibility()` allows
 * `ceil(targets / concurrency) * attemptTimeoutMs <= budgetMs`, and at
 * concurrency 1, a 10s attempt timeout and a budget that must stay inside
 * Vercel Hobby's 60s `maxDuration`, that ceiling is **five targets per
 * invocation** — five in total until a second shard is provisioned, since
 * sharding multiplies it by the number of cron jobs. Four are lending. So the
 * ceiling on this list is deployment capacity, not the census.
 *
 * The census is real and was re-read for this decision at ledger 64,182,824 on
 * 2026-08-29: 340 pools across 304 token sets, 272 constant_product / 42 stable
 * / 26 concentrated, 46 holding zero in every reserve, 148 XLM-paired of which
 * 18 hold zero XLM and 59 hold under one. Every one of them is scorable; 339 of
 * them are unregistered for want of a target slot, and that is what
 * `dashboard/app/lib/coverage.ts` says in the reader's terms.
 *
 * WHY THIS POOL, given exactly one slot: it is the deepest market
 * whose reserves are **both** gradable. Both tokens are Stellar Asset Contracts,
 * so nothing in `assetControlSafety` is excluded as a route-(a) disclosure — the
 * larger XLM/SolvBTC pool (21.4M XLM) holds a wasm token and would publish a
 * number computed from one of its two legs. Verified per pool against the
 * registration checklist at ledger 64,182,918 on 2026-08-29:
 *
 *   pool_type()               constant_product
 *   running wasm              ae0da5a8…de9852 — equals the router's own
 *                             `ConstantPoolHash`, read from its instance storage
 *   router's own listing      get_pools([XLM, USDC]) returns 4 pools; this is one
 *   get_reserves()            94,684,565,381,855 XLM · 16,992,377,778,125 USDC
 *                             (read from the POOL contract, never the plane)
 *   reserve token 1           CAS3J7GY… executable = contractExecutableStellarAsset,
 *                             METADATA.name = "native" — XLM, no issuer account
 *   reserve token 2           CCW67TSZ… SAC, METADATA.name =
 *                             "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
 *                             issuer home_domain = circle.com, flags
 *                             auth_revocable = true, clawback/immutable/required false
 *   kill switches             swap/deposit/claim all false; emergency_mode false
 *
 * THE LOOK-ALIKE CHECK IS NOT A FORMALITY. The registry holds two assets coded
 * `USDC`: Circle's `GA5ZSEJY…` (`home_domain = circle.com`) and a differently
 * issued `GCBYVQH3…`. This entry is pinned to the pool CONTRACT, and the issuer
 * above was read out of that pool's own reserve token — never matched by symbol.
 *
 * `deployedOn` IS DELIBERATELY ABSENT — see the decision recorded with it below.
 */
export const AQUARIUS_XLM_USDC: AquariusPool = {
  id: 'aquarius-xlm-usdc',
  name: 'Aquarius XLM/USDC',
  poolId: 'CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE',
  links: {
    // Chain-attested in the Etherfuse manner, not matched by name: the AQUA
    // issuer GBNZILST… publishes `home_domain = aqua.network` on-chain, and that
    // domain's SEP-1 stellar.toml carries ORG_NAME "Aquarius", ORG_URL
    // "https://aqua.network/" and a [[CURRENCIES]] entry naming the same issuer.
    // `docs.` is a subdomain of that attested apex (200 on 2026-08-29), the same
    // relationship BLEND_FIXED_V2 and BLEND_ETHERFUSE_V2 use for theirs.
    site: 'https://aqua.network',
    docs: 'https://docs.aqua.network',
  },
  // NO `logo`, AND THAT IS A DESIGNED STATE. The only mark Aquarius publishes is
  // hotlinked from its own stellar.toml (`ORG_LOGO`), and both hotlinking and
  // redrawing a wordmark to fit a tile are forbidden (ProtocolMetadata.logo).
  // The dashboard draws an initials tile, which is the supported answer.
  //
  // NO `deployedOn`, DECIDED RATHER THAN OMITTED. The field means "this
  // entry is a market running ANOTHER protocol's contracts" — YieldBlox on
  // Blend. An Aquarius pool runs Aquarius's contracts, so setting it would be a
  // category error, and it is the same reading under which Blend's own Fixed
  // pool (one market of several, on Blend's code) carries none. Three concrete
  // things decided it against setting `{ host: 'Aquarius', … }` anyway:
  //   1. `DeploymentNotice`'s published copy states the market's "reserves,
  //      oracle configuration and admin belong to this market and not to
  //      {host}". For an Aquarius pool the admin is Aquarius's own global role
  //      set — identical across all 340 — so the sentence would be FALSE.
  //   2. The badge and the notice both render "a {label}", which is ungrammatical
  //      for every label beginning "Aquarius…".
  //   3. What a reader actually needs to know — that this is one of 340 markets
  //      on one of three shared wasms — is a verifiable observation nobody
  //      grades, which is what the Findings section exists for. It is published
  //      there (`dashboard/app/lib/protocol-notes.ts`), where it can be stated
  //      precisely instead of compressed into a pill.
  // The entry's NAME carries the rest: "Aquarius XLM/USDC" names a pair, not a
  // protocol.
};

/**
 * The Aquarius markets the indexer scores. Iterated by `buildTargets`, exactly
 * as `BLEND_POOLS` is, so registering a market is one entry here and nothing in
 * the indexer.
 *
 * ONE ENTRY IS NOT A PLACEHOLDER — it is the target budget, spent. What that
 * budget IS changed on 2026-08-30: the five-target ceiling is per serverless
 * invocation, and sharding splits the registry across several, so a second entry
 * needs a shard with a free slot rather than a lowered
 * `STENION_ATTEMPT_TIMEOUT_MS`. Provisioning that shard is a cron-job.org job,
 * not a code change — see `architecture/deploy-architecture.md`.
 *
 * The deployed `durationMs` this comment used to ask for has been taken, and it
 * is 1.5-1.6s: this pool is the FASTEST target in the registry, not the slowest,
 * against an estimate of 5.5-8.7s built from its request count.
 */
export const AQUARIUS_POOLS: readonly AquariusPool[] = [AQUARIUS_XLM_USDC];

// ---------------------------------------------------------------------------
// The raw shape
// ---------------------------------------------------------------------------

/** Classic-asset issuer flags, exactly as Horizon reports them. */
export interface AquariusIssuerFlagsRaw {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

/**
 * What we learned about one reserve token's issuer-level control, as a tagged
 * union rather than a nullable field.
 *
 * THE FOUR ARMS ARE FOUR DIFFERENT FACTS AND MUST NOT COLLAPSE. This is the
 * single most dangerous confusion available in `assetControlSafety`
 * (`methodology/dex.md`), so the type refuses to express it:
 *
 * - `read` — the token is a Stellar Asset Contract, its issuer was found, and
 *   the flags are the thing the factor grades.
 * - `noIssuer` — the token is the native asset (XLM). It is a SAC, and it has
 *   no issuer account at all, so no third party can freeze or claw it back.
 *   **This is a positive fact, not an absent reading**, and it must never be
 *   routed like `notApplicable`: "nobody can seize this" and "we could not
 *   check whether anybody can seize this" are opposite statements.
 * - `notApplicable` — the token is a wasm contract, not a SAC, so there is no
 *   issuer-flag equivalent to read. Route (a): a `value: null` disclosure. Nine
 *   of the 205 distinct pool tokens are these.
 * - `failed` — the token IS a SAC and Horizon **answered** about its issuer with
 *   something that is not a gradable account. The read applies and did not
 *   happen, which `methodology/dex.md` sends to the unsafe end. Never routed as
 *   `notApplicable`; doing so would silently upgrade an unknown into an
 *   exemption. And never used for a read that never reached an answer — a rate
 *   limit, a dropped connection or a `5xx` fails the run, because a score must
 *   not move with Stenion's own read path (see `../read-failure.ts`).
 *
 * `reason` is carried on `failed` so a run failure is attributable to a
 * specific read rather than a generic "fetch failed".
 */
export type AquariusIssuerRead =
  | { status: 'read'; issuer: string; flags: AquariusIssuerFlagsRaw }
  | { status: 'noIssuer'; asset: 'native' }
  | { status: 'notApplicable'; reason: 'wasm-contract' }
  | { status: 'failed'; issuer: string | null; reason: string };

/** One of a pool's reserve tokens, and what could be established about it. */
export interface AquariusTokenRaw {
  /** the token contract address */
  address: string;
  /**
   * True when the contract's executable is `contractExecutableStellarAsset`.
   *
   * DETECTED FROM THE EXECUTABLE, NEVER FROM THE SHAPE OF `name()`. Native XLM
   * (`CAS3J7GY…`) is a SAC whose metadata `name` is the bare string `native`
   * rather than `CODE:ISSUER` — confirmed live — so a regex over the name
   * misclassifies the single most common token in the registry as a wasm
   * contract, and would hand XLM the wasm route-(a) disclosure. The executable
   * discriminant has no such failure mode.
   */
  isStellarAsset: boolean;
  /** asset code from contract metadata, or null when it could not be read */
  code: string | null;
  /** token decimals from contract metadata, or null when it could not be read */
  decimals: number | null;
  /** token symbol from contract metadata, or null when it could not be read */
  symbol: string | null;
  /** see AquariusIssuerRead — the four arms are four different facts */
  issuer: AquariusIssuerRead;
}

/** One privileged account's Horizon-side posture. */
export interface AquariusRoleAccountRaw {
  highThreshold: number;
  signerCount: number;
  recentOps: number;
  activityWindowDays: number;
}

/**
 * One role, its declared holders, and what could be read about each.
 *
 * `addresses` is an ARRAY because `get_privileged_addrs()` returns one — the map
 * is `role -> Vec<Address>`, not `role -> Address`. Confirmed live on
 * 2026-08-29; every role currently holds exactly one address, but the contract's
 * own type permits several and flattening to `[0]` would silently drop
 * co-holders the day one is added.
 */
export interface AquariusRoleRaw {
  role: string;
  addresses: string[];
  /**
   * Per address, in `addresses` order.
   *
   * - `read` — a classic `G…` account whose signers and thresholds were read.
   * - `contract` — a `C…` address: Horizon has no account entry to introspect,
   *   recorded honestly rather than fabricated. `methodology/dex.md` sends this
   *   to the unsafe end for `dex` rather than inheriting lending's neutral 60,
   *   and records why.
   * - `failed` — **Horizon answered about this account and the answer was not a
   *   gradable one** (a `404`, most plainly); attributable, with its reason. It
   *   is NOT the arm for a read that never reached an answer: a rate limit we
   *   could not wait out, a dropped connection or a `5xx` fails the run instead,
   *   because none of them is a fact about this account. See
   *   `../read-failure.ts` and `methodology/dex.md` § "A rate limit is not a
   *   reading".
   */
  accounts: (
    | { status: 'read'; address: string; account: AquariusRoleAccountRaw }
    | { status: 'contract'; address: string }
    | { status: 'failed'; address: string; reason: string }
  )[];
}

/**
 * The role map as a whole, tagged so a failed or short read is a READING rather
 * than an exception.
 *
 * `short` is its own arm rather than a flag on `read`: `methodology/dex.md`
 * sends both a revert and a short map to the unsafe end, and keeping them
 * distinct means a reviewer can tell "the contract refused" from "the contract
 * answered with less than we expect" without re-reading the reason string.
 */
export type AquariusRolesRead =
  | { status: 'read'; roles: AquariusRoleRaw[] }
  | { status: 'short'; roles: AquariusRoleRaw[]; missing: string[] }
  | { status: 'failed'; reason: string };

/**
 * A pending code upgrade, or the read that says there is none.
 *
 * `commit_upgrade` writes an upgrade deadline and `apply_upgrade` refuses until
 * it passes, so a non-zero deadline is exactly how long an LP has to withdraw
 * before the code under their money changes — the anchor `adminKeySafety`
 * grades, with no Stenion constant in it.
 *
 * BOTH KEYS LIVE IN CONTRACT **INSTANCE** STORAGE, under vec-wrapped enum
 * variants (`scvVec(["UpgradeDeadline"])`). Read live on 2026-08-29 from the
 * router and pools of all three types: `UpgradeDeadline = 0n` on every one, and
 * `FutureWASM` equal to that contract's own running hash — i.e. no upgrade
 * scheduled anywhere, which is a READ VALUE rather than an absence.
 *
 * > **A correction is recorded here on purpose.** An earlier version of this
 * > adapter reported these keys as unreadable "under any encoding or
 * > durability", and that finding was WRONG — caused by `readInstance` keeping
 * > only string-typed keys and so discarding every vec-wrapped entry on every
 * > contract. The bug presented as an empty map rather than an error, which is
 * > exactly why it read as a property of Aquarius instead of a defect here. The
 * > upgrade-reaction-window half of `adminKeySafety` is fully readable, and
 * > `methodology/dex.md`'s Gate 0 argument for it stands unchanged.
 *
 * WHAT GENUINELY IS NOT READABLE, and this part was always right: the
 * **duration** of the window. `ADMIN_ACTIONS_DELAY` is a compile-time constant,
 * confirmed absent from all four deployed wasms by byte-searching them, and
 * there is no `get_upgrade_deadline` or `get_future_wasm` getter to ask. So the
 * factor can grade the REMAINING window when one is open and state that none
 * is, and cannot state how long a window would be. That stays a route-(a)
 * `value: null` disclosure.
 */
export interface AquariusUpgradeRaw {
  /**
   * `UpgradeDeadline` as read: a unix timestamp, or `0n` for none scheduled.
   *
   * `null` means the contract carries no such entry AT ALL, which is a
   * different statement from `0n` and must not be collapsed into it — one says
   * the contract answered "nothing pending", the other says this contract does
   * not keep that field.
   */
  deadline: bigint | null;
  /** `FutureWASM` as hex, or null when the contract carries no such entry */
  futureWasm: string | null;
  /** the wasm hash actually running, from the instance executable */
  runningWasm: string | null;
  /** true only when a deadline is set and non-zero — the reaction window is open */
  pending: boolean;
  /**
   * True when `FutureWASM` names code other than what is running.
   *
   * Carried separately because presence is not the signal: every contract read
   * on 2026-08-29 had a `FutureWASM` equal to its own running hash, so staged
   * code identical to live code is the quiescent state, not a staged upgrade.
   */
  stagedDiffers: boolean;
}

/** Protocol-wide reads from the router, shared by every pool. */
export interface AquariusRouterRaw {
  routerId: string;
  contractName: string;
  version: number;
  /** router-wide emergency mode — live ungraded state, never a factor input */
  emergencyMode: boolean;
  roles: AquariusRolesRead;
  upgrade: AquariusUpgradeRaw;
}

/**
 * The kill switches, read through the GETTERS.
 *
 * WHY NOT INSTANCE STORAGE, which is the obvious cheaper read. The three pool
 * types disagree about storage key names — `constant_product` writes
 * `IsKilledClaim`, `concentrated` writes `ClaimKilled`/`IsKilledSwap`/
 * `EmergencyMode` — and, decisively, **a flag that has never been toggled has
 * no storage key at all**. Live confirmation on 2026-08-29: contract instance
 * storage is EMPTY on pools of all three types, so a storage-first reader would
 * see nothing and have to guess whether that meant `false` or "unread". The
 * getters normalise every one of those cases and return a real boolean.
 *
 * THERE IS NO `kill_withdraw`, and its absence is the strongest single fact
 * about an Aquarius LP's exit risk. The pool wasms export `kill_swap`,
 * `kill_deposit`, `kill_claim`, `kill_gauges_claim` and their `unkill_`
 * counterparts and no withdraw equivalent, so no Aquarius role can stop a
 * withdrawal. There is deliberately no `withdraw` member on this type: adding
 * one would imply a switch exists.
 */
export interface AquariusKillFlagsRaw {
  swap: boolean;
  deposit: boolean;
  claim: boolean;
}

/**
 * One Aquarius pool, read.
 *
 * Nothing in here is scored yet — `dex`'s two factors are `adminKeySafety` and
 * `assetControlSafety`, and the scoring implementation lives in ./score.ts.
 * Several fields
 * (`reserves`, `totalShares`, `feeFraction`) feed no factor today and are read
 * anyway, because they are what identifies and provenances a pool, and because
 * re-deriving the pool-type divergence handling later would mean re-doing the
 * work this file exists to do once.
 */
export interface AquariusRawData {
  poolId: string;
  /** see AQUARIUS_POOL_TYPES — the chain's spelling, not the documentation's */
  poolType: AquariusPoolType;
  /**
   * The pool's reserve token addresses, in the index order the contract uses.
   *
   * **THE LENGTH IS THE SOURCE OF TRUTH FOR ARITY — never assume two.** Three of
   * the 304 token sets have three members, confirmed live, and all three are
   * `stable` pools (`get_info().n_tokens = 3`). Nothing anywhere in this adapter
   * may index `[0]`/`[1]` as though a pool were always a pair.
   */
  tokens: string[];
  /**
   * Raw reserves, in `tokens` order.
   *
   * **THIS MEANS SOMETHING DIFFERENT FOR A CONCENTRATED POOL, and that is why
   * `poolType` is recorded beside it rather than being derivable later.** For
   * `constant_product` and `stable` it is the tradable balance. For
   * `concentrated` it is the total across all tick ranges, of which only the
   * active range is available at the current price — the tradable part is
   * described by `get_active_liquidity()` and `Slot0`, which this adapter
   * deliberately does not read (concentrated-specific reads are out of scope for
   * the `dex` rulebook). Nothing downstream may treat the two as the same
   * quantity, and
   * the pairing of these two fields is what stops it doing so by accident.
   */
  reserves: bigint[];
  totalShares: bigint;
  /**
   * Swap fee in BASIS POINTS, as the contract reports it.
   *
   * Read, never assumed from a tier: Aquarius's documentation describes three
   * fee tiers, and the chain disagrees — `constant_product` pools use 10/30/100,
   * while `stable` pools were found at 1, 5, 10, 15, 22, 25, 30 and 50. Not a
   * factor input: a higher fee is worse execution, not a failure mode, and
   * grading it would dress a pricing preference as a risk measurement
   * (`methodology/dex.md`, "Fee tier as a factor").
   */
  feeFraction: number;
  /** the protocol's cut of the fee, in basis points */
  protocolFeeFraction: number;
  /**
   * `get_info()`, verbatim.
   *
   * ITS KEYS **AND** ITS VALUE TYPES DIFFER PER POOL TYPE, which is why this is
   * an open record rather than a struct. Read live:
   *
   *   constant_product  { fee: 100, pool_type: 'constant_product' }
   *   stable            { a: 1500n, fee: 15, n_tokens: 3, pool_type: 'stable' }
   *   concentrated      { fee: 30, pool_type: 'concentrated', tick_spacing: 60 }
   *
   * `bigint` is in the union because of `a`, the stableswap amplification
   * coefficient, which decodes as u128. That was not in the original
   * description of this read and was caught by a captured fixture failing to
   * satisfy the narrower type — which is the entire reason fixtures are checked with
   * `satisfies` rather than cast.
   */
  info: Record<string, string | number | bigint>;
  /** the LP share token, for provenance */
  shareId: string;
  version: number;
  /** see AquariusKillFlagsRaw — read via getters, and there is no withdraw switch */
  killed: AquariusKillFlagsRaw;
  /** pool-level emergency mode — live ungraded state, never a factor input */
  emergencyMode: boolean;
  /**
   * The pool's OWN role map, read per pool rather than inherited from the
   * router. The seven roles are identical across the router and every pool
   * sampled — but a per-pool `set_privileged_addrs` exists, so that uniformity
   * is a current reading and not an invariant. Assuming it would make the
   * adapter unable to report the day it stops being true.
   */
  roles: AquariusRolesRead;
  /** the pool's own pending-upgrade state — see AquariusUpgradeRaw */
  upgrade: AquariusUpgradeRaw;
  /** one entry per address in `tokens`, same order */
  reserveTokens: AquariusTokenRaw[];
  /** protocol-wide reads, shared by every pool */
  router: AquariusRouterRaw;
  fetchedAt: number; // unix seconds
}

export interface AquariusAdapterOptions {
  rpcUrl?: string;
  horizonUrl?: string;
  /**
   * Which market to read. Required — there is no default pool, deliberately.
   *
   * `BlendAdapter` defaults to Blend's flagship because Blend has one. Aquarius
   * has 340 pools and none of them is reviewed as the flagship, so a default
   * here would be this adapter picking the protocol's public face by accident. A
   * whole `AquariusPool` rather than a bare id, for the reason
   * `BlendAdapterOptions.pool` gives: target and identity must move together.
   */
  pool: AquariusPool;
}

// ---------------------------------------------------------------------------
// Shapes as they come back from the chain / Horizon
// ---------------------------------------------------------------------------

/** Horizon `/accounts/{G…}` — the subset read. */
export interface HorizonAccount {
  thresholds?: { high_threshold?: number };
  signers?: unknown[];
  flags?: {
    auth_required?: boolean;
    auth_revocable?: boolean;
    auth_immutable?: boolean;
    auth_clawback_enabled?: boolean;
  };
}

/** Horizon `/accounts/{G…}/operations` — the subset read. */
export interface HorizonOps {
  _embedded?: { records?: { created_at: string }[] };
}
