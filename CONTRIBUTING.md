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
  readonly metadata: ProtocolMetadata; // { id: slug, name, chain: 'stellar' }

  fetchRawData(): Promise<TRawData>; // pull raw on-chain state (RPC + Horizon)

  computeRiskFactors(rawData: TRawData): Promise<RiskFactorMap>; // → the five *Safety factors

  score(factors: RiskFactorMap): RiskScoreResult; // → weighted safetyScore
}
```

Three separate methods (not one `run()`) so the indexer can inspect intermediate output and so
`score()` can be unit-tested against fixed factor inputs without touching RPC.

## The `*Safety` taxonomy — populate all five

Every adapter must populate the same fixed five factors from `RiskFactorType`
([`core/src/types.ts`](core/src/types.ts)). This shared taxonomy is what makes protocols comparable
— it is **not** freeform per protocol.

```ts
riskFactors: {
  collateralSafety,    // collateral concentration (diversification)  — weight 0.20
  oracleSafety,        // price freshness + manipulation resistance   — weight 0.25
  adminKeySafety,      // admin signer structure + activity            — weight 0.20
  liquiditySafety,     // free-liquidity depth (withdrawal cushion)    — weight 0.15
  utilizationSafety,   // headroom below the configured utilization cap — weight 0.20
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
- **Each factor carries a `detail` string** — a short, human-readable explanation of what drove the
  value (e.g. "top reserve holds 95% of supplied value"). This is what the dashboard shows and what
  makes the number auditable. Write a real one.

**How** a factor is computed can differ per protocol; the names, scale, and thresholds do not. New
factors are added to `@stenion/core` for everyone at once — never invented per-adapter.

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
`METHODOLOGY_VERSION` bump (see [Changing a formula or threshold](#changing-a-formula-or-threshold)).
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
lending protocol**. Two real, significant protocols were investigated and _deliberately skipped_
because they aren't (details in [`ROADMAP.md`](ROADMAP.md)):

- **YieldBlox** — turned out to be a community-managed pool _on Blend V2_, not an independent
  protocol. An adapter would just be `BlendAdapter` pointed at a different pool.
- **Templar** — its lending market state lives on **NEAR**, not Stellar; only its price oracle is
  native Soroban. Reading NEAR would break the trustless-Stellar rule.

So: confirm reserves, utilization, liquidity, admin, and oracle are all readable via **Soroban RPC +
Horizon** from the protocol's _own_ contracts (not another chain, not another protocol's pool)
before you commit to an adapter. Confirming this from the contracts first — rather than assuming it
mirrors Blend/K2 — is the whole point.

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

### Mainnet snapshot fixtures

Alongside the synthetic tests, `adapters/fixtures/*.ts` holds **frozen captures of real mainnet
state**, asserted in `adapters/snapshot.test.ts`. They exist because hand-built fixtures use tidy
numbers and real pools don't: Blend's live reserves carry `b_rate` values like 1.2214, and a bug in
the fixed-point scaling cancels out entirely when the rate is exactly 1.0. Removing the rate
multiplication passes every synthetic test and fails only here.

Capture one with:

```bash
pnpm --filter @stenion/adapters build     # the script reads the built adapter
pnpm capture:fixture blend                # or: kinetic | all
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
