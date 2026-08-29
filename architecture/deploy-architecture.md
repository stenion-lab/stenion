## Deploy architecture

**One Vercel project = the `dashboard`.** The indexer and the standalone API are not deployed as
separate services. Everything runs from the single Next.js app:

- **API** → Next.js Route Handlers inside the dashboard (`app/api/v1/protocols`,
  `app/api/v1/coverage`, `app/api/v1/protocol/[id]`, `app/api/v1/health`). The scored routes use the
  same `Store` methods and JSON as the original standalone API — a transport change, not a rewrite.
  The coverage route combines the static coverage module with live leaderboard ids solely for
  deduplication. The health route reports indexer freshness and nothing else — see "The health
  endpoint" below. CORS (`access-control-allow-origin: *`) is set on these four routes only, for
  future browser/wallet/third-party clients reading public, payment-blind data. `/api/v1/*` is the
  only public API surface — see "API versioning" below. All four are rate limited; three of them are
  CDN-cached and health deliberately is not — see "Caching and rate limits" below.
- **Indexer** → triggered by `POST /api/cron/run-indexer`, which calls `runIndexerCycle()` once.
  The route is secret-gated (`Authorization: Bearer <CRON_SECRET>`, compared with
  `crypto.timingSafeEqual`); if `CRON_SECRET` is unset it refuses to run, so it's never open. No
  CORS on this route, and **no rate limiting** — it's authenticated and internal, and limiting it
  could only ever block a scheduled run.
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
output. `next.config.mjs` marks `pg` as a `serverExternalPackage` (kept as a
runtime require, not bundled) and pins `outputFileTracingRoot` to the repo root so workspace-dep
tracing is correct. On Vercel: Root Directory = `dashboard`, Build Command = `pnpm run build`.

