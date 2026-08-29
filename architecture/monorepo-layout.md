## Monorepo layout

Stenion is a [pnpm workspaces](https://pnpm.io/workspaces) monorepo. Each directory is an internal
package; the adapters import `@stenion/core`'s `Adapter` interface as a real typed dependency.

```
/core        — @stenion/core        Adapter interface + RiskFactorType taxonomy + shared types
/adapters    — @stenion/adapters    one folder per protocol (blend/, kinetic/, aquarius/), each an Adapter
/db          — @stenion/db          Postgres layer: pg pool, typed Store, raw-SQL migrations
/indexer     — @stenion/indexer     scheduler that runs adapters on an interval, writes to Postgres
/api         — @stenion/api         standalone REST server (legacy — see "Why @stenion/api exists")
/dashboard   — @stenion/dashboard   Next.js site + the deployed API routes + the cron-trigger route
```

TypeScript is configured in four layers (see [`CLAUDE.md`](../CLAUDE.md) for the rationale):

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

  **One package needs more: `indexer`.** Everywhere else a tested module is a _leaf_ with no
  relative imports of its own, so the question never arises. `indexer/src/cycle.ts` is the first
  module that is both imported by a test and importing siblings (`./retry`, `./alerts`). Node's
  type-stripping ESM loader resolves a test's import graph literally, so the source must say
  `./retry.ts`; the emitted CommonJS must say `./retry.js`. `indexer/tsconfig.build.json` therefore
  adds `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (TS 5.7+), which rewrites
  the extension on emit and lets one source satisfy both. Without it the choice is a test that
  cannot load the module or a build that cannot emit it. Scoped to that package on purpose —
  leaf-only tested modules remain the simpler default.

- `dashboard` has its own Next.js-generated config (bundler resolution) — it does **not** extend
  the Node config. It needs no split: it's already `noEmit` and sets the flag directly.

### What each package does

**`@stenion/core`** — the contract everything else agrees on. Defines the
`Adapter<TRawData, TCategory, TFactors>` interface (`fetchRawData` → `computeRiskFactors` →
`score`), the `RiskFactorType` enum (**lending's** fixed five-factor `*Safety` taxonomy), the
per-category factor and weight declarations in `core/src/weights.ts`, and the shared result types.
Adding a factor to a category is a breaking change felt by every adapter in it, so it's deliberately
small and stable. Carries `ADAPTER_INTERFACE_VERSION` as a seam for future breaking changes.

All three of `Adapter`'s parameters after the first are **defaulted**, which is what lets the
indexer keep one heterogeneous `Adapter<unknown>[]` run loop across categories. `TCategory` scopes
`operationalState`'s operation vocabulary and `metadata.category` to one rulebook; `TFactors` names
the factor map that rulebook scores, defaulting to lending's `RiskFactorMap` so both lending
adapters spell only two parameters. `TFactors` was added with the first `dex` adapter, closing a
widening that stopped one file short — `scoreFactors` and `ScoreResult` had already been made
generic over `FactorMap` so the weighted mean could never acquire a per-category variant, while
`Adapter` still required lending's five keys and so made a non-lending adapter unimplementable.

It also owns the pieces of the rulebook that must not differ between adapters, in
`core/src/scoring.ts`: `scoreFactors()` (the weighted mean — an adapter's `score()` delegates to it
and must never reimplement it, or two protocols end up on two rulebooks) and `freshnessWindow()`
with `STALE_CEILING_SECONDS`. Per-protocol _input reading_ stays in the adapters; nothing in this
file reaches for chain data.

`scoreFactors()` is generic over the factor map it is handed rather than typed to lending's five
keys. The weighted mean reads a `value` and a `weight` and nothing else, so it is genuinely
category-agnostic; typing it to one category's key set would have left the next category with a
copy of it to keep in sync. There is deliberately no per-category variant of the function.

**`core/src/weights.ts`** holds `CATEGORY_FACTORS` — which factors each `ProtocolCategory` scores,
what each is weighted, and its label — keyed the same way `METHODOLOGY_VERSIONS` and
`CATEGORY_OPERATIONS` are. Weights used to be `const weight = 0.25` literals inside each adapter's
factor methods, ten of them across the two lending adapters; a drift between two copies would have
produced two plausible scores from two different weightings and failed nothing. Both adapters now
read `LENDING_FACTORS`, `core/src/scoring.test.ts` pins that declaration against
`methodology/lending.md`'s
published weight table, and both adapter suites pin themselves against the declaration — so the
chain runs adapter → core → the public rulebook with no hand-written copy in it.

**`@stenion/adapters`** — one folder per protocol (`blend/`, `kinetic/`, `aquarius/`), each holding
an `index.ts` that exports the `Adapter` class and is the folder's whole public surface, plus the
`fetch.ts` / `score.ts` / `types.ts` it is assembled from. An adapter
reads a protocol's on-chain state (Soroban RPC + Horizon), reduces it into its category's `*Safety`
factors using the formulas in that category's `methodology/` file, and produces a weighted
`safetyScore`. Adapters throw on failure; they never swallow errors.

**`AquariusAdapter` is the first non-lending adapter, and the shape it takes is what a second
category costs.** It implements `Adapter<AquariusRawData, 'dex', DexFactorMap>` — three parameters
where the lending two take two — scores the `dex` rulebook's two factors (`adminKeySafety`,
`assetControlSafety`, `methodology/dex.md`) and classifies `operationalState` on the shared ladder's
`swapDisabled` rung. It is otherwise an ordinary four-file adapter: nothing about the pipeline,
the run loop or the storage schema needed a `dex` special case.

**No pool is registered to any target list**, so nothing in the indexer reaches it yet — which
markets to register depends on a size census, and one more target makes the cycle infeasible at
`STENION_CYCLE_CONCURRENCY=1` (see `deploy-architecture.md`). It is exported so the fixture-capture
script and the snapshot tests can reach it.

### Decision record: `Adapter` gained a `TFactors` parameter (#103) — **not yet reviewed**

**Status: unreviewed.** This was resolved inside #103 because nothing in that issue compiled without
it, not because it was argued on its merits and signed off. It is recorded here so #104 inherits a
decision it can see and reopen, rather than a fait accompli. **Anyone picking up #104 should read
this section before building on it.** If it is wrong, the cost of reversing it is one interface
signature and two adapter declarations — it has no stored data, no API surface and no migration
behind it, which is the main reason it was judged safe to resolve in place.

**What changed.** `core/src/adapter.ts`:

```ts
export interface Adapter<
  TRawData = unknown,
  TCategory extends ProtocolCategory = ProtocolCategory,
  TFactors extends FactorMap = RiskFactorMap, // ← added
> {
  computeRiskFactors(rawData: TRawData): Promise<TFactors>; // was Promise<RiskFactorMap>
  score(factors: TFactors): ScoreResult<TFactors>; // was (RiskFactorMap) => RiskScoreResult
  // …
}
```

**Why it was unavoidable in #103.** `RiskFactorMap` is **lending's** map — `Record<RiskFactorType,
RiskFactor | null>`, its five keys required — and `types.ts` says so explicitly. `dex` scores
`adminKeySafety` and `assetControlSafety`. So `AquariusAdapter` could not implement `Adapter` at all:
not a stylistic problem, a hard compile failure with no local workaround that is not a lie (returning
four `null`s plus an excess key, or casting through `unknown`).

This is the gap #77 left. That issue widened `scoreFactors` to `<M extends FactorMap>` and
parameterized `ScoreResult<M>` precisely so the weighted mean could never acquire a per-category
variant — and stopped one file short of the interface those two members are declared on. #103's own
issue text anticipated it: "If it turns out to need more, that is a finding worth stopping on,
because it means the generalisation those issues shipped was incomplete." **It did, and it was.**

**What was NOT done, deliberately.** No new `OperationalLevel` rung (`swapDisabled` already existed
from #100). No widening of `toOperationalState`. No new shared scoring helper. No change to
`RiskFactorType`, which stays lending's five and stays the vocabulary every stored
`risk_scores.factors` row was written against. `ADAPTER_INTERFACE_VERSION` stays at **3** — the
parameter is defaulted, so no implementor must react, which is the bar that constant states.

**Alternatives considered, and why they lost:**

| Option                                                      | Why not                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spell both members against the open `FactorMap` instead     | Loses precision at every call site: `adapter.score(f)` would return `ScoreResult<FactorMap>`, which is not assignable to the `RiskFactorMap` the indexer's `RunResult` and `@stenion/db` both require. That ripples straight into the indexer and the store — a much larger change than the one it avoids.                                                  |
| Derive the map from the category, `FactorMapFor<TCategory>` | Distributes over the category union. The default `TCategory = ProtocolCategory` would resolve to a map requiring **every** category's keys at once, breaking the bare `Adapter<unknown>` the indexer's `toTarget<T>()` run loop depends on — the same hazard `OperationFor`'s comment in `operational-state.ts` records being written carefully to survive. |
| Stop, ship nothing, open a separate issue first             | The honest reading of #103's non-goals, and the one not taken. Everything else in the issue depends on this line, so stopping would have delivered no adapter at all. Recorded here instead so the review still happens, just after the code rather than before it.                                                                                         |

**The open question a reviewer should actually answer**, because this section does not:
`RiskFactorType` is now doing two jobs — it is lending's factor vocabulary _and_ the shape
`RiskFactorMap`/`RunRecord`/`ProtocolDetail` are all spelled against. A second category makes those
two jobs pull apart. `TFactors` papers over that at the adapter boundary only. Whether the right
end state is per-category factor-map types everywhere, or one open `FactorMap` from the adapter all
the way through storage, is not decided and is not decided here.

#### `@stenion/db` has never carried a non-lending factor map

Stated plainly because it is the first thing #104 will hit. **The storage round-trips; the types do
not.**

- **Runtime: fine, and key-agnostic.** `recordRun` passes `JSON.stringify(record.factors)` into a
  `$4::jsonb` column (migration 0001), and jsonb comes back parsed. Nothing in the write or read path
  inspects a key, so a two-key `dex` map stores and returns byte-for-byte.
- **Types: rejected today, and that is the desirable failure.** `RunRecord.factors`,
  `ProtocolDetail.factors` and `HistoryEntry.factors` are all declared `RiskFactorMap`, and
  `getProtocolDetail` casts `row.factors as RiskFactorMap`. Passing a `DexFactorMap` to `recordRun`
  is a compile error — verified, not assumed:

  ```
  error TS2739: Type 'DexFactorMap' is missing the following properties from type
  'RiskFactorMap': collateralSafety, oracleSafety, liquiditySafety, utilizationSafety
  ```

  So #104 stops at the compiler rather than writing a row whose declared type is a lie. That cast in
  particular is the sharp one: it would type a `dex` row as lending's five keys, and any consumer
  reading `.oracleSafety` off it would get `undefined` with no error anywhere.

- **Test coverage: lending only.** `store.test.ts`'s `FACTORS` fixture is a single-key object cast
  `as unknown as RiskFactorMap`, so it proves the mapping is pass-through but asserts nothing about
  key sets. `store.integration.test.ts` is skipped unless `STENION_TEST_DATABASE_URL` is set, which
  CI never sets — **no `dex` factor map has ever been written to a real Postgres.**

**#104 must therefore decide, not discover:** whether `RunRecord`/`ProtocolDetail`/`HistoryEntry`
widen to `FactorMap`, and what `getProtocolDetail`'s cast becomes. That is a change to the published
API contract's `factors` shape, so it belongs to that issue's review and not to this one.

**One adapter can serve several markets.** `BlendAdapter` takes a `BlendPool` — slug, display name,
pool contract, mark, links, deployment label — and the module exports `BLEND_POOLS`, the list the
indexer iterates. Every Blend market runs the same pool wasm (all three registered pools report
code hash `a41fc53d…`, and the V2 pool factory's `is_pool` returns true for each), so a further
market is a config entry and no new scoring code. Nothing on `BlendPool` is a threshold, a weight or a formula —
a per-pool rulebook would break `methodology/` ground rule 1 — and the identity fields all come
from the pool the instance was given, so an adapter cannot publish one pool's `contractId` beside
another pool's numbers. **Targeting, not aggregation:** each pool is its own ranked entry, and the
three live Blend pools span 30 points (54, 50 and 24) on identical contract code.

**A row in `protocols` is therefore not always a protocol.** Four targets, two protocols: Blend's
Fixed pool, Kinetic, and the YieldBlox and Etherfuse pools on Blend V2. That distinction is carried in the data,
not left to the reader — see `deployment_host` / `deployment_label` below.

**`@stenion/db`** — the single, typed storage layer, shared by both the indexer (writes) and the
dashboard/API (reads) so there's no duplicated connection logic. Exposes a lazy singleton `pg`
`Pool` (`getPool`/`closePool`), a `createStore(pool)` factory with all read/write methods, env
loading, and the persisted `RunRecord` type. Three tables — two that hold the product, and one that
holds no product data at all:

- `protocols` — one row per **scored market** (slug PK, name, chain, `category`, adapter class name) plus its
  identity: `logo` (a root-relative path into the dashboard's own `public/` tree — we host every
  mark, never hotlink), `contract_id` (the raw Soroban address the score is derived from, so a
  reader can check it in an explorer; the explorer itself is chosen in
  `dashboard/app/lib/explorer.ts`, not per adapter), `site_url` / `docs_url`, and the deployment
  pair `deployment_host` / `deployment_label` (migration 0006). All are nullable, because
  "publishes no mark", "publishes no docs" and "runs on its own contracts" are real answers the UI
  renders deliberately rather than papering over with a placeholder. Upserted at indexer startup
  from adapter metadata — and **overwritten every cycle**, so these are maintainer-managed; a future
  protocol self-service flow needs separate precedence-taking columns, not edits to these.

  The deployment pair is written and read together and published as one `deployedOn` object
  (`{ host, label }`, or `null`), on **both** the leaderboard and the detail response — the only
  identity field besides `logo` that the board carries, because it is what a row _is_ rather than
  verification detail a reader looks up afterwards. `deployment_host` is a display name, not a
  `protocols.id`, and there is deliberately no foreign key: Stenion's `blend` row is itself one
  Blend market, so a reference to it would claim the pool runs on that _entry_ rather than on the
  host protocol's contract. A half-populated pair maps to `null` rather than to a partial object.

  `category` (migration 0008) is which rulebook scores the market — currently `lending` for every
  row, and `NOT NULL` unlike the identity columns above it, because "we do not know how to score
  this" is not a publishable state the way "publishes no mark" is. It is written from
  `ProtocolMetadata.category`, required on every adapter as of `ADAPTER_INTERFACE_VERSION` 3, and
  overwritten each cycle like the rest of the identity block. It rides both API responses, because
  it is a **comparability claim** rather than a label: two `safetyScore`s mean the same thing only
  when their categories match, so anything that ranks protocols has to scope the ranking to one.

- `risk_scores` — append-only history. `safety_score` is promoted to its own `numeric` column
  (it's what the registry ranks on); the five factors live in one `jsonb` column (displayed, not
  ranked, and growing the taxonomy then needs no migration). `methodology_version` and `category`
  together record which rulebook produced the score — see below. A DB-level CHECK enforces the
  `ok`/`failed` discriminated union, and `risk_scores_category_shape` puts the new column on the
  same union.

  `category` is stamped here **as well as** on `protocols`, which looks redundant and is not.
  `protocols.category` is current identity, overwritten every cycle; this is a stamp frozen with the
  run. Since every category's version counter starts at 1, the integer alone stops identifying a
  rulebook once a second category exists — `(category, methodology_version)` is the identifier.
  Resolving the category by joining to `protocols` would answer with what the market is _now_, so a
  recategorized entry would silently reinterpret its whole history under a rulebook that never
  produced it. Same reasoning as `operational_state` below: a per-run fact belongs on the run.
  Written from the first cycle under this schema, and **not yet read by any query** — the read
  arrives with the first category that makes a version ambiguous, but the stamp has to start
  immediately or the history it disambiguates has a hole in it.

  `operational_state` (migration 0007) is one more `jsonb` column, stamped per run like the factors
  and for the same reason: it is a live reading, not identity, and it is only meaningful next to the
  run whose inputs it was read alongside. It records which user operations a market's own contracts
  were refusing — and it is **published beside the score, never folded into it**
  ([`methodology/publishing-rules.md`](../methodology/publishing-rules.md#operational-state-is-published-never-scored)). It rides both the
  leaderboard and the detail response, on the same reasoning as `deployedOn`. Nullable, and not part
  of the CHECK: a `failed` run read nothing, and a row written before the column existed has none.
  Null means "not read", never "unrestricted".

  > **Deploy order for 0007 is the reverse of 0002/0003/0006's hazard, and it matters.** Those
  > migrations had to stay writable by the already-deployed indexer. This one is read by the new
  > `Store` queries, which name `operational_state` in both `SELECT`s — so **the migration must run
  > before the code that reads it is promoted**, or the leaderboard and detail routes 500 on a
  > missing column. The old indexer keeps writing happily against the migrated schema in the
  > meantime (it just leaves the column null), so migrate-then-deploy is safe in both directions;
  > deploy-then-migrate is not.

- `api_rate_limits` — one token bucket per public-API client, and the odd one out: it is
  infrastructure, not data. It exists in Postgres only because serverless has no shared memory, so
  there is nowhere else every instance can see (`createRateLimiter`, deliberately not part of
  `Store` — the domain layer has no business knowing about it). The key is a salted hash of the
  client IP, never the address, so the table cannot become a log of who reads the API; rows idle for
  an hour are pruned. Nothing here is read by any scoring or serving path. See "Caching and rate
  limits".

**Methodology versioning.** Versions are **per category**, with independent counters that each
start at 1 (`METHODOLOGY_VERSIONS` in `@stenion/core`, keyed by `ProtocolCategory`). Lending's
rulebook is at **v1**, and versioning starts there: every stored row carries
`methodology_version = 1` under `category = 'lending'`, and no second version and no second
category exists yet. Development-era history under earlier iterations of the rules was discarded
rather than migrated — the reasoning, and what does and doesn't warrant a bump, are in
[`methodology/index.md`](../methodology/index.md#current-version). Mechanically: a scoring change that makes old
scores non-comparable bumps that category's entry in `METHODOLOGY_VERSIONS`; the indexer stamps it
onto every run, resolved from `target.metadata.category` rather than from a single global constant,
so registering an adapter in a new category needs no change in the indexer at all. Splitting the
former scalar `METHODOLOGY_VERSION` into that map bumped nothing: no formula, threshold or weight
moved, so lending's history stays comparable straight across the change. History is
**never backfilled** — `risk_scores` keeps only outputs (score + factor map), never the raw
on-chain inputs, so an old row genuinely cannot be recomputed under new rules. The version is
surfaced on the protocol detail and on each history point so the dashboard marks the break
rather than rendering an unexplained step change. Migrations that add such a column must stay
writable by the _currently deployed_ indexer: `main` keeps running the old code until it's
promoted, and both share one Neon database. That is why 0002 shipped the column with a
`DEFAULT 1` and enforced only the `ok` half of its CHECK; 0004 drops the default and tightens the
CHECK to the full union, now that the deployed indexer names the column explicitly on both arms.
The column is therefore required rather than defaulted: a future writer that bumps
a category's `METHODOLOGY_VERSIONS` entry and forgets it fails loudly instead of being silently
stamped with the old
version — a mis-stamp that could never be repaired, since the raw inputs are not stored.

`Store` also exposes `listRecentRuns(protocolId, limit)` — status/error/`runAt` for the newest N
runs of one protocol, newest first. It exists for the indexer's consecutive-failure alerting, which
derives a streak from this history rather than persisting a counter (see the indexer section). It is
deliberately narrower than `HistoryEntry`: the streak logic needs only whether a run failed, what it
said, and when — never a score or a factor map.

Migrations are raw `.sql` files plus a ~40-line runner (`db/src/migrate.ts`) — no ORM. Alerting
added **no** migration and no new table: that was the point of deriving the streak.

**`@stenion/indexer`** — the scheduler. On an interval it runs every adapter through a small
`toTarget<T>()` wrapper (which hides each adapter's `TRawData` so a heterogeneous adapter list can
share one typed run loop), wraps each run in try/catch, and writes the outcome — score + factors,
or a failed marker — to Postgres. It exports `runIndexerCycle()` (one cycle, used by the cron route)
and guards its standalone loop behind `require.main === module` so importing it doesn't start the
loop.

The package is four modules, split along lines worth preserving. `src/cycle.ts` holds the run loop
(`runCycle`, `toTarget`) and is a pure function of its arguments — it takes the targets, the `Store`
to write to, and its retry/alerting behaviour as an argument, reaching for no env, no pool, and no
config. `src/retry.ts` and `src/alerts.ts` are pure leaf modules (below). `src/index.ts` is the
process entry point: env loading, pool construction, the interval, and the `require.main` guard —
and it is the only place config and the run loop meet. The split exists because the error model is
the part most worth testing and least exercised in production, and the entry point cannot be
imported from a test at all — its `require.main` guard and extensionless relative imports are both
CommonJS-only, which Node's ESM type-stripping loader rejects. Keep new run-loop logic in
`cycle.ts`.

**Retry and failure alerting.** The indexer used to be deliberately dumb — one interval, no retries,
no alerting — so a transient RPC blip recorded a failed run silently and nobody found out until they
looked. It now retries and notifies. This makes failures **louder and rarer; it does not change what
a failure is**. Adapters still throw, the indexer still catches, and a run that ultimately fails is
still recorded as `failed` — a protocol that is genuinely down still shows as down.

- **Bounded retry against a wall-clock deadline, not a fixed schedule.** `src/retry.ts`'s
  `withRetry` takes an absolute deadline and never runs past it: each attempt is capped at whatever
  time is actually left, and a retry starts only if the remaining budget covers the backoff plus an
  attempt worth making. The attempt count and delays are the ceiling; the deadline is the guarantee.
  This is deliberate — a fixed schedule only stays inside 60s if you know how long an attempt takes,
  and nothing does: every RPC call in both adapters is a bare `await` with no `AbortSignal`, and
  Node's `fetch` has no default timeout.
- **The 60s ceiling is the binding constraint.** `maxDuration` is capped at 60 on Vercel's Hobby
  tier and cannot be raised, and a cycle killed mid-flight is worse than one that fails cleanly — it
  can leave one protocol scored and the other neither scored nor recorded as failed. The run loop's
  budget is `STENION_CYCLE_BUDGET_MS`, default 42s, leaving room for cold start, pool connect,
  upserts, streak queries and a 3s-capped alert POST inside 60s.

- **Targets run through a bounded worker pool, and the budget is no longer divided between them.**
  `STENION_CYCLE_CONCURRENCY` (default **2**) targets are in flight at once, pulled from a shared
  cursor rather than run in fixed batches. Each one's deadline is the end of the budget **minus one
  full attempt reserved for every wave still queued behind it** (`targetDeadline` in
  `indexer/src/cycle.ts`).

  **Why the division rule was removed.** It used to be `now + remaining / targetsLeft`, which made
  every target's deadline a function of how many targets existed: 21s each at two, 14s at three
  (already below the 15s attempt timeout), and 10.5s at four — **below the healthy fetch duration of
  two protocols that already work**. Registering a pool could therefore fail protocols that were
  fine the day before. That is not "adding a pool makes things slower", it is a bug, and no
  allocation scheme fixes it: at concurrency 1 the registry cannot give three targets one full
  attempt each inside 42s, whatever the rule.

  **What the new rule guarantees.** Every target gets **at least one full 15s attempt** at any
  feasible target count — against a slowest healthy fetch of 6.1s measured on the deployed function
  (12.5s was the worst ever seen on a developer machine, and even that fits) — and usually far more,
  because `queuedAfter` is read when a worker picks a target up, so a target that finished early has
  already shortened the queue and the next one inherits the slack. A target still cannot
  eat the queue's last chance to be looked at, which is the guarantee the old even division was
  really buying.

  **The ceiling, as arithmetic rather than folklore:**

  ```
  ceil(targetCount / STENION_CYCLE_CONCURRENCY) * STENION_ATTEMPT_TIMEOUT_MS <= STENION_CYCLE_BUDGET_MS
  ```

  At the shipped defaults that holds to **four targets** and fails at five. `cycleFeasibility()`
  checks it every cycle and at indexer startup, and logs a `[budget]` warning naming the numbers and
  the levers (raise concurrency, lower the attempt timeout, or shard). It **warns and runs** rather
  than refusing — taking the whole registry down because someone registered a fifth pool is worse
  than running five protocols imperfectly and saying so. Past the ceiling it degrades to whole
  attempts on a first-come basis with the tail failing cleanly (`DeadlineExceededError`) and going
  visibly stale on `/api/v1/health`, rather than squeezing every target into a length at which none
  of them can succeed.

- **Concurrency is bounded because the peak is what costs.** Both adapters are strictly sequential
  internally — every RPC and Horizon call is a bare `await` — so **one target in flight is exactly
  one request in flight**, and `STENION_CYCLE_CONCURRENCY` _is_ the peak simultaneous load Stenion
  puts on the shared, rate-limited public RPC. A `Promise.allSettled` over every target would make
  that peak grow with every pool registered, which is the wrong dial to leave unbounded. Total
  request volume per cycle is unchanged whatever the concurrency — roughly 13 (Blend Fixed, 3
  reserves), 23 (YieldBlox, 8) and 22 (Kinetic, 4).

  **It ships at 1, not 2.** What concurrency changes is the request **rate**, and the estimate made
  here before deploying — "~2.3/s to ~4.5/s" — was **wrong**, because it divided the request count
  by developer-machine durations. See the incident note below: 2 was deployed, measured, and
  reverted the same day.

- **RESOLVED (2026-08-25): concurrency 2 drew `429`s from the public RPC.** Kept in full rather
  than deleted, because it is the reason this document now says _measure the deployed function_
  everywhere it used to say _compute from timings_ — and because anyone raising
  `STENION_CYCLE_CONCURRENCY` should have to read it first.

  `STENION_RPC_URL` is `mainnet.sorobanrpc.com`: the free, shared, keyless public endpoint, whose
  rate limit is unpublished and not ours to raise.

  **What happened.** #68 shipped the worker pool at concurrency 2. Within one cycle, Blend — the
  target that runs _behind_ the concurrent pair — began failing with
  `Request failed with status code 429`, recorded only after all three retry attempts were
  exhausted. Measured from `risk_scores` via `/api/v1/protocol/:id`:

  | Window                                              | blend | yieldblox | kinetic | total          |
  | --------------------------------------------------- | ----- | --------- | ------- | -------------- |
  | 34 cycles before the deploy (sequential)            | 0/34  | 0/34      | 0/34    | **0/102**      |
  | 8 cycles after, with manual `curl`s adding load     | 4/8   | 1/8       | 1/8     | 6/24 (25%)     |
  | 8 cycles after, scheduled only — no manual triggers | 4/8   | 0/8       | 0/8     | **4/24 (17%)** |

  The clean window is the load-bearing one: no manual triggers, ordinary 5-minute cadence, and Blend
  still failed **half** its cycles against a baseline of zero. (One cycle 429'd all three targets at
  once, but that was in the contaminated window, so it is reported and not leaned on.)

  **Root cause: rate, not peak.** Peak in-flight only went 1 → 2, which is nothing in absolute
  terms. But the deployed function is 2-3x faster than the developer machine the original estimate
  was computed from, so the same requests are compressed into a third of the time: wave 1 issues
  roughly 45 requests (YieldBlox ~23, Kinetic ~22) inside ~4 seconds — about **11 requests/second** —
  and Blend's ~13 land immediately behind them. The target that fails is the one running behind the
  burst. **The pre-deploy estimate was wrong in the same direction as the failures**, which is the
  whole lesson: a public endpoint limits rate, and rate is exactly what a duration estimate gets
  wrong when the durations come from the wrong machine.

  **The fix, applied.** Both halves together, not either alone:

  - `STENION_CYCLE_CONCURRENCY` default **2 → 1**. Removes the burst entirely. It does **not**
    reinstate the bug #68 fixed: budget division is gone independently of concurrency, so at 1 each
    target still gets the budget less a reservation rather than a shrinking even share.
  - `STENION_ATTEMPT_TIMEOUT_MS` default **15s → 10s**. Needed _because_ of the first: at 1 worker a
    15s timeout makes `cycleFeasibility` infeasible at three targets (`3 × 15s = 45s > 42s`) and
    warn on every cycle. 10s is justified by the measurement rather than guessed — nothing healthy
    exceeds 6.1s deployed — and makes a sequential cycle feasible to **four** targets
    (`4 × 10s = 40s ≤ 42s`), so #65's Etherfuse needed no further config change.

  Verified against the real defaults: 3 targets `30,000ms` silent, 4 targets `40,000ms` silent,
  5 targets `50,000ms` warns. Alerting is asserted byte-identical at concurrency 1 and 2.

  **Now standing at four.** #65 registered Etherfuse, so `cycleFeasibility` was re-run against the
  loaded config and the real registry rather than against the arithmetic above: 4 targets,
  concurrency 1, `attemptTimeoutMs` 10,000, `budgetMs` 42,000 → `requiredMs` 40,000, feasible, no
  warning. **The next registration is the one that trips it** — a fifth target needs 50,000ms and
  warns every cycle, so it arrives with a budget or concurrency decision attached, measured against
  the deployed function rather than argued from arithmetic.

  **Local-dev caveat:** a developer machine has been seen taking 12.5s on YieldBlox, which now
  exceeds the 10s cap, so a local `pnpm indexer` may time out and retry where it used to succeed
  first time. Raise `STENION_ATTEMPT_TIMEOUT_MS` in `.env` if that bites — production is the case
  the default is sized for.

- **Targets are ordered slowest-first** (`orderByLatency` in `indexer/src/index.ts`:
  YieldBlox → Kinetic → Blend). Under a worker pool, longest-processing-time-first minimises the
  makespan: a slow target started last is a slow target nothing can overlap with. This is the
  opposite of the old fastest-first order, which was correct only because the old division rule gave
  the first target the tightest share and later ones the inherited slack. **A target not in the list
  sorts first**, i.e. an unmeasured pool is assumed to be the slowest and gets the most generous
  slot — so `BLEND_POOLS` stays the single list to edit when adding a market.

- **Per-target `durationMs` and whole-cycle `totalMs` ride on the cycle summary**, which the cron
  route spreads into its JSON response. That is deliberate: the budget arithmetic above can only be
  validated on Vercel's path to the RPC, and a developer machine's path is not that. `curl`ing the
  cron route returns the real measurements.

  **Measured from the deployed function** on 2026-08-25, five cycles at the shipped defaults
  (3 targets, concurrency 2), read from the cron route's own response:

  | Target      | Wave | `durationMs` range | Median     |
  | ----------- | ---- | ------------------ | ---------- |
  | Kinetic     | 1    | 4,788–6,100        | 5,001      |
  | YieldBlox   | 1    | 3,792–4,314        | 3,956      |
  | Blend Fixed | 2    | 2,271–2,628        | 2,408      |
  | **Cycle**   | —    | **6,461–7,322**    | **~6,850** |

  (Cycle range over the four clean cycles; a fifth spent 9,504ms because one target exhausted three
  attempts before failing. Ranges are `durationMs`/`totalMs` as returned by
  `POST /api/cron/run-indexer` — retries and backoff included, DB write excluded.)

  **These are two to three times faster than the developer-machine figures they replace** (which
  were Blend 6.0–7.5s, Kinetic 7.7–10.5s, YieldBlox 8.1–12.5s, 24.5–26.9s sequential, measured
  2026-08-19). Vercel's path to the RPC is simply not a laptop's, which is why the issue insisted on
  measuring from the deployed function rather than trusting arithmetic over local timings. Two
  consequences worth stating: the whole cycle uses under a fifth of its 42s budget, and the 15s
  attempt timeout is now roughly 2.5x the slowest healthy fetch rather than barely above it.

  **The 3-target case is measured. The 4-target case still is not.** The fourth target now exists —
  #65 registered Etherfuse — but nothing above is evidence about it: the numbers here were captured
  at three targets, and, see the rate-limit note below, the cost of a cycle is not only its duration.
  The feasibility ceiling of four targets is a statement about the attempt timeout fitting in the
  budget, not a measured result, and must not be described as proven until a deployed cycle has run
  it.

  **One thing to watch on the first deployed cycles.** Etherfuse's `fetchRawData` was observed
  locally at 8.0s and 12.2s in two consecutive runs against the shared public RPC — the second past
  the 10s attempt timeout. Local timings are exactly what the #68 incident says never to reason from,
  so this is written down as the thing to check in the cron route's per-target `durationMs`, not as a
  claim about production or as grounds to move a knob.

- **The attempt timeout is soft.** It races the attempt against a timer, abandoning the in-flight
  work rather than cancelling it. That bounds the observed attempt duration, which is what the
  budget needs, and is harmless under serverless where the socket dies with the invocation. True
  cancellation needs an `AbortSignal` threaded through `Adapter.fetchRawData` — a breaking interface
  change, tracked in [`ROADMAP.md`](../ROADMAP.md).
- **Transient and permanent failures are deliberately not distinguished.** Every adapter failure is
  a bare `new Error(string)` with no typed error and no preserved status code, so the only available
  classifier is regex over message text — which drifts silently when a message is reworded, and
  drifts toward retrying nothing. It also buys little: the structural failures (a missing storage
  key, a malformed decode) throw fast, while the slow failures are exactly the transient ones, so
  classification would save budget precisely where budget is not at risk. The wall-clock deadline
  protects the case that matters. A typed `PermanentAdapterError` in `core` is the clean path if
  this is ever wanted; it is in `ROADMAP.md`, not guessed at here.
- **Alerting fires after N consecutive failures** (`STENION_ALERT_THRESHOLD`, default 4 ≈ 20 minutes
  at the 5-minute cadence), POSTed to `STENION_ALERT_WEBHOOK_URL` as a plain `fetch` — no
  dependency, and unset means alerting is simply off. Both arms are edge-triggered: `failing` fires
  at **exactly** N so a six-hour outage is one message rather than seventy-two, and a `recovered`
  message follows when the protocol scores again. The recovery half is what makes silence after an
  alert unambiguous; resolving that ambiguity by re-alerting every cycle would need dedup state this
  deliberately doesn't have. An alert names the protocol, the streak length, how long it has been
  going, the latest error verbatim, and every distinct message in the streak — four identical errors
  and four different ones usually mean "the protocol changed" versus "the RPC provider is flaky".
- **The rendered message is capped at 2,000 characters** (`MAX_MESSAGE_CHARS`). Discord _rejects_ a
  longer `content` with a 400 rather than truncating it, and the case that reaches the limit is the
  worst one available: an RPC-wide outage takes out every target, they all cross the threshold on
  the same cycle, and their alerts batch into one POST. The render is one block per alert, so the
  body scales linearly with target count — two protocols with four distinct Soroban `HostError`
  messages each measured ~2,500 characters, and three of the same is ~3,700. Without the cap, the
  alert for the biggest possible outage is the one that silently never arrives. The structured
  `alerts` array is never truncated, so nothing is lost for a machine consumer.

  **The third target moved where truncation starts.** Measured with a moderate ~150-character error
  message, the same four-distinct-errors scenario renders 1,958 characters across two targets — it
  fit — and 2,944 across three. Outages that used to arrive whole now arrive marked truncated. The
  cap is doing its job either way; what changed is how often a reader sees the marker.

- **Verifying delivery without waiting for a real outage:** `pnpm smoke:alert-webhook` drives the
  real path — a seeded failure streak through `runCycle`, `decideAlert`, `formatAlert` and the real
  `webhookNotifier` — at a live webhook URL, reporting the HTTP status and body that
  `webhookNotifier` itself discards. It uses an in-memory store (Postgres is untouched) and an
  obviously fake protocol id, so a message landing in a shared channel cannot be mistaken for a real
  outage. `--dry-run` prints the payload without sending; `--mode failing|recovered` picks one arm.
  Confirmed against a live Discord webhook on 2026-08-19: both arms accepted, HTTP 204.

**Where the streak lives: derived, not counted.** The indexer is invoked per-cycle by an external
scheduler, so there is no long-running process to hold a counter. The streak is read back out of
`risk_scores` each cycle (`Store.listRecentRuns`, a bounded walk of the
`(protocol_id, run_at DESC)` index the leaderboard's LATERAL joins already use). A persisted counter
would be a second source of truth that can disagree with the history it describes — `insertRunRecord`
failure is caught and logged rather than fatal, so a counter could increment beside a row that never
landed, and the alert would claim a streak the database cannot show you. Derivation cannot
desynchronize, because it _is_ the history.

The predicate is **"count `failed` rows from the newest backwards until the first non-failed one"**,
and it is deliberately _not_ "no ok run in the last N". The two agree on a populated table and
disagree catastrophically on an empty one: a protocol with no history at all satisfies the second
immediately, so a freshly-truncated `risk_scores` would page someone on the first cycle. Counting
backwards yields 0 on an empty history, so an alert requires N rows that actually exist and actually
failed, and a newly-added protocol is protected by the same arithmetic with no special case. This
stopped being hypothetical on **2026-08-19**, when `risk_scores` was truncated — the streak
derivation now genuinely starts from an empty table. Both cases are asserted in
`indexer/src/alerts.test.ts` and `indexer/src/cycle.test.ts`.

**What this does NOT cover: a total database outage.** If Postgres is unreachable, no run row is
written, so no streak advances and no alert fires — and the streak query would fail too. That
surfaces as the cron route returning 500 (`prepare()` throws before the loop), not as a webhook
message. Reading "the indexer alerts on failure" as including "the database is gone" would be wrong.
Alerting on infrastructure failure as well as protocol failure is a separate feature, deliberately
not folded in here.

**`@stenion/dashboard`** — a Next.js 15 (App Router) site, and the actual deployment target. It's
three things in one Vercel project:

1. The public site (homepage, registry, on-site methodology, on-site API docs, about, per-protocol
   detail pages). Data pages are async Server Components that read `@stenion/db`'s `Store`
   **in-process** — no HTTP hop.

   The **registry's** search/filter/sort state lives entirely in query params (`?q=…&status=…&sort=…`),
   never in component state, so a filtered view is linkable and survives a reload. The page renders
   from those params on the server; the control (`components/registry-controls.tsx`) is a real
   `<form method="get">` that only changes the URL and never holds or filters the list. That is what
   keeps every reason, summary and status phrase in the server-rendered HTML for find-in-page and
   indexing. The ordering itself is pure functions in `app/lib/registry-query.ts` — separated from the
   JSX so the rule that unscored entries never enter the ranked ordering is a testable value rather
   than a rendering habit.

   **`/coverage/:id`** is a second kind of detail page: one protocol we assessed and do not score,
   served entirely from the static `app/lib/coverage.ts` and **never** through `getProtocolDetail`.
   Routing it under `/protocol/:id` would either render ids `GET /api/v1/protocol/:id` 404s on, or
   make that function return a second scoreless shape — the dashboard-vs-API divergence `app/lib/api.ts`
   exists to prevent, in the two forms it can take. Its one live read is the dedupe check: if the
   board has since scored the id, it redirects to `/protocol/:id`, and it fails **open** on a
   database error (the page is static and stays true during an outage). `/coverage` with no id
   redirects to `/registry?status=not-scored`.

   **Rendered docs** (`/methodology`, `/docs/api`) are a second, separate kind of page: they read a
   repo-root markdown file at request time and render it through `components/markdown-doc.tsx`, so
   the file stays the single source of truth and is readable both on GitHub and on the site. Each
   such route needs an `outputFileTracingIncludes` entry in `next.config.mjs`, because the file
   lives outside the dashboard directory and would otherwise be missing from the serverless bundle
   — a failure that is invisible in `next dev`, where the file is simply on disk. `MarkdownDoc`
   adds heading anchors, wraps tables in their own scroll container, gives code fences a copy
   button, and rewrites repo-relative links to the GitHub source **except** for files that are
   themselves rendered here (`app/lib/site.ts`'s `RENDERED_DOC_ROUTES`), which stay on-site.

   The protocol page's **score-history chart** is a client component drawing hand-rolled SVG (no
   charting library) over the `history` array the detail response already carries — it adds no
   endpoint and no query. All of its judgment about what counts as a discontinuity lives in the
   pure, framework-free `app/lib/score-series.ts` so it can be tested against fixtures; the
   component only draws what that returns. The rule it enforces is that a break in the line means
   _the score is unknown here_ — a failed run, an indexing gap wider than 3× the measured cadence,
   or a methodology-version change. None of the three is ever drawn through, and a failed run is
   never rendered as a zero.

2. The public API, as Route Handlers: `GET /api/v1/protocols`, `GET /api/v1/coverage`,
   `GET /api/v1/protocol/:id`, `GET /api/v1/health`.
3. A secret-gated cron-trigger route (`POST /api/cron/run-indexer`) that runs one indexer cycle.

**`@stenion/api`** — a standalone `node:http` REST server. **Not deployed** — see below.
