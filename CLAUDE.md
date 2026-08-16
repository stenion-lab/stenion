# Stenion — Working notes for Claude Code

This is the internal index for working _in_ this codebase. It holds the rules and conventions that
must not be broken, and points to the public docs for everything else. **Don't duplicate substance
here** — each public doc owns its content:

- **[`README.md`](README.md)** — what Stenion is, the pitch, local quick-start.
- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — monorepo layout, what each package does, data flow, deploy.
- **[`METHODOLOGY.md`](METHODOLOGY.md)** — the source of truth for every factor's formula, thresholds, weights.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to write an adapter, conventions, PR expectations.
- **[`ROADMAP.md`](ROADMAP.md)** — what's live, what's planned, what's out of scope, and open taxonomy questions.

## What this is (one line)

An open-source, live risk-intelligence platform for Stellar/Soroban DeFi lending protocols
(Blend + Kinetic shipped). The differentiator is **continuous, on-chain-derived risk scoring** — not
TVL tracking. Full framing in [`README.md`](README.md).

## Non-negotiable rules

These override any default behavior and are enforced in code and review:

- **Payment must never affect the score.** Protocols pay for visibility/speed/private tooling —
  never for a better number. The real registry is always free, public, ranked purely on score. Paid
  "Spotlight" is a visually separate, clearly-labeled section.
