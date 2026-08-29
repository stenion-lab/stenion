# Stenion — Working notes for Claude Code

This is the internal index for working _in_ this codebase. It holds the rules and conventions that
must not be broken, and points to the public docs for everything else. **Don't duplicate substance
here** — each public doc owns its content:

- **[`README.md`](README.md)** — what Stenion is, the pitch, local quick-start.
- **[`architecture/index.md`](architecture/index.md)** — monorepo layout, what each package does, data flow, deploy.
- **[`methodology/index.md`](methodology/index.md)** — the source of truth for every factor's formula, thresholds, weights.
- **[`TAXONOMY.md`](TAXONOMY.md)** — the admission standard a new scoring category must clear before
  an adapter is written for it. Owns the gates and the pre-flight checklist; nothing here restates them.
- **[`api-docs/index.md`](api-docs/index.md)** — the public API contract as a consumer meets it: endpoints, live example
  responses, the `ok`/`failed` union, staleness, rate limits, errors. Rendered at `/docs/api`.
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
- **`api-docs/`'s example responses are captured live, never written from the types.** A doc written
  from `db/src/store.ts` reproduces the type rather than the truth, and what a client observes is
  not always what a route sets (the CDN eats `s-maxage`). Re-`curl` them when a shape changes.
- **Code and `methodology/` are not allowed to drift.** Any change to a formula/threshold/weight
  changes both together, at the same review bar. Shared rulebook logic that two adapters would
  otherwise duplicate lives in [`core/src/scoring.ts`](core/src/scoring.ts), so it can't drift
  between them. **`methodology/` is organized per category** — each `ProtocolCategory` owns one
  FILE, named for the category (`methodology/lending.md`), holding its `## <Label>` section with its
  factor list, weight table, worked example and version changelog; `core/src/scoring.test.ts` and
  `core/src/category.test.ts` read `methodology/<category>.md` and parse that section out of it.
  Adding a category means adding that file; a category without one is a score with no published
  rules. The shared, category-agnostic material (ground rules, score model, what is published
  without being scored) lives in `methodology/index.md` and `methodology/publishing-rules.md`.
  **Order is content**: the parts concatenate back to one document, and the order they do that in
  is declared once in `dashboard/app/lib/doc-parts.mjs`.
- **A scoring change that makes old scores non-comparable bumps that category's
  `METHODOLOGY_VERSIONS` entry** (`core/src/category.ts`), stamped onto every run by the indexer
  alongside `risk_scores.category` — counters are per category and each starts at 1, so the pair
  identifies a rulebook and the integer alone does not. History is never backfilled —
  `risk_scores` stores only outputs, not the raw inputs — so the discontinuity is labeled, not
  hidden.
- **Findings are not scores.** Verifiable observations we can't or won't grade go in the protocol
  page's Findings section (`dashboard/app/lib/protocol-notes.ts`), never into a factor. Nothing
  there is read by any scoring path.
