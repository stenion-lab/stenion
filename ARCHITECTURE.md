# Stenion Architecture

The technical shape of the system: how the code is organized, how data flows from the chain to a
score on the dashboard, and how it's deployed. For _how a score is calculated_, see
[`METHODOLOGY.md`](METHODOLOGY.md); for _how to add a protocol_, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Monorepo layout

Stenion is a [pnpm workspaces](https://pnpm.io/workspaces) monorepo. Each directory is an internal
package; the adapters import `@stenion/core`'s `Adapter` interface as a real typed dependency.

```
/core        — @stenion/core        Adapter interface + RiskFactorType taxonomy + shared types
/adapters    — @stenion/adapters    one file per protocol (blend.ts, kinetic.ts), each an Adapter
/db          — @stenion/db          Postgres layer: pg pool, typed Store, raw-SQL migrations
/indexer     — @stenion/indexer     scheduler that runs adapters on an interval, writes to Postgres
/api         — @stenion/api         standalone REST server (legacy — see "Why @stenion/api exists")
/dashboard   — @stenion/dashboard   Next.js site + the deployed API routes + the cron-trigger route
```

TypeScript is configured in four layers (see [`CLAUDE.md`](CLAUDE.md) for the rationale):

- `tsconfig.base.json` — shared compiler settings only (target, strict, etc.).
- `tsconfig.node.json` — extends base, adds `nodeNext` module/resolution. Backend packages
  (`core`, `db`, `indexer`, `api`, `adapters`) extend this.
- `tsconfig.check.json` — extends the Node config, adds `noEmit` + `allowImportingTsExtensions`.
  A backend package's own `tsconfig.json` extends **this**, so its sources and its `*.test.ts` are
  typechecked as one project; the package emits from a sibling `tsconfig.build.json` that excludes
  tests. Test files import with explicit `.ts` extensions because Node's runner needs them under
  type stripping, and tsc only permits that when it isn't emitting — hence the split.

  **The direction matters.** Editors resolve a file through the nearest `tsconfig.json`, so that
  config is the one that must include the tests. Excluding them there (and typechecking via a
  separately-named config) leaves test files in no project at all: the CLI passes, because it was
  pointed at the right file explicitly, while the editor falls back to an inferred project and
  underlines every `.ts` import. All four backend packages (`core`, `adapters`, `db`, `indexer`)
  use this split.

- `dashboard` has its own Next.js-generated config (bundler resolution) — it does **not** extend
  the Node config. It needs no split: it's already `noEmit` and sets the flag directly.

### What each package does

**`@stenion/core`** — the contract everything else agrees on. Defines the `Adapter<TRawData>`
interface (`fetchRawData` → `computeRiskFactors` → `score`), the `RiskFactorType` enum (the fixed
five-factor `*Safety` taxonomy), and the shared result types. Adding a factor here is a breaking
change felt by every adapter, so it's deliberately small and stable. Carries
`ADAPTER_INTERFACE_VERSION` as a seam for future breaking changes.

It also owns the pieces of the rulebook that must not differ between adapters, in
`core/src/scoring.ts`: `scoreFactors()` (the weighted mean — an adapter's `score()` delegates to it
and must never reimplement it, or two protocols end up on two rulebooks) and `freshnessWindow()`
with `STALE_CEILING_SECONDS`. Per-protocol _input reading_ stays in the adapters; nothing in this
file reaches for chain data.

**`@stenion/adapters`** — one file per protocol, each a class implementing `Adapter`. An adapter
reads a protocol's on-chain state (Soroban RPC + Horizon), reduces it into the five `*Safety`
factors using the formulas in `METHODOLOGY.md`, and produces a weighted `safetyScore`. Currently
`BlendAdapter` and `KineticAdapter`. Adapters throw on failure; they never swallow errors.

**`@stenion/db`** — the single, typed storage layer, shared by both the indexer (writes) and the
dashboard/API (reads) so there's no duplicated connection logic. Exposes a lazy singleton `pg`
`Pool` (`getPool`/`closePool`), a `createStore(pool)` factory with all read/write methods, env
loading, and the persisted `RunRecord` type. Two tables:

- `protocols` — one row per protocol (slug PK, name, chain, adapter class name). Upserted at
  indexer startup from adapter metadata.
- `risk_scores` — append-only history. `safety_score` is promoted to its own `numeric` column
  (it's what the registry ranks on); the five factors live in one `jsonb` column (displayed, not
  ranked, and growing the taxonomy then needs no migration). `methodology_version` records which
  rulebook produced the score — see below. A DB-level CHECK enforces the `ok`/`failed`
  discriminated union.

**Methodology versioning.** The rulebook is currently at **v2**, effective 2026-08-14 11:25 UTC —
what changed, the exact v1/v2 boundary in stored rows, and what does and doesn't warrant a bump
are all in [`METHODOLOGY.md`](METHODOLOGY.md#current-version). Mechanically: a scoring change that
makes old scores non-comparable bumps
`METHODOLOGY_VERSION` in `@stenion/core`; the indexer stamps it onto every run. History is
**never backfilled** — `risk_scores` keeps only outputs (score + factor map), never the raw
on-chain inputs, so an old row genuinely cannot be recomputed under new rules. The version is
surfaced on the protocol detail and on each history point so the dashboard marks the break
rather than rendering an unexplained step change. Migrations that add such a column must stay
writable by the _currently deployed_ indexer: `main` keeps running the old code until it's
promoted, and both share one Neon database.

Migrations are raw `.sql` files plus a ~40-line runner (`db/src/migrate.ts`) — no ORM.

**`@stenion/indexer`** — the scheduler. On an interval it runs every adapter through a small
`toTarget<T>()` wrapper (which hides each adapter's `TRawData` so a heterogeneous adapter list can
share one typed run loop), wraps each run in try/catch, and writes the outcome — score + factors,
or a failed marker — to Postgres. Deliberately dumb: one interval, no retries, no alerting. It
exports `runIndexerCycle()` (one cycle, used by the cron route) and guards its standalone loop
behind `require.main === module` so importing it doesn't start the loop.

The package is two modules, split along a line worth preserving. `src/cycle.ts` holds the run loop
(`runCycle`, `toTarget`) and is a pure function of its arguments — it takes the targets and the
`Store` to write to, and reaches for no env, no pool, and no config. `src/index.ts` is the process
entry point: env loading, pool construction, the interval, and the `require.main` guard. The split
exists because the error model is the part most worth testing and least exercised in production, and
the entry point cannot be imported from a test at all — its `require.main` guard and extensionless
relative imports are both CommonJS-only, which Node's ESM type-stripping loader rejects. Keep new
run-loop logic in `cycle.ts`.

**`@stenion/dashboard`** — a Next.js 15 (App Router) site, and the actual deployment target. It's
three things in one Vercel project:

1. The public site (homepage, registry, on-site methodology, about, per-protocol detail pages).
   Data pages are async Server Components that read `@stenion/db`'s `Store` **in-process** — no
   HTTP hop.

   The protocol page's **score-history chart** is a client component drawing hand-rolled SVG (no
   charting library) over the `history` array the detail response already carries — it adds no
   endpoint and no query. All of its judgment about what counts as a discontinuity lives in the
   pure, framework-free `app/lib/score-series.ts` so it can be tested against fixtures; the
   component only draws what that returns. The rule it enforces is that a break in the line means
   _the score is unknown here_ — a failed run, an indexing gap wider than 3× the measured cadence,
   or a methodology-version change. None of the three is ever drawn through, and a failed run is
   never rendered as a zero.

2. The public API, as Route Handlers: `GET /api/v1/protocols`, `GET /api/v1/protocol/:id`.
3. A secret-gated cron-trigger route (`POST /api/cron/run-indexer`) that runs one indexer cycle.

**`@stenion/api`** — a standalone `node:http` REST server. **Not deployed** — see below.

## Data flow

```
  Soroban RPC + Horizon              (trustless on-chain sources)
          │
          ▼
   Adapter.fetchRawData()            raw protocol state (per-adapter shape)
          │
          ▼
   Adapter.computeRiskFactors()      → the five *Safety factors (shared taxonomy)
          │
          ▼
   Adapter.score()                   → weighted safetyScore (0–100)
          │
          ▼
   Indexer (runIndexerCycle)         try/catch per adapter, one row per run
          │
          ▼
   Postgres  (@stenion/db)           protocols + risk_scores (append-only history)
          │
          ├──────────────┐
          ▼              ▼
   Dashboard pages   API routes      dashboard reads the Store in-process;
   (Server         (/api/v1/*)       routes read the same Store for external
    Components)                       consumers (wallets, third parties)
```

The key invariant: **the dashboard's own pages and the public API routes both go through the same
`Store` methods** (`listProtocolsWithLatestScore`, `getProtocolDetail`), so the JSON contract and
what the site renders can't drift apart. Nothing is ever recomputed at read time — the indexer owns
scoring; readers only shape stored rows.

**Staleness model:** the displayed `safetyScore` is always the latest _ok_ run (null if never
scored); the newest run of _any_ status is surfaced separately as `lastRunAt`/`lastRunStatus`. A
registry that's honest about freshness beats one with holes on a failed cycle.

## Deploy architecture

**One Vercel project = the `dashboard`.** The indexer and the standalone API are not deployed as
separate services. Everything runs from the single Next.js app:

- **API** → Next.js Route Handlers inside the dashboard (`app/api/v1/protocols`,
  `app/api/v1/protocol/[id]`). Same `Store` methods, same JSON as the original standalone API — a
  transport change, not a rewrite. CORS (`access-control-allow-origin: *`) is set on these two
  routes only, for future browser/wallet/third-party clients reading public, payment-blind data.
  `/api/v1/*` is the only public API surface — see "API versioning" below.
- **Indexer** → triggered by `POST /api/cron/run-indexer`, which calls `runIndexerCycle()` once.
  The route is secret-gated (`Authorization: Bearer <CRON_SECRET>`, compared with
  `crypto.timingSafeEqual`); if `CRON_SECRET` is unset it refuses to run, so it's never open. No
  CORS on this route.
- **Scheduling is external** — a [cron-job.org](https://cron-job.org) job POSTs to the cron route
  every 5 minutes with `Authorization: Bearer <CRON_SECRET>`. The route itself is stateless about
  cadence: it runs exactly one cycle per request, so the interval is entirely the caller's.

  **The schedule is not in version control.** It lives in the cron-job.org dashboard — there is no
  workflow file, no `vercel.json` `crons` entry, and no other scheduling config in this repo.
  Changing the cadence, pausing indexing, or rotating the target URL is done in that service's UI,
  not in a PR. If indexing has stopped, check there before looking for a bug in this repo.

  **Why not Vercel Cron:** the Hobby tier caps scheduled functions at **once per day**, which is far
  too slow for live scoring — 5-minute freshness is the product. Upgrading to Pro for cron alone
  isn't justified pre-funding, so an external scheduler hits the same secret-gated route instead.
  This is a deliberate choice, not an oversight: the route is a plain authenticated HTTP endpoint,
  so swapping cron-job.org for Vercel Cron (or anything else) later is a scheduler change only, with
  no code change.

**Build wiring:** the dashboard's `build` script compiles the workspace deps (`core` → `db` →
`adapters` → `indexer`) before `next build`, because those packages resolve via their `dist/`
output. `next.config.mjs` marks `pg` and `@stellar/stellar-sdk` as `serverExternalPackages` (kept
as runtime requires, not webpack-bundled) and pins `outputFileTracingRoot` to the repo root so
workspace-dep tracing is correct. On Vercel: Root Directory = `dashboard`, Build Command =
`pnpm run build`.

**Tests:** `pnpm test` at the root, fanning out to whichever packages define one, and **run by CI on
every PR**. There is **no test framework dependency** — tests are `*.test.ts` files run by Node's
built-in test runner (`node --test`) against native TypeScript stripping, which is why CI and
`.nvmrc` pin Node 24 (the floor is 22.18). Coverage is deliberately narrow: pure logic whose
important cases live data can't reach.

Three things follow from strip-only mode and are worth knowing before writing a test:

- A `.ts` test file must import with an explicit `.ts` extension.
- It **cannot value-import a TypeScript `enum`** from source — `RiskFactorType` included, since
  Node rejects `enum` as unstrippable syntax. Import the enum's _type_ and use its string values,
  or import it from a package's built `dist/` (plain JS, so the enum is fine there).
- **Type-only imports must be written `import type`.** Stripping is syntactic: it cannot tell that
  `Adapter` is an interface, so a combined `import { Adapter, freshnessWindow }` survives into the
  running module and fails to resolve against `@stenion/core`'s CommonJS output, which has no
  runtime `Adapter`. This bites any module a test imports, not just the test file itself.

The worked examples:

- **`core/src/scoring.test.ts`** — `scoreFactors`, the weighted mean every protocol's score passes
  through. Several assertions parse `METHODOLOGY.md` and the `RiskFactorType` enum as text rather
  than restating their numbers, so the rule that code and the methodology may not drift is enforced
  mechanically instead of by review attention.
- **`adapters/blend.test.ts` / `adapters/kinetic.test.ts`** — `computeRiskFactors` against
  synthetic raw state. `computeRiskFactors` is a pure function of already-decoded on-chain data, so
  every methodology rule is reachable without RPC. This is where methodology v2's `oracleSafety` is
  pinned: both live pools price fresh and bounded, so a live run exercises neither the disabled-bound
  path nor K2's inert-breaker path — the two the rulebook exists to catch.
- **`adapters/snapshot.test.ts`** — the same adapters against **frozen mainnet captures** in
  `adapters/fixtures/`. This asks a different question from the synthetic suites: not "does the code
  match the rulebook" but "did a refactor move a published number on real data". It is the only
  coverage that would notice a decode or fixed-point scaling regression, because the synthetic
  builders use convenient values (`b_rate` = 1.0, one decimals value, round balances) and real pools
  do not — dropping the `b_rate` multiplication entirely is an exact identity under a unit rate and
  passes all 71 synthetic tests, while failing here.
- **`db/src/store.test.ts`** — the row → response mapping (`toHistoryEntry`, `toProtocolDetail`,
  `toLeaderboardEntry`), extracted from the query methods so the public JSON contract can be tested
  without Postgres. Covers the `ok`/`failed` union and the staleness model — neither of which the
  live site exercises, since no run has ever failed.
- **`db/src/store.integration.test.ts`** — the SQL itself (the two LATERAL joins, `NULLS LAST`
  ranking, the shape CHECK). **Skipped unless `STENION_TEST_DATABASE_URL` is set**, so CI and
  contributor PRs never need database credentials. See CONTRIBUTING.md.
- **`dashboard/app/api/_http.test.ts`** — the response envelope: status, content type, and CORS.
  These fail only in a third party's browser, never on our own pages (which read the Store
  in-process), so nothing else would catch a regression.
