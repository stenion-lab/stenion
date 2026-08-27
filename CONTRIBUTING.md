# Contributing to Stenion

Thanks for wanting to contribute. The main contribution path is **writing an adapter for a new
protocol** — DeFiLlama-style: one open-source, PR-reviewed adapter per protocol. This guide is
meant to be complete enough that you can ship an adapter without needing to ask questions first.

Before you start, read [`METHODOLOGY.md`](METHODOLOGY.md) (the exact formulas your adapter must
implement) and skim [`ARCHITECTURE.md`](ARCHITECTURE.md) (how your adapter fits into the system).

## Ground rules (read these first)

An adapter that breaks any of these will not be merged, regardless of how good the code is:

1. **Read trustless on-chain data only.** Adapters pull from Soroban RPC and Horizon (official
   Stellar infrastructure) — never self-reported numbers from a protocol's API or docs. If a value
   isn't derivable from the chain, it doesn't go in the score.
2. **No fabricated numbers.** Where real data genuinely isn't available for a factor, use a
   clearly-flagged neutral baseline and say so in the factor's `detail` string (see
   `adminKeySafety`'s contract-admin case in `METHODOLOGY.md` for the canonical example). Never
   invent a plausible-looking value.
3. **Anchor thresholds to the protocol's real parameters — don't invent new ones.** The formulas,
   scales, and thresholds are fixed in `METHODOLOGY.md` and identical across protocols. What
   legitimately differs per adapter is only _where you read the raw inputs on-chain_. If your
   protocol has a different on-chain parameter that a continuous factor should anchor to (e.g. Blend
   reads a per-reserve `max_util`; K2 has none and anchors to `OPTIMAL_UTILIZATION_RATE`), that's a
   documented per-protocol fact you add to `METHODOLOGY.md` — **not** a new threshold you invent
   inline. See [Changing a formula or threshold](#changing-a-formula-or-threshold).
4. **Confirm the actual on-chain structure — don't assume it mirrors Blend or K2.** Every
   method/field name in the shipped adapters was confirmed against the protocol's audited source or
   SDK, none guessed. Do the same. And confirm the protocol is actually an _independently scoreable
   native-Soroban lending protocol_ before you write scoring logic — see
   [Is this protocol even in scope?](#is-this-protocol-even-in-scope).
5. **Payment never affects the score.** This isn't something your code touches directly, but it's
   why the rules above are strict: the number has to be defensible as purely data-derived.

## The `Adapter` interface

Every adapter implements `Adapter<TRawData>` from `@stenion/core` ([`core/src/adapter.ts`](core/src/adapter.ts)).
`TRawData` is your protocol's own raw shape — it has nothing in common with another protocol's, so
it stays internal to your adapter.

```ts
export interface Adapter<TRawData = unknown> {
  // identity: { id: slug, name, chain, adapterRef, logo?, contractId?, links? }
  readonly metadata: ProtocolMetadata;

  fetchRawData(): Promise<TRawData>; // pull raw on-chain state (RPC + Horizon)

  computeRiskFactors(rawData: TRawData): Promise<RiskFactorMap>; // → the five *Safety factors

  score(factors: RiskFactorMap): RiskScoreResult; // → weighted safetyScore

  operationalState(rawData: TRawData): OperationalState; // → what the market is refusing, unscored
}
```

Separate methods (not one `run()`) so the indexer can inspect intermediate output and so
`score()` can be unit-tested against fixed factor inputs without touching RPC.

### `operationalState` — required, and it must not touch a factor

Report which user operations your protocol's own gating logic currently refuses. It takes the same
`rawData` `computeRiskFactors` does, so it costs no extra RPC round trip and the state published
beside a score is the state that was true when that score's inputs were read. It is synchronous for
the same reason: anything it needs is already in `rawData`.

Build the result with `toOperationalState` from `@stenion/core` (and `mostRestrictive` where your
protocol gates per reserve as well as globally, as K2 does). That function owns the shared
classification rule — which set of blocked operations maps to which level — and hand-rolling the
object is how two adapters come to disagree about what "frozen" means. Your job is only to read
what the contracts refuse; pass the operations, not a level you picked.

**This value must never reach a number.** It is published beside the score and deliberately not
graded — the reasoning is in
[`METHODOLOGY.md`](METHODOLOGY.md#operational-state-is-published-never-scored) and it is not a
detail to be revisited in an adapter PR. Both shipped adapters carry a test asserting that
`computeRiskFactors` returns a byte-identical factor map across every restricted state the protocol
can be in; **write the same test for yours.** It is the check that keeps the decision a property of
the code rather than an intention.

Two things to get right, because both shipped adapters had to:

- **Name what is blocked, not what your protocol calls it.** Blend says "On-Ice" and "Frozen", K2
  says "paused"; those words do not mean the same things, and a reader comparing two rows should
  not have to know either. Your protocol's own wording goes verbatim in `source` and `detail`.
- **Never claim a reason.** `origin` says who _could_ have set the state, and `indeterminate` is the
  honest answer wherever more than one path produces the value. Nothing on chain says _why_ a market
  is restricted, and an adapter must not imply it does.

### `adapterRef` must be a hardcoded string literal

`metadata.adapterRef` names the class that produced the score (`'BlendAdapter'`). It is stored in
`protocols.adapter` and published on `GET /api/v1/protocol/:id`, where it is the provenance label a
reader follows to find your adapter in this repo.

Write it out by hand:

```ts
readonly metadata: ProtocolMetadata = {
  id: 'yourprotocol',
  name: 'YourProtocol',
  chain: 'stellar',
  adapterRef: 'YourProtocolAdapter', // literal — never this.constructor.name
};
```

**Never derive it from the class name** — not `this.constructor.name`, not
`YourAdapter.name`, not anything else read off a runtime identifier. It looks like the obvious
DRY move and it is silently wrong in production:

The indexer is not a standalone deployed process. It runs inside the dashboard's serverless cron
route (`dashboard/app/api/cron/run-indexer`), which imports `@stenion/indexer` and, through it,
your adapter class. Next bundles the workspace packages into that function and **minifies them**,
which renames classes — `class BlendAdapter` becomes `class w`. `constructor.name` then returns
`'w'`, and that is what gets written to the database.

Nothing catches this before it ships. It is correct under `node --test`, correct under `next dev`,
and correct in every local run, because none of those minify. It is wrong only in the one
environment that actually writes the published data. This is not hypothetical: it is exactly how
every row in `protocols` came to have `adapter = 'w'` for both shipped protocols until it was
fixed. A string literal is a value the bundler has no license to rewrite; a class name is not.

The same reasoning applies to anything else an adapter persists or publishes. If a value ends up in
the database or an API response, it must come from a literal or from on-chain data — never from a
JavaScript identifier.

### Logo, links, and the scored contract

`metadata` also carries the protocol's identity: its mark, the contract its score comes from, and
its own site/docs. These live here — not in a slug-keyed table in the dashboard — for the same
reason `name` and `chain` do: a frontend lookup has to be edited by someone working in a package
they didn't touch, which is how such tables go stale. They travel the one existing path
(`upsertProtocol` → `protocols` → the API), so adding an adapter is still a single-package change.

```ts
readonly metadata: ProtocolMetadata;

constructor(opts: YourAdapterOptions = {}) {
  this.poolId = opts.poolId ?? DEFAULT_POOL;

  this.metadata = {
    id: 'yourprotocol',
    name: 'YourProtocol',
    chain: 'stellar',
    adapterRef: 'YourProtocolAdapter',
    logo: '/assets/protocols/yourprotocol.svg',
    contractId: this.poolId, // the instance's pool, NOT the module default
    links: { site: 'https://yourprotocol.xyz', docs: 'https://docs.yourprotocol.xyz' },
  };
}
```

**Build `metadata` in the constructor, not as a field initialiser.** `contractId` must be the
contract _this instance_ was configured with. An adapter constructed with a non-default pool would
otherwise publish an explorer link to a pool it never read — a real address under a number that
didn't come from it, which is worse than no link.

**`contractId` is a raw C-address, never an explorer URL.** Which explorer to send a reader to is a
Stenion presentation choice and lives in one place, `dashboard/app/lib/explorer.ts`. Don't repeat a
`stellar.expert` string in your adapter.

**Links are optional and must not be padded.** Omit `docs` if the protocol publishes none. A dead
link is worse than an absent one; the UI just leaves the button out. Note also what these links are
_not_: listing a protocol's site is not an endorsement of it, the dashboard renders them
`rel="noopener noreferrer nofollow"`, and the attribution note beside them says so explicitly.

#### The logo asset

|               |                                                                                       |
| ------------- | ------------------------------------------------------------------------------------- |
| **Where**     | `dashboard/public/assets/protocols/<id>.<ext>` — filename matches your `metadata.id`  |
| **Format**    | SVG preferred. PNG only when the protocol publishes no vector mark                    |
| **Size**      | SVG: any square-ish viewBox. PNG: **at least 128×128**, square, transparent or opaque |
| **Reference** | `logo: '/assets/protocols/<id>.svg'` — a root-relative path, always                   |

**Commit the file; never hotlink.** A URL on the protocol's CDN breaks the moment they reorganise
their assets, and the resulting 404 shifts layout on a page whose whole job is to be scannable.
Download it, check it in, and reference the local path.

**Check an SVG before committing it.** These are served from our own origin, and an SVG opened
directly is a document, not an image — a `<script>`, an `onload=`, or a `<foreignObject>` inside one
is same-origin script execution. Strip anything that isn't drawing:

```
grep -oiE '<script|on[a-z]+=|<foreignObject|<use|<image|href="http|javascript:' your-logo.svg
```

Nothing should match. Also drop any `<image>` with an embedded raster — it defeats the point of a
vector mark and bloats the file.

**Both themes.** The dashboard renders every mark in a fixed dark tile
([`components/protocol-logo.tsx`](dashboard/components/protocol-logo.tsx)) precisely so this is
mostly handled for you: a mark designed for a dark background works, and one that reads on anything
also works. What you must still check is a mark that is **dark-on-transparent** — it will vanish
into the tile. If that's what the protocol publishes, prefer their light/inverse variant if they
offer one; if they don't, omit the logo rather than recolouring their mark.

**No usable mark? Omit the field.** `logo` is optional, and its absence is a designed state, not a
gap: the dashboard renders the protocol's initials in the same tile, so the row still scans and
nothing looks broken. **Never invent, redraw, or recolour a mark to fill this in**, and never point
`logo` at a placeholder file — that's a 404 in every row that uses it.

**These fields are maintainer-managed.** `upsertProtocol` overwrites them from adapter metadata on
every indexer cycle, so a value edited directly in the database reverts within ~5 minutes. That's
deliberate. If protocol self-service ever ships, a protocol-supplied mark must land in _separate_
columns that win at read time — never as an edit to these.

## The `*Safety` taxonomy — populate all five

Every adapter must populate the same fixed five factors from `RiskFactorType`
([`core/src/types.ts`](core/src/types.ts)). This shared taxonomy is what makes protocols comparable
— it is **not** freeform per protocol.

```ts
riskFactors: {
  collateralSafety,    // collateral concentration (diversification)
  oracleSafety,        // price freshness + manipulation resistance
  adminKeySafety,      // admin signer structure + activity
  liquiditySafety,     // free-liquidity depth (withdrawal cushion)
  utilizationSafety,   // headroom below the configured utilization cap
}
```

Conventions you must not break:

- **Scale: 0–100, higher = safer**, for both the overall score and every factor — same direction
  throughout. A `collateralSafety` of 70 means _well-diversified_ (safe), not "70% concentrated."
- **Names end in `*Safety`** so a name never disagrees with its number. Don't add a factor whose
  name implies "higher = riskier."
- **Every key must be present.** Use `null` (not omission) for a factor that genuinely doesn't
  apply to your protocol, so the dashboard renders "N/A" instead of silently dropping it. The
  `score()` weighted mean renormalizes over the non-null factors.
- **Take each factor's `weight` from `CATEGORY_FACTORS`, never a literal.** Import
  `LENDING_FACTORS` from `@stenion/core` and write
  `const weight = LENDING_FACTORS.oracleSafety.weight;`. A weight is part of the shared rulebook,
  not something an adapter picks: the numbers used to be spelled out inside each adapter, and two
  copies that drift produce two plausible scores from two different weightings while failing
  nothing. The declarations live in [`core/src/weights.ts`](core/src/weights.ts), keyed by
  category, and `core/src/scoring.test.ts` pins them against `METHODOLOGY.md`'s published weight
  table. Your adapter's suite should assert it carries what its category declares — see the
  `the factor map itself` block in either lending suite — rather than restating the numbers, which
  would just be another copy.
- **Each factor carries a `detail` string** — a short, human-readable explanation of what drove the
  value (e.g. "top reserve holds 95% of supplied value"). This is what the dashboard shows and what
  makes the number auditable. Write a real one.
- **Never put a full contract address in a detail string.** Use `shortAsset`'s convention (first six
  characters plus an ellipsis, `CDTKPW…`) — the shared helpers in `core/src/scoring.ts` already do.
  A 56-character C-address has no break opportunity anywhere in it, and inside a factor card — which
  is a grid child — one sets the track's min-content width and scrolls the whole page sideways on a
  phone. **This includes a label the protocol supplies**, which is the case that actually shipped:
  Blend's oracle aggregator labels a reserve `Other:XLM` on one pool and `Stellar:C…` on the next, so
  a string that was fine on every pool we had broke on the one we added. Pass any protocol-supplied
  label through `shortenAddressesIn` before it lands in a detail string; it shortens the address and
  keeps the qualifier around it, which is real information.

**How** a factor is computed can differ per protocol; the names, scale, weights, and thresholds do
not — **within a category**. New factors are added to `@stenion/core` for everyone in that category
at once, never invented per-adapter. The five above are lending's set; a different category
declares its own in `CATEGORY_FACTORS` and publishes it in its own `METHODOLOGY.md` section, and
that is the only place a rule is allowed to differ.

> **Proposing a new category? Start at [`TAXONOMY.md`](TAXONOMY.md), not here.** A category is
> admitted as a published rulebook first and an adapter second, and `TAXONOMY.md` is the standard
> that rulebook is reviewed against — a set of gates stated as yes/no conditions, with a pre-flight
> checklist to work through before any adapter code is written. This guide covers writing an adapter
> against a rulebook that already exists.

**`score()` delegates to `@stenion/core` — do not reimplement the weighted mean.** Your adapter's
`score()` is one line:

```ts
import { scoreFactors } from '@stenion/core';

score(factors: RiskFactorMap): RiskScoreResult {
  return scoreFactors(factors);
}
```

The method exists on the interface only so the indexer can call it; the arithmetic behind it is not
yours to choose.

**Why it's shared, not copied.** Ground rule 1 in [`METHODOLOGY.md`](METHODOLOGY.md) is that one
rulebook applies to every protocol — that is the entire basis for claiming two protocols' scores are
comparable. A per-adapter copy of the weighted mean is a second rulebook waiting to happen: the
moment one copy is edited and the others aren't, "Blend 53 vs Kinetic 61" stops meaning anything,
and nothing in review reliably catches a one-line divergence buried in an 800-line adapter. So the
formula lives in [`core/src/scoring.ts`](core/src/scoring.ts), where changing it changes every
protocol at once, deliberately and visibly.

That also means **a change to the weighted mean is a methodology change, not an adapter change** —
it moves every published score, so it needs the `METHODOLOGY.md` edit and probably a
bump of your category's `METHODOLOGY_VERSIONS` entry
(see [Changing a formula or threshold](#changing-a-formula-or-threshold)).
If you find yourself wanting different scoring arithmetic for your protocol, that's the conversation
to open — not something to work around locally.

## Error handling — throw, don't swallow

The error model is deliberately simple and lives in the indexer, not duplicated per adapter:

- **Adapters throw on failure** — RPC unreachable, malformed response, missing contract data, a
  price that won't decode, anything. Do not catch-and-continue with a fake value; do not return a
  partial factor map with guessed numbers.
- **The indexer wraps each run in try/catch** and records a failed/stale run for that protocol,
  without aborting the cycle or crashing the process. One protocol failing never affects another.
- A missing/undecodable oracle price is _not_ an error to swallow — per `METHODOLOGY.md` it's a
  real signal and scores `0` (a missing feed is maximally unsafe). Follow the methodology for what's
  "no data → 0" versus what's "genuinely broken → throw."

## Is this protocol even in scope?

Before writing scoring logic, confirm the protocol is an **independently-scoreable native-Soroban
lending protocol**. Several real, significant protocols and markets were investigated and
_deliberately skipped_ because they aren't (details in [`ROADMAP.md`](ROADMAP.md)):

- **YieldBlox** — turned out to be a DAO-managed pool _on Blend V2_, not an independent protocol.
  An adapter would just be `BlendAdapter` pointed at a different pool. **It is now scored anyway —
  as a pool, not as a protocol:** a `BLEND_POOLS` entry carrying its own slug, contract, links and a
  `deployedOn` label that says "Blend V2 pool" everywhere it appears. If your candidate turns out to
  be a Blend market, that is the path — add a pool config, not an adapter. Writing a second adapter
  for it would duplicate a rulebook that is already shared, which is the thing the taxonomy exists
  to prevent.
- **Templar** — its lending market state lives on **NEAR**, not Stellar; only its price oracle is
  native Soroban. Reading NEAR would break the trustless-Stellar rule.
- **Four Blend V2 markets (Orbit, Forex, Spectra PTs, Solv)** — a different shape of "no", and the
  one most likely to catch you out, because everything looks fine until it doesn't. They are
  native-Soroban lending markets on their own contracts, and four of the five factors compute from
  them without incident. Their oracles simply publish nothing `oracleSafety` can be anchored to: no
  staleness tolerance and no deviation bound, neither of which SEP-40 defines. See
  [`METHODOLOGY.md`](METHODOLOGY.md) §2e, "The oracle-legibility precondition".

So: confirm reserves, utilization, liquidity, admin, and oracle are all readable via **Soroban RPC +
Horizon** from the protocol's _own_ contracts (not another chain, not another protocol's pool)
before you commit to an adapter. Confirming this from the contracts first — rather than assuming it
mirrors Blend/K2 — is the whole point.

**"The oracle answers `lastprice`" is not the test.** Every oracle behind every Blend V2 pool does.
What §2 grades is the price feed's own _declared_ limits — how stale it will let a price get, and
how far one update may move it — and a feed that publishes neither leaves that factor with nothing
to measure. Check for those two parameters explicitly, and check them by reading the oracle's
**exported interface out of its wasm** (Soroban RPC's `getContractMethods`, or the
`contractspecv0` custom section) rather than by calling a list of method names you expect to exist.
A guess-list cannot distinguish "this contract lacks the method" from "this is a different contract
than you think" — which is precisely how those four markets were mistaken for one interface when
they are four.

### If the answer is no, publish the finding

An investigation that ends in "we can't score this" is a **result**, not a wasted afternoon, and it
belongs on the site rather than in your terminal history. Add a `CoverageEntry` to
[`dashboard/app/lib/coverage.ts`](dashboard/app/lib/coverage.ts); it renders in the registry's
"Assessed, and not scored" section. That is the whole change — there is no migration, no adapter,
and nothing touches a score.

The bar is `PROTOCOL_NOTES`' bar plus a date rule, and `coverage.test.ts` enforces the mechanical
half of it:

- **A protocol-specific `reason`.** The status is a category; the reason is why _this_ market is in
  it. A generic label teaches a reader nothing they couldn't infer from the heading.
- **A `verify` sentence** saying exactly how someone checks your claim themselves. If you can't
  write it, the entry doesn't go in — this is what keeps the section a record of work rather than a
  list of opinions.
- **An `asOf` date on anything resting on a reading.** A balance is a measurement, not a property.
  Undated and indexed by a search engine, it becomes a claim we'd be making indefinitely. Required
  for `below-size-floor` and `oracle-not-gradable` — the second because a contract's interface is
  not permanent either: oracles get upgraded, and the date says which deployment you read.
- **Sourced from contracts you actually read.** A figure from an aggregator that was never checked
  on chain is not a source. Listing nothing is better than listing a number neither of us can point
  at.
- **`contractId` only if you recorded the address in full.** A truncated one can't build an explorer
  link, and `verify` should carry the derivation path instead.
- **Neutral, and explicit about verified versus inferred.** No speculation about intent. An empty
  market is an empty market, not a defective one.

Pick the `CoverageStatus` that matches; if none does, add one **with its entry**, never in advance —
a status with no members renders a heading describing rows that aren't there.

**The reciprocal rule:** if a protocol listed there later becomes scorable, **remove its coverage
entry in the same PR that registers it.** The registry also filters live against the leaderboard, so
a forgotten entry disappears rather than double-listing — but don't lean on that; leaving it makes
the file lie about what we believe.

**Cheap way to tell a Blend market from a protocol:** read the pool's instance storage. A Blend pool
has a `Config` with an `oracle`/`status`/`min_collateral`, a `Name`, and a `Backstop` pointing at
Blend's own backstop contract — and the V2 pool factory (`CDSYOAVX…`) answers `is_pool(address)`
with `true`. Compare its wasm hash against a known Blend pool's while you are there; if they match
byte-for-byte, you are looking at a Blend market and the answer is a `BLEND_POOLS` entry.

**Adding a Blend pool**, once you have confirmed that:

1. Add a `BlendPool` to `BLEND_POOLS` in `adapters/blend.ts` — slug, name, pool contract, and a
   `deployedOn` label. No scoring code, and nothing on that type may be a threshold or a weight.
2. `pnpm capture:fixture <slug>` and add a block to `adapters/snapshot.test.ts` asserting the
   captured factor map, the score, and that `metadata.contractId` is **this** pool.
3. Check the identity fields honestly: omit `logo` unless there is a mark you can self-host (never
   borrow the host protocol's — that asserts the identity the label exists to deny), and omit `docs`
   rather than pointing at the host's.
4. Check the indexer budget. Each added target narrows the first target's share of
   `STENION_CYCLE_BUDGET_MS`; see the ceiling note in [`ROADMAP.md`](ROADMAP.md).

## Local development setup

**Prerequisites:** Node 22.18+ (24 recommended — see [`.nvmrc`](.nvmrc); the test runner needs
native TypeScript stripping), pnpm via corepack, and a Postgres database (Neon free tier works).

```bash
corepack enable
pnpm install

cp .env.example .env        # fill in DATABASE_URL; RPC/Horizon default to public mainnet endpoints

pnpm --filter @stenion/db build
pnpm --filter @stenion/db migrate
```

Then, iterating on your adapter:

1. Add your adapter file at `adapters/<protocol>.ts` and export it from
   [`adapters/index.ts`](adapters/index.ts).
2. Register it in the indexer's `buildTargets()` ([`indexer/src/index.ts`](indexer/src/index.ts))
   via the existing `toTarget<T>()` wrapper — that's what lets your adapter's `TRawData` coexist in
   one typed run loop with the others.
3. Run a single live cycle and check the output lands in Postgres:

   ```bash
   pnpm --filter @stenion/core build
   pnpm --filter @stenion/adapters build
   pnpm --filter @stenion/indexer build
   pnpm --filter @stenion/indexer start -- --once
   ```

4. View it on the site:

   ```bash
   pnpm --filter @stenion/dashboard dev     # http://localhost:3000
   ```

**Verify against real values.** Sanity-check decoded prices/decimals/utilization against known
mainnet reality (a stablecoin should read ~$1.00, XLM its real price, utilization a plausible
percentage). The Blend and Kinetic adapters were both verified end-to-end against live mainnet
before merge — do the same and note it in your PR.

Before opening a PR, from the repo root:

```bash
pnpm format        # prettier, writes in place — run this first
pnpm build         # all packages compile
pnpm lint          # eslint clean
pnpm typecheck     # tsc clean
pnpm test          # node --test, all packages — run build first, tests resolve deps via dist/
```

**Branch off `dev`, and open your PR against `dev` — not `main`.** `main` is the branch Vercel
auto-deploys, so anything merged there is live on the public site immediately, with a real number
next to a real protocol's name. `dev` is where changes get reviewed and verified against live
mainnet first; it's promoted to `main` deliberately, not per-PR. GitHub defaults the base branch to
`main`, so check the base before you submit — a PR targeting `main` will be asked to retarget.

> **Local hazard:** never run `next build`/`next start`/a second `next dev` against the same
> checkout while a dev server is up — they share one `.next` and corrupt each other. Vercel builds
> in isolation, so this is a local-only issue.

## Tests

```bash
pnpm test          # from the repo root; fans out to packages that define one
```

There is **no test framework** — `*.test.ts` files are run by Node's built-in runner (`node --test`)
on Node 24's native TypeScript stripping, so testing costs zero dependencies. Note the one wrinkle
this imposes: a test file must import with an explicit `.ts` extension, because Node's ESM resolver
needs it (`import { x } from './thing.ts'`). Application code keeps its extensionless imports.

**What to test:** pure logic whose important cases live data can't reach. This is not a coverage
target — most of this codebase is better verified against mainnet than against a mock. The bar is
whether a real behaviour would otherwise ship unproven. The worked example is
`dashboard/app/lib/score-series.ts`: the score-history chart must break its line for a failed run
rather than plot a zero, but the production table has never recorded a failed run, so rendering the
page proves nothing about that path. Fixtures do.

If you find yourself wanting to assert against live chain data, that's a sign the logic and the I/O
need separating first — keep the computation pure and pass it data, the way an adapter's
`computeRiskFactors` is separate from its `fetchRawData`.

**For a new adapter, that separation is exactly what makes it testable.** `computeRiskFactors` takes
your already-decoded `TRawData`, so you can build that shape by hand and assert the factors it
produces — no RPC, no mocking of the Stellar SDK. See `adapters/blend.test.ts` and
`adapters/kinetic.test.ts`: each defines a small `reserve()` / `makeRaw()` builder with sensible
defaults, and each test overrides only the field it's about. Cover the cases your protocol's live
state can't currently reach, because those are the ones nobody would otherwise notice breaking —
for both shipped adapters that's the whole of `oracleSafety`'s failure side.

### Database-backed tests

Most of `@stenion/db` is tested without a database: the row → response mapping is pure and lives in
`store.test.ts`. The SQL is not — the two LATERAL joins behind the staleness model, the
`NULLS LAST` ranking, and the `risk_scores_shape` CHECK are Postgres semantics, and an in-memory
fake would only test a re-implementation of them.

Those live in `store.integration.test.ts` and are **skipped unless `STENION_TEST_DATABASE_URL` is
set**. CI never sets it, deliberately: a contributor's PR should not need database credentials to go
green, and a service container plus a secret is real cost for a pre-funding project.

To run them, point at a **scratch** database — they insert and delete rows:

```bash
docker run -d --name stenion-test-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=stenion_test -p 5433:5432 postgres:16-alpine

DATABASE_URL=postgresql://postgres:test@localhost:5433/stenion_test \
  pnpm --filter @stenion/db migrate

STENION_TEST_DATABASE_URL=postgresql://postgres:test@localhost:5433/stenion_test \
  pnpm --filter @stenion/db test
```

The suite refuses to run if `STENION_TEST_DATABASE_URL` equals `DATABASE_URL`, so it can never
append test rows to the published history. Everything it creates is prefixed and cleaned up.

That container speaks no TLS, and `@stenion/db` pins `sslmode=verify-full` on every connection
(see `db/src/env.ts`) — the two only coexist because the pin exempts loopback hosts. So point these
at `localhost`/`127.0.0.1`, not at a remote scratch database reached over a tunnel: a remote host is
pinned like any other and will need a certificate that actually verifies.

### Mainnet snapshot fixtures

Alongside the synthetic tests, `adapters/fixtures/*.ts` holds **frozen captures of real mainnet
state**, asserted in `adapters/snapshot.test.ts`. They exist because hand-built fixtures use tidy
numbers and real pools don't: Blend's live reserves carry `b_rate` values like 1.2214, and a bug in
the fixed-point scaling cancels out entirely when the rate is exactly 1.0. Removing the rate
multiplication passes every synthetic test and fails only here.

Capture one with:

```bash
pnpm --filter @stenion/adapters build     # the script reads the built adapter
pnpm capture:fixture blend                # or: kinetic | yieldblox | etherfuse | all
pnpm format                               # the generated file is unformatted
```

This hits live RPC and Horizon, so it is **manual only** — never run by CI, never part of
`pnpm test`. The committed fixture is then read offline.

**Refresh deliberately, not on a schedule.** Freezing is the point: a fixture that drifts with the
chain can't detect a regression. Regenerate when a change to the raw shape makes an old capture
structurally invalid — and the `satisfies BlendRawData` in each fixture will tell you, because a new
required field makes the stale file stop compiling rather than silently feeding the adapter a shape
the adapter no longer produces.

After regenerating, **re-derive the expected values in `snapshot.test.ts` by hand.** If a factor
moved, work out whether the chain moved or your change did, before committing. That re-derivation is
the review step — a snapshot test whose expected values get updated reflexively is worse than no
snapshot test, because it looks like coverage.

Two mechanical gotchas, both from Node's type stripping being purely syntactic:

- **Split your imports.** `import type { Adapter, RiskFactorMap } from '@stenion/core'` for types,
  a plain `import { RiskFactorType, freshnessWindow }` for values. A type name left in a value
  import survives into the running module and fails against core's CommonJS output. Your adapter
  won't be importable from a test until this is right — the build won't tell you, since tsc erases
  the unused names anyway.
- If you add a package-level test, that package needs the `tsconfig.json` / `tsconfig.build.json`
  split described in [`ARCHITECTURE.md`](ARCHITECTURE.md#monorepo-layout). Copy `adapters/`.

## Formatting

**Formatting is enforced, not reviewed.** Prettier owns it, CI checks it, and a PR with unformatted
code fails before anyone reads it — so nobody spends review time on whitespace, and you never get a
comment about a line break.

```bash
pnpm format        # format the whole repo in place — run before you push
pnpm format:check  # what CI runs; fails without writing anything
```

Both run from the repo root and cover **every** package — there is one config,
[`prettier.config.js`](prettier.config.js), and no per-package overrides. Don't add one.

It's Prettier's defaults except for two settings, both of which just ratify what the codebase
already did: `singleQuote: true` and `printWidth: 100`. If you disagree with a formatting choice,
open an issue about the config — don't hand-format around it, and don't add
`// prettier-ignore` to win an argument with the formatter.

The division of labour with ESLint is strict: **Prettier decides how code looks, ESLint decides
whether it's correct.** `eslint-config-prettier` is wired in last in `eslint.config.js` to turn off
any ESLint rule that would have an opinion about formatting, so the two can never disagree.

Editor setup is optional but recommended — install your editor's Prettier plugin and enable
format-on-save, and `pnpm format` becomes a no-op you never think about.

## Commits

Stenion follows the [Conventional Commits](https://www.conventionalcommits.org/) specification (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, etc.) for all commit messages.

An optional commit helper ([`git-aic`](https://github.com/Spectra010s/git-aic)) is configured in the repository. To generate conventional commit messages from your staged changes:

```bash
git add <files...>
pnpm commit
```

You can also write conventional commits manually using standard `git commit -m "type(scope): description"`.

## Adding a dependency

This project defaults to **no new dependencies unless there's a real reason** (it's solo and
pre-funding, on free tiers). If your adapter needs a package beyond `@stellar/stellar-sdk` and what
`@stenion/core` provides, call it out explicitly in the PR with the justification — don't add it
quietly.

## Changing a formula or threshold

Code and `METHODOLOGY.md` are **not allowed to drift**. If you touch factor logic — a threshold, a
weight, an anchor — you change both in the same PR, at the same review bar.

Everything in `METHODOLOGY.md` is meant to be challengeable, including by protocols being scored.
To propose a change:

1. **Open an issue** describing the specific threshold/formula and why it's wrong, anchored to
   something external where possible (a protocol's own on-chain parameter, a published risk
   framework, observed data) — not preference.
2. **Or open a PR** editing `METHODOLOGY.md` _and_ the adapter code together, with justification.
3. Adding or removing a factor is a **breaking change to the shared taxonomy** in
   `core/src/types.ts` — it affects every adapter at once and is held to a higher bar again.

## PR review expectations

Your PR should:

- Implement all five `*Safety` factors per the `METHODOLOGY.md` formulas (or `null` with a real
  reason), each with a meaningful `detail` string.
- Confirm every on-chain method/field name against the protocol's audited source or SDK — say so,
  and link it.
- Include the live-mainnet verification (what you ran, what the output was, why it's plausible).
- Pass `pnpm format:check`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` from the repo
  root. CI runs all five, in that order.
- Update `METHODOLOGY.md` in the same PR if — and only if — you introduced a per-protocol anchoring
  fact (like K2's `OPTIMAL_UTILIZATION_RATE`).

Reviews are careful, because a merged adapter puts a public number on a real protocol. **No change
is ever accepted in exchange for payment** — that's the whole premise of the project.