- **There are THREE ways to publish a fact, and only one of them is a number.** Scored factors;
  static Findings (hand-written, reviewed in a PR); and **live ungraded state** — measured every
  cycle, published as a typed field, never graded. The third exists because pause/frozen state is
  real, changing, on-chain data that changes how a score should be read while nothing on chain
  lets us grade it (`OperationalState`, `core/src/operational-state.ts`, decided in #15). Its rule:
  a live ungraded field must be **published beside the score wherever the score appears**, or the
  decision not to grade it becomes a decision to hide it. Nothing in that category may be reachable
  from `scoreFactors` — the adapters' `computeRiskFactors` must produce a byte-identical factor map
  whatever the state says, and both adapter test suites assert exactly that. When a new ungraded
  observation turns up, put it in whichever of the three fits how it is obtained; don't invent a
  fourth, and don't quietly promote one into a factor.
- **An unscored listing is a coverage statement, never a score.** Protocols we assessed and don't
  score are published on the registry from `dashboard/app/lib/coverage.ts` — never in the
  `protocols` table, whose never-scored state (`safetyScore: null`, "never run") means _our pipeline
  hasn't got there yet_ and must not be collided with a deliberate decision. Nothing in that section
  renders a numeral, so "not scored" can't be misread as "scored badly"; it's unranked, because
  ranking what we didn't score is meaningless. Every entry needs a protocol-specific reason, a
  one-sentence `summary` for its registry row, and a `verify` sentence, and any claim resting on a
  reading (a balance) needs an `asOf` — figures we never checked against contracts are not a source.
  Enforced in `coverage.test.ts`. Each entry's full reasoning lives at **`/coverage/<id>`**, served
  only from that module — never `/protocol/<id>`, which would either 404 in the API while rendering
  in the dashboard or force `getProtocolDetail` to serve two shapes.
- **Nothing unscored may sit inside a ranked ordering, and a position numeral means a position.**
  The registry's sort/filter/search is pure functions in `dashboard/app/lib/registry-query.ts`
  (state in query params, never component state) so this is testable rather than a rendering habit.
  Score sorts rank the scored set only; unscored entries are a separate block below, and the
  never-scored `safetyScore: null` rows are a third block of their own. Name sort is the sole
  ordering allowed to merge them, because alphabetical asserts no ranking. The `#` column renders
  **only** under score-descending and is removed — not blanked — otherwise: under score-ascending
  "01" would label the lowest score as first. Enforced in `registry-query.test.ts`.
- **A `#` numeral is scoped to one category, and no ordering may place two categories' scores in
  one ranked sequence.** The generalization of the rule above: a position is meaningless across
  entries that were never compared, and two `safetyScore`s are comparable only when the same
  rulebook produced them — each category is scored on its own factors under its own weights. So
  `buildRegistryView` publishes `RankedCategoryGroup[]` and **no flat ranked array**: each
  category is its own block, numbered 01..n within itself, and there is nowhere for a
  cross-category ranking to live. Name sort remains the sole ordering allowed to merge them,
  for the same reason it may merge scored with unscored. Enforced in `registry-query.test.ts`,
  which also pins that a single-category board renders exactly what it did before this rule
  existed.
- **A registry entry is a market, not necessarily a protocol — and it must say which.** An entry
  running another protocol's contracts (the YieldBlox pool on Blend V2) carries
  `ProtocolMetadata.deployedOn`, published as `deployedOn` on both API responses and rendered
  beside the name everywhere the name appears. Presenting such a market as an independent protocol
  is the misrepresentation the standalone-YieldBlox-adapter decision refused; the label is the
  condition on which the entry exists, not decoration.

## Score conventions & taxonomy

- **Overall score: 0–100, higher = safer**; field/API name `safetyScore` (not `riskScore`).
- **Every factor is on the same scale: 0–100, higher = safer.** Names end in `*Safety` so a name
  never disagrees with its number. Don't add a factor whose name implies "higher = riskier."
- Fixed shared taxonomy, defined once in the `RiskFactorType` enum in
  [`core/src/types.ts`](core/src/types.ts) — five factors, every adapter populates all five
  (`collateralSafety`, `oracleSafety`, `adminKeySafety`, `liquiditySafety`, `utilizationSafety`).
  _How_ a factor is computed can differ per protocol; the names/scale/thresholds do not. New factors
  are added to `core` for everyone — never invented per-adapter (a breaking change to the taxonomy).
- Formulas, weights, and per-protocol anchoring facts live in [`methodology/index.md`](methodology/index.md) —
  the public rulebook. Don't restate them here.

## Code conventions

- **Package manager: pnpm**, via corepack. The version is pinned by the `packageManager` field in
  the root `package.json` (currently `pnpm@9.15.9`), and that field is the **only** place it is
  declared: CI's `pnpm/action-setup` step deliberately passes no `version:` input and reads the same
  field, so a contributor's local pnpm and CI's cannot diverge. Corepack enforces it — with
  `corepack enable` done, `pnpm --version` inside this repo reports the pinned version regardless of
  any globally-installed pnpm. Bump it with `corepack use pnpm@<version>`, and expect a lockfile
  review. pnpm workspaces monorepo — see [`architecture/index.md`](architecture/index.md) for the package map.
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
- **A tested module that has siblings names them with an explicit `.ts`.** Node's type-stripping
  loader resolves a test's import graph literally, so a module a test imports cannot use
  extensionless relative imports; the emitted CommonJS must still say `.js`. Where both are true,
  the package sets `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` in its
  `tsconfig.build.json` so one source satisfies both — `indexer` (for `cycle.ts` → `./retry.ts` /
  `./alerts.ts`) and `adapters` (for each adapter's `index.ts` → `./fetch.ts` / `./score.ts` /
  `./types.ts`). Elsewhere, keep a tested module a leaf with no relative imports and the question
  never arises.
- **A weight is never a literal in an adapter.** Which factors a category scores, what each is
  weighted, and what it is called are declared once in
  [`core/src/weights.ts`](core/src/weights.ts) (`CATEGORY_FACTORS`, keyed by `ProtocolCategory`
  like `METHODOLOGY_VERSIONS` and `CATEGORY_OPERATIONS`); adapters read
  `LENDING_FACTORS.<factor>.weight`. Two adapters holding their own copies of the same weight can
  drift into two rulebooks while both still produce plausible scores — the failure the shared
  `scoreFactors` exists to prevent, applied to the numbers it averages. `scoreFactors` is generic
  over the factor map for the same reason: the weighted mean is category-agnostic, so there must
  never be a per-category variant of it. **A category may be registered before its weights are
  reviewed, and that state is typed, not commented.** `CategoryFactors` is a union discriminated on
  `status`: `'published'` carries `FactorDeclaration` (weight required), `'pendingWeights'` carries
  `UnweightedFactorDeclaration`, which has **no `weight` property at all** — so reading one is a
  compile error rather than an `undefined` that becomes `NaN` in `scoreFactors` and publishes a
  confident-looking `0`. It exists because `TAXONOMY.md` admits a category in two steps (the factor
  set, then the weight table), and a placeholder weight is indistinguishable from a reviewed one the
  moment anyone reads it. `weights.test.ts` asserts the absence at runtime and `scoring.test.ts`
  asserts such a category publishes **no** weight table in `methodology/`, so the two cannot drift
  into agreeing on a number nobody reviewed. It is a state to leave, not to live in — `dex` is in it
  today (#100 → #102).
- **An adapter is a FOLDER of four files, and only `index.ts` is API.** `adapters/<protocol>/`
  holds `types.ts` (mainnet wiring, constants, raw on-chain shape, options), `fetch.ts` (everything
  touching RPC/Horizon, plus decoders, behind one `fetch*` entry point), `score.ts` (the five
  factors and `operationalState`, pure functions of the raw data — no RPC, no clock, no instance
  state, which is what lets a fixture exercise every rule) and `index.ts` (the `Adapter` class).
  `index.ts` re-exports **explicitly, never `export *`**: the other three export more than the
  package's API, and a wildcard would publish every internal helper as a name consumers can depend
  on. The tests live in the folder and mirror it: `fetch.test.ts` covers the read-side
  decodes and verdicts, `score.test.ts` the factors and `operationalState`. Both reach the
  code through `./index.ts`, the same public surface they used before the split, so the
  split moved tests without changing what any of them covers. The cross-adapter
  captured-mainnet snapshots stay at `adapters/snapshot.test.ts` — they pin several
  adapters at once and belong to no one folder.
- **One adapter may serve several markets; a market never gets its own adapter.** `BlendAdapter`
  takes a `BlendPool` (slug, name, pool contract, mark, links, `deployedOn`) and the indexer
  iterates `BLEND_POOLS` — every Blend market runs the same wasm, so a second pool is a config
  entry and no new scoring code. Nothing on `BlendPool` may be a threshold, weight, or formula:
  that would be a per-pool rulebook. Identity is built per instance from the pool given, so
  `contractId` can never name a pool the numbers didn't come from.
- **Error handling:** adapters throw on failure; the indexer wraps each run in try/catch and records
  a failed/stale run. Error handling lives in the indexer, not duplicated per adapter. The indexer
  runs adapters through the `toTarget<T>()` wrapper (see [`indexer/src/index.ts`](indexer/src/index.ts))
  so a heterogeneous adapter list shares one typed run loop. `core/src/adapter.ts` carries
  `ADAPTER_INTERFACE_VERSION` — bump it for breaking interface changes rather than rewriting
  every adapter at once. It is at **2**: v2 added the required `operationalState(raw)` method
  (#15). Required rather than optional, deliberately — an optional method is one every future
  adapter can skip, which is the retrofit debt the constant exists to make visible.
- **Nothing persisted or published may come from a runtime identifier.** No `constructor.name`,
  `fn.name`, or similar for a value that reaches the database or an API response — use a string
  literal. The workspace packages are bundled and minified into the dashboard's serverless
  functions, so identifiers are renamed there and _only_ there: such a value is correct in every
  test and in local dev, and wrong in production. Full rationale in [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Tests are `node --test`, zero dependencies.** `*.test.ts` files run on Node's built-in runner
  via native type stripping (`pnpm test`); test files import with an explicit `.ts` extension, app
  code doesn't. Test pure logic whose important cases live data can't reach — not for coverage.
  Full rationale in [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **No new dependencies without flagging.** This is solo and pre-funding, on free tiers. If a change
  needs a package, call it out explicitly with the justification — don't add it quietly. (The
  dashboard's UI stack — Tailwind v4, framer-motion, etc. — is a deliberate, already-decided
  exception, documented in `architecture/`/the dashboard.)
- Full adapter-writing guide (interface, taxonomy, verification, PR bar) is in
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Deploy architecture (summary — full detail in `architecture/`)

One Vercel project = the `dashboard`. A page that renders repo-root markdown (`/methodology` →
`methodology/`, `/docs/api` → `api-docs/`) **must** have an `outputFileTracingIncludes` entry in
`next.config.mjs` covering **every** part file — they are outside the dashboard dir, and without
them the route works in `next dev` and fails only in production. Both the routes and that config
read one list, `dashboard/app/lib/doc-parts.mjs`, so a new part cannot be rendered without also
being traced. **`@stellar/stellar-sdk` must never be added to
`serverExternalPackages`** — externalizing it makes the bundler emit a native `require()` into the
SDK's CJS build, which requires ESM-only `@noble/hashes`, so the cron route throws
`ERR_REQUIRE_ESM` at import time on any runtime without `require(esm)` and the indexer stops
silently (`lastRunStatus` stays `ok`, `staleMinutes` climbs). It must stay **bundled**; full
incident and the verification recipe are in `architecture/`. The API lives as Next.js Route Handlers
(`/api/v1/protocols`, `/api/v1/coverage`, `/api/v1/protocol/[id]`, `/api/v1/health` — versioned;
there are **no**
unversioned paths, the
former transitional aliases were removed and now 404, and the versioning policy lives in
`architecture/`); the dashboard's own pages read `@stenion/db`'s `Store`
in-process (no HTTP hop). The indexer is triggered by a secret-gated cron route
(`POST /api/cron/run-indexer`), which an external cron-job.org job POSTs to every 5 minutes with
`Authorization: Bearer <CRON_SECRET>`. That schedule lives in the cron-job.org dashboard, **not in
this repo** — there is no workflow or `vercel.json` `crons` entry to find. `@stenion/api` is legacy —
kept but not deployed. Env vars: `DATABASE_URL` (Neon pooled), `STENION_RPC_URL`,
`STENION_HORIZON_URL`, `CRON_SECRET`, plus optional `STENION_ALERT_WEBHOOK_URL` (indexer failure
alerts; unset = off), `STENION_RATE_LIMIT_SALT`, and the retry/threshold, rate-limit and
health-threshold knobs, which all have defaults. Every variable the repo understands is documented in `.env.example`.

All four `/v1` read routes are rate limited. Three are CDN-cached; `/v1/health` deliberately is
**not** (`no-store`) — staleness there advances with the wall clock, so any TTL can serve a
`healthy` 200 after the true answer became `degraded`. The cron route is **neither**, and must
stay that way — rate limiting an authenticated internal trigger can only block a scheduled run.
Caching there is meaningless (it's a POST that does work). The rate limiter's counter lives in
Postgres because serverless has no shared memory, and it **fails open**: a limiter that can 429 the
whole API when its own query breaks is worse than no limiter. Policy, limits and the
staleness-vs-cache reasoning live in `architecture/deploy-architecture.md` "Caching and rate
limits" — the load-bearing
rule here is that **caching must never mask `lastRunAt`/`lastRunStatus`**, which is why the TTL is
computed per response from the body rather than being a constant.

> **The 60s ceiling is load-bearing.** `maxDuration` is capped at 60 on Vercel's Hobby tier and
> cannot be raised. The indexer's retry budget (`STENION_CYCLE_BUDGET_MS`, default 42s) exists to
> stay inside it: a cycle killed mid-flight can leave one protocol scored and the other neither
> scored nor recorded as failed, which is worse than a clean failure. Raise the budget only against
> observed cycle durations, never by arithmetic alone.
>
> **The budget is NOT divided per target, and must not go back to being.** Targets run through a
> bounded worker pool (`STENION_CYCLE_CONCURRENCY`, default 2) and each gets the end of the budget
> less one full attempt reserved per queued wave (`targetDeadline`). A rule where a target's
> deadline shrinks as the registry grows can fail protocols that already work — that is what
> `budgetMs / targetCount` did, and #68 removed it. The replacement's ceiling is the explicit
> condition `ceil(targets / concurrency) * attemptTimeoutMs <= budgetMs`, checked by
> `cycleFeasibility()` and warned about every cycle, never discovered by adding a pool.
>
> **`STENION_CYCLE_CONCURRENCY` ships at 1, and raising it is a measurement question, not a
> judgement call.** It shipped at 2 and was reverted the same day when the free shared public RPC
> started returning `429` to the target running behind the burst — the root cause was request
> _rate_, which the pre-deploy estimate got wrong by computing it from developer-machine durations.
> **Never make an RPC-load claim from local timings; measure the deployed function** (the cron
> route returns per-target `durationMs` and `totalMs` for exactly this). Full incident in
> `architecture/`.

> **Local hazard:** never run `next build`/`next start`/a second `next dev` against the same checkout
> while a dev server is up — they share one `.next` and corrupt each other. Vercel builds in
> isolation, so this is local-only.

## Open questions

Oracle _manipulation_ vs staleness is **resolved and shipped** — `oracleSafety` now scores both,
and it is part of methodology **v1**, the only version that exists (see
[`methodology/index.md`](methodology/index.md) §2 and its "Current version" section). It was done by extending
an existing factor rather than adding a sixth, so the five-factor taxonomy in `core/src/types.ts`
is unchanged.

Pause/frozen-pool state is **resolved and shipped** — and resolved as a decision _not_ to score
it. It is published as `operationalState`, a live ungraded field beside the score, on the reasoning
in [`methodology/index.md`](methodology/index.md) "Operational state is published, never scored". The taxonomy
in `core/src/types.ts` is unchanged and lending's methodology version stayed at 1, because nothing about
what a number means changed.

Still open, and tracked in [`ROADMAP.md`](ROADMAP.md): market-depth-aware oracle scoring. It is a
breaking taxonomy change, so it's flagged, not resolved ad hoc.

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

- A new/changed formula, threshold, or weight → [`methodology/index.md`](methodology/index.md) (and the adapter
  code, in the same change).
- A new package, data-flow change, or deploy change → [`architecture/index.md`](architecture/index.md).
- A new adapter, or a change to how adapters are written/reviewed → [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Something shipped, planned, skipped, or newly out of scope → [`ROADMAP.md`](ROADMAP.md).

Only update **this** file when a non-negotiable rule, a score/code convention, or the deploy summary
changes — i.e. the stable working rules, not project progress. Keep it a thin index that points to
the docs; don't let it grow back into a step-by-step tracker.