- **AI only explains/summarizes real underlying data** — never an independent risk assessment.
- **Adapters read trustless on-chain data** (Soroban RPC + Horizon) — never self-reported figures.
- **No fabricated numbers.** When real data isn't available for a factor, use a clearly-flagged
  neutral baseline (e.g. `adminKeySafety`'s contract-admin `60`) — never an invented value.
- **Code and `METHODOLOGY.md` are not allowed to drift.** Any change to a formula/threshold/weight
  changes both together, at the same review bar. Shared rulebook logic that two adapters would
  otherwise duplicate lives in [`core/src/scoring.ts`](core/src/scoring.ts), so it can't drift
  between them.
- **A scoring change that makes old scores non-comparable bumps `METHODOLOGY_VERSION`**
  (`core/src/types.ts`), stamped onto every run by the indexer. History is never backfilled —
  `risk_scores` stores only outputs, not the raw inputs — so the discontinuity is labeled, not
  hidden.
- **Findings are not scores.** Verifiable observations we can't or won't grade go in the protocol
  page's Findings section (`dashboard/app/lib/protocol-notes.ts`), never into a factor. Nothing
  there is read by any scoring path.

## Score conventions & taxonomy

- **Overall score: 0–100, higher = safer**; field/API name `safetyScore` (not `riskScore`).
- **Every factor is on the same scale: 0–100, higher = safer.** Names end in `*Safety` so a name
  never disagrees with its number. Don't add a factor whose name implies "higher = riskier."
- Fixed shared taxonomy, defined once in the `RiskFactorType` enum in
  [`core/src/types.ts`](core/src/types.ts) — five factors, every adapter populates all five
  (`collateralSafety`, `oracleSafety`, `adminKeySafety`, `liquiditySafety`, `utilizationSafety`).
  _How_ a factor is computed can differ per protocol; the names/scale/thresholds do not. New factors
  are added to `core` for everyone — never invented per-adapter (a breaking change to the taxonomy).
- Formulas, weights, and per-protocol anchoring facts live in [`METHODOLOGY.md`](METHODOLOGY.md) —
  the public rulebook. Don't restate them here.

## Code conventions

- **Package manager: pnpm**, via corepack. The version is pinned by the `packageManager` field in
  the root `package.json` (currently `pnpm@9.15.9`), and that field is the **only** place it is
  declared: CI's `pnpm/action-setup` step deliberately passes no `version:` input and reads the same
  field, so a contributor's local pnpm and CI's cannot diverge. Corepack enforces it — with
  `corepack enable` done, `pnpm --version` inside this repo reports the pinned version regardless of
  any globally-installed pnpm. Bump it with `corepack use pnpm@<version>`, and expect a lockfile
  review. pnpm workspaces monorepo — see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the package map.
- **TypeScript config split:** `tsconfig.base.json` (shared settings) → `tsconfig.node.json`
  (`nodeNext`, extended by all backend packages) → `dashboard` has its own Next.js config (bundler
  resolution), which does **not** extend the Node config. Plus `tsconfig.check.json` (`noEmit` +
  `allowImportingTsExtensions`), extended by a backend package's own `tsconfig.json` so that
  sources **and** `*.test.ts` are typechecked together; emitting moves to a sibling
  `tsconfig.build.json` that excludes tests. **Keep it that way round:** editors resolve a file
  through the nearest `tsconfig.json`, so if that config excludes tests they belong to no project
  and the editor red-underlines every `.ts` import while the CLI stays green. Verify with
  `pnpm -r exec tsc --showConfig` if something looks off (restart the TS server before assuming a
  config bug — editor squiggles can be stale cache).
- **Error handling:** adapters throw on failure; the indexer wraps each run in try/catch and records
  a failed/stale run. Error handling lives in the indexer, not duplicated per adapter. The indexer
  runs adapters through the `toTarget<T>()` wrapper (see [`indexer/src/index.ts`](indexer/src/index.ts))
  so a heterogeneous adapter list shares one typed run loop. `core/src/adapter.ts` carries
  `ADAPTER_INTERFACE_VERSION` — bump it for future breaking interface changes rather than rewriting
  every adapter at once.
- **Tests are `node --test`, zero dependencies.** `*.test.ts` files run on Node's built-in runner
  via native type stripping (`pnpm test`); test files import with an explicit `.ts` extension, app
  code doesn't. Test pure logic whose important cases live data can't reach — not for coverage.
  Full rationale in [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **No new dependencies without flagging.** This is solo and pre-funding, on free tiers. If a change
  needs a package, call it out explicitly with the justification — don't add it quietly. (The
  dashboard's UI stack — Tailwind v4, framer-motion, etc. — is a deliberate, already-decided
  exception, documented in `ARCHITECTURE.md`/the dashboard.)
- Full adapter-writing guide (interface, taxonomy, verification, PR bar) is in
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Deploy architecture (summary — full detail in `ARCHITECTURE.md`)

One Vercel project = the `dashboard`. The API lives as Next.js Route Handlers
(`/api/v1/protocols`, `/api/v1/protocol/[id]` — versioned; there are **no** unversioned paths, the
former transitional aliases were removed and now 404, and the versioning policy lives in
`ARCHITECTURE.md`); the dashboard's own pages read `@stenion/db`'s `Store`
in-process (no HTTP hop). The indexer is triggered by a secret-gated cron route
(`POST /api/cron/run-indexer`), which an external cron-job.org job POSTs to every 5 minutes with
`Authorization: Bearer <CRON_SECRET>`. That schedule lives in the cron-job.org dashboard, **not in
this repo** — there is no workflow or `vercel.json` `crons` entry to find. `@stenion/api` is legacy —
kept but not deployed. Env vars: `DATABASE_URL` (Neon pooled), `STENION_RPC_URL`,
`STENION_HORIZON_URL`, `CRON_SECRET`.

> **Local hazard:** never run `next build`/`next start`/a second `next dev` against the same checkout
> while a dev server is up — they share one `.next` and corrupt each other. Vercel builds in
> isolation, so this is local-only.

## Open questions

Oracle _manipulation_ vs staleness is **resolved and shipped** — `oracleSafety` now scores both, as
methodology v2 (effective 2026-08-14 11:25 UTC; see [`METHODOLOGY.md`](METHODOLOGY.md) §2 and its
"Current version" section). It was done by extending an existing factor rather than adding a sixth,
so the five-factor taxonomy in `core/src/types.ts` is unchanged.

Still open, and tracked in [`ROADMAP.md`](ROADMAP.md): scoring pause/frozen-pool state, and
market-depth-aware oracle scoring. Both are breaking taxonomy changes, so they're flagged, not
resolved ad hoc.

## Working style

- Be direct — flag problems, don't soften them, don't oversell progress.
- Prefer crude-but-honest over polished-but-fake. A working score for one protocol beats a beautiful
  mock for five.
- Don't add scope without flagging it first.
- If anything about an interface, schema, or naming is ambiguous or inconsistent, ask/flag rather
  than guess or silently resolve — these are expensive to change once more adapters depend on them.
- This is being built solo by a Nigeria-based developer, pre-funding (SCF application planned).
  Infra choices default to free tiers until there's a reason to pay.

## Keeping the docs current

**Update the docs yourself at the end of a session — don't wait to be asked.** When something
changes, update the doc that _owns_ that content, not this file:

- A new/changed formula, threshold, or weight → [`METHODOLOGY.md`](METHODOLOGY.md) (and the adapter
  code, in the same change).
- A new package, data-flow change, or deploy change → [`ARCHITECTURE.md`](ARCHITECTURE.md).
- A new adapter, or a change to how adapters are written/reviewed → [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Something shipped, planned, skipped, or newly out of scope → [`ROADMAP.md`](ROADMAP.md).

Only update **this** file when a non-negotiable rule, a score/code convention, or the deploy summary
changes — i.e. the stable working rules, not project progress. Keep it a thin index that points to
the docs; don't let it grow back into a step-by-step tracker.