- **`indexer/src/cycle.test.ts`** — the run loop's error model, against a deliberately throwing
  adapter and an in-memory `Store`. The contract is that an adapter throws, the indexer records a
  failed run and continues; as of 2026-08-16 `risk_scores` held 1,683 rows and **zero** failed ones,
  so nothing about this path is evidenced by it having run in production.
- **`dashboard/app/lib/score-series.test.ts`** — the score-history series builder. As of
  2026-08-14 `risk_scores` held 527 rows and not one failed run, so the failed-run path had to be
  proven against fixtures rather than by looking at the page.

**Environment variables** (all on the one Vercel project, Production + Preview): `DATABASE_URL`
(Neon pooled), `STENION_RPC_URL`, `STENION_HORIZON_URL`, `CRON_SECRET`. Locally, every package
reads these from a single repo-root `.env` via a walk-up loader.

### API versioning

The public API is versioned in the URL. The documented, canonical paths are:

| Endpoint                   | Returns                                             |
| -------------------------- | --------------------------------------------------- |
| `GET /api/v1/protocols`    | The leaderboard: every protocol + its latest score. |
| `GET /api/v1/protocol/:id` | One protocol's detail, factors, and run history.    |

**The policy:**

- **Additive changes stay on `v1`.** A new field in the response — a sixth `*Safety` factor, an
  extra piece of metadata — does not break a client that ignores fields it doesn't know about, so
  it ships on `v1`. Consumers should parse defensively and tolerate unknown fields.