> **`@stellar/stellar-sdk` must NOT be a `serverExternalPackage`** — it was, and that is what took
> the indexer down on the Next 15 → 16 upgrade (#96). `@stenion/adapters` compiles to CommonJS, so
> it reaches the SDK through the `require` condition (`lib/cjs/*`), and the SDK's CJS build does
> `require('@noble/hashes/sha2.js')` — ESM-only since noble v2. That require works **only** on a
> runtime with `require(esm)` (Node >= 22.12 / >= 20.19); anywhere else it throws `ERR_REQUIRE_ESM`
> at **import time**, so the route 500s before the handler runs. Nothing is recorded as a failed
> run, because the indexer never gets to run — `lastRunStatus` stays `ok` on the last good cycle
> while `staleMinutes` climbs, so **`/v1/health` is the alarm, not the API's error rate**.
>
> Next 15 used webpack, which **bundled** the SDK and resolved that CJS→ESM edge at build time, so
> the deployed Node version never mattered. Next 16 uses Turbopack, which honours the list and
> emits a native `require()`. The stack trace points at Turbopack's `externalRequire`, but the
> bundler is only the messenger — the version of `@noble/hashes` had not changed in 17 days.
>
> Bundling it is Node-version-independent, which is why it is the fix rather than raising the
> runtime. Verify a change here by loading the **production build** with
> `--no-experimental-require-module` (simulates a pre-22.12 runtime) and POSTing the cron route:
> external ⇒ empty-body 500, bundled ⇒ 401 on a bad secret and a real cycle on a good one. `next
dev` and a plain `next start` on a current Node pass either way — they are not a test of this.

The workspace packages themselves are **not** externalised — they are bundled into the serverless
functions, and therefore **minified**, which renames classes and functions. Nothing that is
persisted or published may be derived from a runtime identifier (`constructor.name`, `fn.name`):
those values are correct under `node --test` and `next dev` and wrong in the only environment that
writes the data. `ProtocolMetadata.adapterRef` is a hardcoded literal for exactly this reason — see
[`CONTRIBUTING.md`](../CONTRIBUTING.md#adapterref-must-be-a-hardcoded-string-literal).

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
  through. Several assertions parse `methodology/<category>.md` and the `RiskFactorType` enum as
  text rather
  than restating their numbers, so the rule that code and the methodology may not drift is enforced
  mechanically instead of by review attention.
- **`adapters/*/score.test.ts` / `adapters/*/fetch.test.ts`** — `computeRiskFactors` against
  synthetic raw state. `computeRiskFactors` is a pure function of already-decoded on-chain data, so
  every methodology rule is reachable without RPC. This is where methodology v2's `oracleSafety` is
  pinned: every live pool but YieldBlox prices fresh and bounded, so a live run exercises neither
  the disabled-bound path nor K2's inert-breaker path — the two the rulebook exists to catch.
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
- **`dashboard/app/api/_cache.test.ts`** — the cache TTL policy, and specifically the invariant that
  a cached response can never hide a newer indexer run by more than the 10s floor. That promise is
  arithmetic over a clock and is unobservable everywhere we can look: locally there is no cache, and
  on Vercel a violation looks like a correct-shaped JSON body that is quietly minutes old. Nothing
  goes red, so the bound is asserted here or nowhere.
- **`dashboard/app/api/_rate-limit.test.ts`** — client identity, config parsing, refusal headers, and
  the per-instance deny memo. Every branch decides whether to refuse someone, and none of it runs in
  normal operation: the first time it matters is either an abuse incident or an integrator's launch,
  and a mistake that pools clients together makes the second look like the first.
- **`db/src/rate-limit.test.ts`** — what a token balance _means_, including the wait an integrator is
  told to back off by. Production runs this at `tokens = 59.9997` and `tokens = -0.0001`; the
  interesting cases are exactly the ones a real request never lands on. The refill itself is
  Postgres arithmetic and is not covered here.
- **`indexer/src/cycle.test.ts`** — the run loop's error model, against a deliberately throwing
  adapter and an in-memory `Store`. The contract is that an adapter throws, the indexer records a
  failed run and continues; `risk_scores` has **never** held a failed row (1,683 rows as of
  2026-08-16, and truncated on 2026-08-19), so nothing about this path is evidenced by it having run
  in production. Also covers retry inside the loop (a transient failure clearing on a later attempt;
  an exhausted retry still recording `failed` with the adapter's own message), the budget rule
  (`targetDeadline` never dropping a target below one full attempt at any feasible target count, and
  `cycleFeasibility` holding at five targets and failing at six on the shipped defaults), the worker pool (peak in-flight
  bounded, results ordered by registration however completion is ordered, a failure isolated to its
  own target while another is mid-flight), and alerting against a **seeded** failure streak —
  including the case that matters
  most now, that an empty history raises nothing on the first cycle.
- **`indexer/src/retry.test.ts`** — the backoff schedule and the deadline, driven by a fake clock so
  the timing is asserted rather than waited on. Pins the two properties the design rests on: it
  never runs past its deadline, and it rejects with the _last_ error rather than swallowing it.
- **`indexer/src/alerts.test.ts`** — streak counting, the edge-triggered fire/recover decision, and
  the message text. The first assertions are the empty- and near-empty-history guarantee: a fresh
  `risk_scores` and a first-ever failed cycle must both raise nothing.
- **`dashboard/app/lib/format.test.ts`** — the freshness descriptor and its colour mapping, on the
  same footing as the score-series tests below and for the same reason: no run has ever failed, so
  every string a reader would see on a failed run exists only here. One assertion is a rule rather
  than a behaviour — that no fault state is dressed in a score-band colour.
- **`dashboard/app/lib/score-series.test.ts`** — the score-history series builder. As of
  2026-08-14 `risk_scores` held 527 rows and not one failed run, so the failed-run path had to be
  proven against fixtures rather than by looking at the page.

**Environment variables** (all on the one Vercel project, Production + Preview): `DATABASE_URL`
(Neon pooled), `STENION_RPC_URL`, `STENION_HORIZON_URL`, `CRON_SECRET`, and optionally
`STENION_ALERT_WEBHOOK_URL` (failure/recovery alerts; unset = alerting off) and
`STENION_CYCLE_CONCURRENCY` (targets in flight at once; **default 1** — it shipped at 2 and was
reverted the same day when the free shared public RPC started returning `429`). The retry and
threshold knobs — `STENION_RETRY_ATTEMPTS`, `STENION_RETRY_BASE_DELAY_MS`,
`STENION_ATTEMPT_TIMEOUT_MS`, `STENION_CYCLE_BUDGET_MS`, `STENION_ALERT_THRESHOLD` — all have
defaults and only need setting to override them; every one is documented in `.env.example`.
Locally, every package reads these from a single repo-root `.env` via a walk-up loader.

### RPC cost per target, measured

**Why this section exists.** `STENION_CYCLE_CONCURRENCY` is at 1 because an estimate computed from
developer-machine timings got the request _rate_ wrong and drew `429`s from the free shared public
RPC on the day it shipped at 2. So a new adapter's cost is counted in **requests**, which is
machine-independent, before anything is said about seconds.

Counted by instrumenting `globalThis.fetch` around one `fetchRawData()` per adapter, 2026-08-29:

| Target                        | Soroban RPC                             | Horizon | Total requests |
| ----------------------------- | --------------------------------------- | ------- | -------------- |
| Blend Fixed V2                | 14                                      | 2       | **16**         |
| Kinetic (K2)                  | 27                                      | 0       | **27**         |
| Aquarius, 2-token pool        | 22 (18 simulate + 4 `getLedgerEntries`) | 15      | **37**         |
| Aquarius, 3-token stable pool | 23 (18 simulate + 5 `getLedgerEntries`) | 17      | **40**         |

**An Aquarius pool costs roughly 2.3x a Blend pool in requests, and the shape is not what was
predicted.** Issue #101 estimated "~25 simulate calls and ~9 Horizon requests", where the simulate
count was dominated by `estimate_swap` probes. The simulate count landed at 18 with **no depth
simulation at all** — `depthSafety` was deferred by question A in `methodology/dex.md`, so
`estimate_swap` is never called — and the cost moved to **Horizon instead**, which the estimate had
low by a factor of ~1.7.

**The `getLedgerEntries` count is low because one read answers a lot.** A contract's _instance_
entry carries 31 (router) to 40 (concentrated pool) storage entries in a single ledger read — admin
roles, fee, reserves, `UpgradeDeadline`, `FutureWASM` — so the adapter reads it once per contract
and takes everything from it rather than fetching keys individually. An earlier version additionally
probed eight speculative ledger keys per contract for the upgrade fields; those were removed once
the fields were found where they had been all along, which is worth **2 RPC calls per pool**.

**The Horizon cost is where it is because of the seven roles, and it is two requests each, not
one.** `adminKeySafety` reads every privileged account's thresholds/signers _and_ its recent
operations — `/accounts/{G…}` plus `/accounts/{G…}/operations` — so seven roles is 14 requests
before a single token is looked at. The adapter already caches accounts by address for the duration
of one fetch, which is what stops the router's roles and the pool's roles being read twice; without
it the figure would be 28.

> **The registry's ceiling is the deploy, not the census — and it is five targets.**
> `cycleFeasibility()` checks `ceil(targets / concurrency) * ATTEMPT_TIMEOUT_MS <= CYCLE_BUDGET_MS`.
> At concurrency **1** and `ATTEMPT_TIMEOUT_MS` 10,000, the old 42,000ms budget allowed exactly
> **four** targets — the four lending markets that were already registered — so registering **any**
> dex market at all made the cycle infeasible, whichever market it was. That was #101's finding and
> it was #104's blocker, independent of which pools the census turned up.
>
> | Targets          | Concurrency | Waves | Required | Against 42,000ms | Against 50,000ms  |
> | ---------------- | ----------- | ----- | -------- | ---------------- | ----------------- |
> | 4 (lending only) | 1           | 4     | 40,000ms | feasible         | feasible          |
> | 5 (+1 Aquarius)  | 1           | 5     | 50,000ms | **infeasible**   | feasible, exactly |
> | 6 (+2 Aquarius)  | 1           | 6     | 60,000ms | **infeasible**   | **infeasible**    |
>
> **Resolved in #104 by raising `STENION_CYCLE_BUDGET_MS` from 42,000 to 50,000, and by nothing
> else.** Concurrency stays at 1 and `ATTEMPT_TIMEOUT_MS` stays at 10,000. The three levers were
> weighed and two were rejected on evidence:
>
> - **Concurrency 2** would make five targets fit in three waves, and is the change that drew
>   sustained `429`s from the free shared public RPC and was reverted the same day. Raising it needs
>   its own deployed RPC-tolerance measurement, which #104 did not do. (Incidentally reproduced
>   while running the pool census: four concurrent `simulateTransaction` streams against
>   `mainnet.sorobanrpc.com` drew `429` on 28 of 340 reads. Not a substitute for a deployed
>   measurement, but not encouraging either.)
> - **Lowering `ATTEMPT_TIMEOUT_MS` to 8,400** would have bought the fifth target inside the old
>   budget with nothing else touched, and was rejected because an Aquarius attempt is the longest in
>   the registry. Its request count is 22 RPC + 15 Horizon (above, machine-independent) against
>   Kinetic's 27 RPC, and the deployed function's observed rate is 150–235ms per request, which puts
>   an Aquarius attempt somewhere in 5.5–8.7s. A cap inside that range would time out a healthy
>   target on a slow day.
>
> **The raise was made against observed deployed durations, which is the only condition CLAUDE.md
> allows it under.** Three cycles `curl`ed from the deployed cron route on 2026-08-29, production,
> concurrency 1, four lending targets:
>
> | Run | blend   | etherfuse | yieldblox | kinetic | `totalMs` | HTTP wall |
> | --- | ------- | --------- | --------- | ------- | --------- | --------- |
> | 1   | 3,049ms | 3,007ms   | 3,676ms   | 4,991ms | 15,482ms  | —         |
> | 2   | 2,412ms | 3,196ms   | 3,934ms   | 5,325ms | 15,627ms  | 17,312ms  |
> | 3   | 2,458ms | 3,249ms   | 3,926ms   | 6,363ms | 16,759ms  | 17,738ms  |
>
> So a real cycle uses ~16s of the budget, and the function's own overhead beyond the cycle — route
> entry, pool connect, the `upsertProtocol` loop, the response — is **1.0–1.7s**. A cycle can never
> run past the budget (`targetDeadline` caps every target at `budgetEndsAt`), so the worst-case
> function wall at a 50s budget is **~52s against the 60s `maxDuration`**, leaving ~8s of margin.
> The ceiling is still load-bearing and still respected; what changed is that there are now
> measurements to size against, which is exactly what the previous comment on this default asked for.
>
> **This is the last target the budget can buy.** A sixth needs 60,000ms of attempts, which **is**
> the `maxDuration` ceiling — so it cannot come from here. It has to come from a lower attempt
> timeout justified by a deployed Aquarius `durationMs`, or from concurrency with its own measured
> RPC-tolerance test. Which is why `AQUARIUS_POOLS` holds one entry while 339 further Aquarius pools
> are scorable, and why those 339 are published on the registry under `coverage.ts`'s
> `awaiting-capacity` status rather than being quietly omitted.

**Wall-clock from a developer machine is recorded but is NOT the claim.** A full local cycle on
2026-08-29 ran all five targets in 36.7s — `etherfuse` 7,524ms, `aquarius-xlm-usdc` 8,929ms,
`kinetic` 7,659ms, `yieldblox` 7,042ms, `blend` 5,545ms — from Nigeria against the public endpoint,
which is exactly the measurement CLAUDE.md forbids making an RPC-load claim from. The _ratio_ is the
usable part: Aquarius is ~1.6x Blend on the same machine in the same session, and Blend is 5,545ms
locally against 2,412–3,049ms deployed. **A deployed per-target `durationMs` for `aquarius-xlm-usdc`
is still owed**, and is the first thing to read off the cron route's response after this ships —
`curl -X POST … /api/cron/run-indexer` returns it. If it exceeds the 10,000ms attempt timeout, the
target will retry and eventually record a failed run rather than silently mis-score, and the answer
is to reduce the adapter's request count, not to raise the budget again.

### Caching and rate limits

The public API had neither, deliberately, until it was deployed and about to be pitched to wallet
integrators. Both exist for one reason: **the whole system runs on Neon's free tier, and an
aggressive client could exhaust it.** The data behind these routes only changes every ~5 minutes, so
caching is nearly free; rate limiting covers the client that defeats the cache.

Neither changed the JSON. Existing consumers see the same bodies with a `Cache-Control` header
added, plus a `429` status that did not exist before.

**What is actually doing the caching:** Vercel's CDN, driven by a `Cache-Control` header the route
handlers set per response. Not an in-process cache — the API is serverless, each invocation is its
own process, so a module-level cache would miss on every cold start and hold a different answer per
warm instance. Being honest about the limits of that:

- The CDN caches **per edge region**, so the origin sees roughly one request per TTL _per region
  with traffic_, not one globally.
- The cache key includes the **query string**, so `?anything=1` is a fresh key and a guaranteed
  miss. The cache reduces cost for well-behaved clients; it does not protect the database from a
  hostile one. That is the rate limiter's job, and it is why the limiter has to be accurate rather
  than decorative.

**The TTL, and why it is computed per response.** `lastRunAt` / `lastRunStatus` are how a consumer
knows whether our data is stale (see "Staleness model" above). A fixed TTL of _N_ seconds serves a
body claiming "the last run succeeded at T" for up to _N_ seconds after a later run has already
failed — the cache would be lying in exactly the field that exists to stop us lying about freshness.
Shortening _N_ bounds that window; it does not remove it.

So the TTL is derived from the data in the body (`dashboard/app/api/_cache.ts`): **cache until the
earliest moment the next indexer run could plausibly land, and no further.**

`GET /api/v1/health` is the other, and it goes the opposite way: **`no-store`, never cached at
all.** The reasoning above works because the thing a cache could hide changes only when a run lands,
so expiring before the next run closes the hole. Health does not behave that way — staleness
advances with the wall clock, so a body built at 29 minutes stale and cached for even 45 seconds is
still being served, saying `healthy` with a `200`, after the true answer has become `degraded` with
a `503`. The window is small; the endpoint is the one whose entire purpose is to be believed about
freshness, and a health check that can be stale is a contradiction rather than a tradeoff. The
`503`s must not be cached either, for a stronger reason: the CDN cache key is the URL, so a cached
`503` would go on being served to everyone after the pipeline recovered, turning a resolved incident
into an ongoing one. What it costs is one database round trip per request, uncushioned. Measured
from a dev machine on 2026-08-22, warm: **0.4–1.1s for `listRunHealth` against 1.1–1.2s for the
leaderboard query**, both dominated by network round trip rather than by the query — so the
uncached route is no more expensive per request than the cached one, and it is bounded above by the
rate limiter.

`GET /api/v1/coverage` is the deliberate exception. Its published records are static and normally
change only with a deploy, and its body intentionally has no `lastRunAt` from which to derive a
deadline. It therefore uses a fixed **3,600-second shared-cache TTL**. The route still reads live
leaderboard ids as a defensive dedupe guard; the one-hour bound limits how long a forgotten
reciprocal cleanup could leave an entry cached after it becomes scorable. A deployment replaces the
static records and invalidates the old deployment's cache.

| Constant                   | Value | Why                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INDEXER_INTERVAL_SECONDS` | 300   | The cron-job.org cadence; observed median `run_at` spacing is 4m59s.                                                                                                                                                                                                                                                          |
| `CYCLE_JITTER_SECONDS`     | 45    | `run_at` is stamped when a protocol's _turn_ begins, not when cron fires, so its spacing shifts by however much the protocols ahead of it sped up or slowed down — bounded by `STENION_CYCLE_BUDGET_MS` (default 50s). Concurrency only shrinks this (targets sharing a wave start together), so it stays a safe upper bound. |
| `MAX_TTL_SECONDS`          | 45    | Blast radius, not load. See below.                                                                                                                                                                                                                                                                                            |
| `MIN_TTL_SECONDS`          | 10    | Floor, so the moment around a landing run isn't an uncached hole every client stampedes through.                                                                                                                                                                                                                              |

The deadline is `lastRunAt + 300 − 45 = lastRunAt + 255`, clamped into `[10, 45]`. On a leaderboard
response every protocol's `lastRunAt` counts and the tightest deadline wins, because any of them
landing changes the body. A `null` or unparseable `lastRunAt` collapses to the floor.

**Why the ceiling is 45 and not 255.** It is not a load number. A continuously-requested route hits
the origin `1/TTL` times per second whatever the traffic is, so 45s is ~1.3 origin requests per
minute per region and 255s would be ~0.24 — a difference of nothing to Neon. It is a blast-radius
number: `INDEXER_INTERVAL_SECONDS` is an assumption about a schedule that lives in the cron-job.org
dashboard and **not in this repo**, so nothing here fails if someone changes the cadence. The
ceiling caps what a wrong assumption costs at 45s of staleness instead of a full cycle's worth.

**The guarantee this buys.** A cached response can hide a newer run for at most `MIN_TTL_SECONDS`
(10s) — asserted mechanically over every run age in `_cache.test.ts`, because the property is
invisible in every environment we can look at: locally there is no cache, and on Vercel a failure
looks like a correct-shaped JSON body that is quietly a few minutes old. Nothing goes red. On top of
that bound, the CDN's own `Age` header makes the residual window _visible_ rather than merely small:
a consumer that cares can subtract it.

Two deliberate omissions:

- **No `stale-while-revalidate`.** It is the standard fix for the stampede at expiry, and it works
  by serving a body _past_ its deadline — precisely the masking above. The stampede it would prevent
  is bounded by the rate limiter and by this project's traffic; the staleness it would reintroduce
  is not bounded by anything.
- **`max-age=0` for private caches.** A copy in someone's browser is one we cannot see, cannot
  expire, and gain nothing from — the shared tier already absorbs the load — and it would put a
  response's real age beyond what `Age` reports.

Errors and 404s are `no-store`. A cached 500 outlives the outage that caused it, and a cached 404
would keep 404ing for a protocol added in the next cycle.

**The rate limiter.** A **token bucket, one row per client, in Postgres** (`api_rate_limits`,
migration 0005; `db/src/rate-limit.ts`). Postgres and not memory for the reason above: an
in-memory counter is per-instance, so N warm instances would allow N × the intended rate _while
reporting that the limit was enforced_. False confidence is worse than no limiter.

- **The limits: 60 requests/minute sustained, 60 of burst, per client.** Sized against what is
  actually counted — cache **misses**. A wallet polling every 5 seconds produces roughly one miss
  per TTL because the CDN serves everything in between, so 60 is an order of magnitude above any
  legitimate integrator. What it does bite is the case it is for: a client defeating the cache with
  a varying query string, where every request is a database query. That client is capped at ~1
  query/second instead of unbounded.
- **A cache hit does not count**, and this is structural rather than a policy choice: a hit never
  invokes the function. It is also the right policy — the limit protects the database, and a hit
  costs the database nothing. The consequence, stated plainly: the documented limit is **not** a cap
  on total requests. A client polling a cached endpoint can exceed it all day.
- **Per client IP**, taken from `x-real-ip` (Vercel sets it, single-valued) falling back to the first
  `x-forwarded-for` hop. **Behind a shared NAT** — a corporate office, a mobile carrier — everyone
  shares one bucket. That is survivable here only because of the previous point: NAT'd browser
  traffic overwhelmingly hits the CDN, so a thousand users behind one address still generate roughly
  one miss per TTL between them. The case that would genuinely break is a thousand NAT'd clients
  each cache-busting, which is indistinguishable from the abuse this is meant to stop.
- **Not an IP log.** The stored key is a salted SHA-256 prefix, never the address
  (`STENION_RATE_LIMIT_SALT` — set it in production, or the hash is reversible by enumerating IPv4).
  Rows idle for an hour are pruned opportunistically on ~1 in 256 served requests, so the table stays
  proportional to _active_ clients.
- **A 429 carries `Retry-After` (seconds), `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` (unix epoch seconds), and `Cache-Control: no-store`.** The last is
  load-bearing: the CDN keys on URL, not client, so a cacheable 429 would be replayed to every other
  client that asked next — one scraper's limit becoming everyone's outage. Those headers ship on
  **refusals only**: a 200 is shared-cached and served to many clients, so an
  `X-RateLimit-Remaining` baked into it would be one client's balance, frozen, replayed to
  everybody — wrong for every reader including the one it came from.
- **It fails open.** If the limiter's own query throws — table missing because the migration has not
  run, pool exhausted, Neon down — the request is allowed and the error is logged. A broken guard
  rail must not become a broken API, and it means migration 0005 and the deploy can land in either
  order.
- **The cron trigger is not rate limited.** It is secret-gated and internal; limiting it could only
  ever block a scheduled run.

**What this does not protect against.** A distributed attack. The limiter is per-client-key, so a
thousand hosts each staying under the limit are a thousand clients as far as it is concerned.
Stopping that is a network-edge job (Vercel's firewall), not an application one. It also trusts the
platform's proxy headers — true on Vercel, which overwrites them, but a proxy that passed a
client-supplied `x-forwarded-for` through would let a client split itself across unlimited buckets.
That is a property of the deployment, not something this code can detect.

**What it costs.** One database round trip per cache miss. Deliberate — it is the price of a counter
that is genuinely shared. A per-instance memo short-circuits clients that have _already_ been
refused, so a flood costs one write per block window rather than one per request; that memo may only
ever refuse faster, never allow, which is what makes a per-instance structure sound there when it
isn't for the counter itself.

### The health endpoint

`GET /api/v1/health` answers one question — **is the indexer still producing data?** — in a form a
machine can act on.

**Why it exists.** Scoring silently stopping is the worst failure mode this system has, and it is
worst precisely because nothing goes red. The site keeps serving last-known scores, every page
renders, no route 500s, and the numbers quietly age. Before this endpoint the only ways to notice
were to query Neon by hand or to eyeball a timestamp in the UI and compare it against a clock. The
indexer's failure webhook (see "Retry and failure alerting") covers a different case: it fires when
an adapter fails repeatedly, and it cannot fire at all if the cron simply stops arriving, because
nothing runs to notice. This endpoint is the outside-in check that catches that.

**Staleness is measured from the last _successful_ run.** A failed run produced no score. Measuring
from `lastRunAt` would let an adapter that fails reliably every five minutes report as perfectly
fresh forever — inverting the endpoint's purpose. So `staleMinutes` is the age of the newest `ok`
run and nothing else.

`lastRunAt` / `lastRunStatus` are still published per protocol, because read together with the
above they say **where** the problem is:

| `lastRunAt` | `lastSuccessfulRunAt` | What it means                                            |
| ----------- | --------------------- | -------------------------------------------------------- |
| fresh       | fresh                 | Working.                                                 |
| fresh       | stale                 | The cron is arriving; this adapter is failing. Isolated. |
| stale       | stale                 | The cron is not arriving. Infrastructure.                |
| `null`      | `null`                | Registered but never indexed.                            |

**Three states, not a boolean.** "Unhealthy" conflates one adapter failing (a code bug in one file)
with nothing succeeding anywhere (the pipeline is down). Those have different owners and different
first moves, and a single flag forces an operator to open the body to find out which — which is what
having a status is supposed to avoid.

| `status`   | Meaning                                                                     | HTTP  |
| ---------- | --------------------------------------------------------------------------- | ----- |
| `healthy`  | Every protocol scored successfully within the threshold.                    | `200` |
| `degraded` | Some current, some not — or all stale but inside the down window.           | `503` |
| `down`     | Nothing current anywhere, past the down window. The cron itself looks dead. | `503` |

Both non-healthy states answer **`503`**, so an uptime monitor catches either without parsing the
body; the distinction between them is for the human who then opens it. `503` rather than `500`
because nothing errored — the route queried successfully and is telling the truth about a pipeline
that is behind, which is exactly what `503` means. A genuine `500` on this route means we could not
find out, and keeping those on separate codes is what lets a monitor tell "the indexer is stopped"
from "the health check is broken".

**The thresholds**, both configurable, defaults in `dashboard/app/api/_health.ts`:

| Setting                          | Default | Why                                                                                                                                                                 |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STENION_HEALTH_STALE_MINUTES`   | 30      | Six missed cycles at the ~5-minute cadence. Sits above `STENION_ALERT_THRESHOLD` (4 cycles, ~20 min) so the webhook mentions a problem before the monitor goes red. |
| `STENION_HEALTH_DOWN_MULTIPLIER` | 2       | 60 minutes with not one successful run anywhere before blaming the cron itself.                                                                                     |

30 is sized against what already exists rather than picked round. The indexer's alert threshold is
4 consecutive cycles, on the stated reasoning that "a score 20 minutes stale is not an emergency —
false pages are how people learn to ignore alerts". A `503` an uptime monitor consumes is a louder
signal than that webhook, so it must sit at a higher bar; 30 > 20 gives the intended escalation
order. The floor is set by the cadence: under ~10 minutes, one slow cycle, a cold start, or a single
cron-job.org misfire would read as an outage.

The down window exists because "everything is stale at once" is weaker evidence than it sounds.
Every adapter shares Soroban RPC and Horizon, so a broad upstream outage takes them all out together
while our own infrastructure is fine — and calling that "the cron is dead" sends an operator to the
wrong place. With five targets today (one adapter serving three of them, and two categories), "all
of them" is a small sample. Doubling the window costs nothing operationally, because `degraded` is already `503`
and a monitor has already fired; all it buys is the confidence to name which thing broke. The window
is measured from the **freshest** success across the registry — the most generous reading available,
so the endpoint can never report worse than the truth.

**A fresh failure alone is not unhealthy.** A protocol whose newest run failed but whose newest
_success_ is four minutes old reports `healthy`. That is deliberate. The indexer already retries
(default 3 attempts) before recording a failure at all, but it is still one cycle, and the data it
protects is current — turning red there pages someone about a blip. Repeated failure is not missed:
an adapter that keeps failing stops producing successful runs and crosses the threshold on its own.
Sustained failure and staleness are the same event seen at different times, so staleness alone
catches it with the transient case filtered out for free. A consumer who does want to act on any
single failed cycle reads `lastRunStatus`, which is why it is published.

**One query, no fan-out.** `Store.listRunHealth()` reuses the same two `LEFT JOIN LATERAL`
subqueries the leaderboard uses over the existing `(protocol_id, run_at DESC)` index — the `ok` side
just selects `run_at` instead of the score. **No schema change was needed**; the row that answers
this was already one column away. Nothing score-derived is selected: no `safety_score`, no `factors`
jsonb, so a freshness probe cannot fail because a score was malformed, and no adapter error text is
republished on an unauthenticated endpoint. A health check that fans out per protocol gets slower in
proportion to how much there is to report on, and a probe that times out under load is
indistinguishable from the outage it exists to detect.

**A cold Neon can make this probe time out, and that is left alone deliberately.** Measured on
2026-08-22, the first query against a Neon instance scaled to zero took ~20s; Vercel's default route
timeout is 10s, so such a probe returns a platform `504` rather than this route's own `503`. Raising
`maxDuration` to chase a nicer body is not worth it: Neon only goes cold when nothing has touched it
for a long while, which on this deployment means the indexer has stopped — precisely the case where
the verdict is "unhealthy" regardless. A monitor treats `504` and `503` identically, so the answer
survives; only the body is lost, and buying it back would make every healthy probe wait longer.

An empty registry reports `down`, not `healthy`. Vacuous truth is the wrong answer for a probe:
"nothing is stale because there is nothing" is a database migrated but never indexed, or one pointed
at the wrong connection string.

The policy — what stale means, the three states, the HTTP mapping — lives in
`dashboard/app/api/_health.ts`, a leaf module with **no imports at all**, for the same reason
`_cache.ts` and `_http.ts` are: every interesting state here is one production has never produced
(`risk_scores` has never held a `failed` row), so it is asserted in `_health.test.ts` or it is
asserted nowhere.

### API versioning

The public API is versioned in the URL. The documented, canonical paths are:

| Endpoint                   | Returns                                                |
| -------------------------- | ------------------------------------------------------ |
| `GET /api/v1/protocols`    | The leaderboard: every protocol + its latest score.    |
| `GET /api/v1/coverage`     | Assessed protocols and markets Stenion does not score. |
| `GET /api/v1/protocol/:id` | One protocol's detail, factors, and run history.       |
| `GET /api/v1/health`       | Indexer freshness per protocol + one overall status.   |

**The consumer-facing reference is [`api-docs/index.md`](../api-docs/index.md)**, rendered on the site at `/docs/api`. This
section owns the _policy_; that document owns the contract as an integrator meets it — request and
response examples, the `ok`/`failed` history union, the staleness model, error shapes, and the
observable caching/rate-limit headers. Its examples are captured from the live production API
rather than written from the types, deliberately: a doc written from `db/src/store.ts` would
reproduce the type rather than the truth. **Re-capture them when a response shape changes** —
and note that what a client actually observes is not always what a route sets (Vercel's CDN
consumes `s-maxage`, so a `200` reaches the client as `Cache-Control: public, max-age=0` plus
`Age`).

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
contract doesn't. Methodology changes are versioned in [`methodology/index.md`](../methodology/index.md), not in
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

**It is not at parity, deliberately.** It has no caching and no rate limiting, and those were not
back-ported when the dashboard routes gained them. Both are deployment concerns rather than API
concerns: the cache is a `Cache-Control` header that only means something with a CDN in front, and
the rate limiter's counter lives in Postgres _specifically because_ serverless has no shared memory
— a single long-lived Node process has memory, so paying a database round trip per request there
would be the wrong trade. Whoever revives it owns both decisions afresh; the JSON contract and the
versioned paths are what must not change. The one rule that does carry over is a property of the
data rather than the transport: **whatever caches it must not mask `lastRunAt`/`lastRunStatus`.**
The header comment in `api/src/index.ts` says all of this at the point someone would actually read
it.