- **Breaking changes get a `v2`.** Renaming a field, removing one, changing a type or the meaning
  of an existing value, or restructuring the envelope — anything that can break a client reading
  the documented shape — goes to a new version path, with `v1` left serving its existing contract
  until it's deliberately retired.

Note that a **methodology** change (a formula, threshold, or weight) is _not_ an API version
change: `safetyScore` is still a 0–100 number with the same meaning, so the scores move but the
contract doesn't. Methodology changes are versioned in [`METHODOLOGY.md`](METHODOLOGY.md), not in
the URL. A change to the _taxonomy_ — a renamed or removed factor — is breaking, and would need a
`v2`.

**No unversioned paths.** The pre-versioning paths `/api/protocols` and `/api/protocol/:id` are
gone — they 404. They existed briefly as transitional aliases during the `/v1` move and were
removed once a repo-wide sweep confirmed nothing referenced them. Every public API path carries a
version segment; there is no unversioned surface to fall back to.

**The cron trigger is not versioned.** `POST /api/cron/run-indexer` is internal plumbing, not a
public contract — it's secret-gated, has no CORS, and its only caller is our own cron-job.org
schedule. Versioning it would imply a compatibility promise we don't make. It stays at
`/api/cron/*`, and a `/api/v1/cron/*` path deliberately does not exist.

### Why `@stenion/api` exists but isn't deployed

`@stenion/api` was the original public API — a bare `node:http` server built before the deploy
architecture consolidated onto one Vercel project. Bare `node:http` doesn't fit Vercel's serverless
model, and running the API as a separate service from the dashboard is more moving parts for a solo,
pre-funding project to operate. So the two endpoints were re-homed as Next.js Route Handlers in the
dashboard (same `Store` methods, identical JSON contract).

The package is kept in the tree — as the reference for the original bare-Node implementation and in
case a standalone API service is ever wanted again — but it is **legacy and not deployed**. The
live API is the dashboard's routes.
