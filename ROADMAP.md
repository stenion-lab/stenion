# Stenion Roadmap

Where Stenion is and where it's going. This is a direction-of-travel document, not a dated
commitment — priorities shift as protocols launch and as the project finds funding.

## Live now

- **Continuous risk scoring for Stellar/Soroban lending protocols**, with a public, free, ranked
  registry sorted purely on `safetyScore` — payment-blind, no exceptions.
- **Five markets scored end-to-end from live mainnet data — three protocols, two categories:**
  - **[Blend](https://blend.capital)** — the flagship Fixed V2 pool (`CAJJZSGM…`). Reference
    implementation.
  - **[Kinetic / K2](https://k2lend.com)** — an Aave-V3-style single-pool-multi-asset protocol; the
    first adapter to exercise a genuinely different on-chain shape than Blend, validating the shared
    taxonomy against a non-Blend protocol.
  - **YieldBlox** (`CCCCIQSD…`) — a DAO-managed pool **on Blend V2**, not an independent protocol.
    Scored by `BlendAdapter` pointed at a second pool, and labelled as a Blend V2 pool everywhere it
    appears. See "Multi-pool Blend targeting" below.
  - **[Etherfuse](https://etherfuse.com)** (`CDMAVJPF…`) — a market **on Blend V2** lending against
    Etherfuse's own tokenized sovereign-bond assets (CETES, USTRY, TESOURO) alongside XLM and USDC.
  - **[Aquarius](https://aqua.network) XLM/USDC** (`CA6PUJLB…`) — **the first entry of a second
    category.** A constant-product AMM pool scored under the `dex` rulebook's two factors, not
    lending's five, and ranked in its own block: `#` is scoped to one rulebook, so this is 01 of
    dex rather than last of five. One market of Aquarius's 340; the rest are scorable and
    unregistered for want of a target slot, and say so on the registry. See "Beyond lending" below.
    Same label, same adapter, third pool; a config entry and no new scoring code.

  **Four scored markets, not five.** The Blend V2 pool investigation found five unregistered
  pools clearing the market-size floor and registered exactly one of them. The other four are
  published as **assessed-and-not-scored** coverage entries because their oracles fail the
  oracle-legibility precondition — see "Four Blend V2 markets" under _Protocols investigated and
  skipped_. Those four are unranked and carry no numeral; only the four above are in the ranking.

- **Operational state, published beside every score and deliberately not scored.** Both adapters
  had always read a pause/frozen signal (Blend's `PoolConfig.status`, K2's `router.is_paused()`)
  and neither had ever used it. Resolved as a decision **not** to grade it: nothing on chain
  separates an admin freezing a pool to contain a threat from an admin abandoning it, and the two
  protocols' restricted states are not even the same shape — Blend never blocks a withdrawal at any
  of its seven statuses, while K2's pause blocks withdrawals, repayments and liquidations alike. So
  each market publishes a typed `operationalState` (what is blocked, the protocol's own reading
  verbatim, whether only an admin could have set it, when it was read), on the leaderboard and the
  detail response both, rendered beside the name and score everywhere either appears.
  lending's methodology version stayed at **1** — no formula, threshold or weight moved, and both adapter
  suites assert a byte-identical factor map across every restricted state. K2's per-reserve gating
  flags are now read too, out of the bitmap the adapter already fetched for decimals, so a market
  open in USDC and halted in PYUSD reports the halt. Full reasoning, including the two scored
  designs that were rejected and why, in
  [`methodology/publishing-rules.md`](methodology/publishing-rules.md#operational-state-is-published-never-scored).
  `ADAPTER_INTERFACE_VERSION` is now **2**: `operationalState(raw)` is required of every adapter.

- **Multi-pool Blend targeting.** `BlendAdapter` takes a `BlendPool` config — slug, display name,
  pool contract, mark, links, deployment label — instead of hardcoding one pool, and the indexer
  iterates `BLEND_POOLS`. Every Blend market runs the same pool wasm (all three registered pools
  report code hash `a41fc53d…`, and the V2 factory's `is_pool` returns true for each), so a further
  market needs **no new scoring code** — only a config entry. Registering Etherfuse was exactly that:
  one `BlendPool` literal, one captured fixture, and nothing touched in any factor. The same rule
  that moved `scoreFactors` into `core`, applied to pool targeting.

  It is **targeting, not aggregation**: each pool is a separate ranked entry scored from its own
  reserves, oracle and admin. The three live Blend pools sit 30 points apart end to end on identical
  contract code (54, 50 and 24), which a single summed "Blend" number would have hidden.

  **A registry entry is therefore no longer the same thing as a protocol**, and the API says so:
  `deployedOn` (`{ host, label }`, null for an independent entry) rides on both the leaderboard and
  the detail response, and the dashboard renders it beside the name on the registry row, the
  homepage card, the protocol hero and the page's own metadata description. That labelling is the
  condition on which the entry exists — presenting a Blend market as an independent protocol is the
  exact misrepresentation this project refused when it declined to build a standalone YieldBlox
  adapter.

- **The five-factor `*Safety` model** — collateral concentration, oracle trustworthiness, admin-key
  control, liquidity depth, utilization headroom — with a fully public, challengeable rulebook in
  [`methodology/index.md`](methodology/index.md).
- **Two size floors, both published.** The reserve-level
  [minimum-size filter](methodology/lending.md#the-minimum-size-filter) decides which reserves may set
  §4/§5's number; the [market-size floor](methodology/lending.md#the-market-size-floor) decides whether a
  market is scorable at all. They are the same idea at two scales — a size below which a number
  stops carrying information — and the second exists because an empty market does not fail, it
  publishes **0**, in the danger band, meaning the opposite of what is true. Neither moved a
  published score; the floor is a precondition, not a formula.
- **Oracle robustness.** `oracleSafety` scores price freshness _and_ manipulation
  resistance: whether the pool's own price path bounds how far a single update can move, read from
  the protocol's own on-chain config. Freshness is anchored to each oracle's real resolution and
  max-age rather than to Stenion constants. This is part of methodology v1 — the only version
  that exists. Runs are stamped with the version that produced them, so a future change to what a
  factor measures is visible rather than silent.
- **Score history on the protocol page.** The append-only run history rendered as a chart of
  `safetyScore` over time — the visible form of the "continuous, not static" pitch. Plotted on a
  real time axis and a fixed 0–100 axis, and the line **breaks** rather than being drawn through
  anything unknown: a failed run, an indexing gap, or a methodology change. Hand-rolled SVG, no
  charting dependency.
- **Freshness, shown as its own thing.** When the newest indexer run failed, the registry row and
  the protocol page say so — an accent-toned marker, a plain-English label, and the full sentence on
  hover or focus: the score is the last one we computed successfully, and the latest attempt to
  refresh it failed. Deliberately **not** in the score-band colours: amber or red there would say
  "this protocol is dangerous" when it means "our data is old", so freshness and risk stay two
  separate vocabularies.
- **Protocol identity — marks and verification links.** Each protocol carries a logo, the contract
  its score is derived from, and its own site/docs, all in adapter metadata rather than a frontend
  lookup table. Marks are self-hosted (never hotlinked), render in a fixed tile that works in both
  themes, and fall back to an initials tile for protocols with no usable mark. The protocol page
  links the scored contract on stellar.expert — the point being that a score should be checkable,
  not merely readable. Marks and links carry an explicit note that neither implies endorsement.
- **Indexer retry and failure alerting.** A transient RPC blip used to record a failed run silently,
  and nobody found out until they happened to look at the data. The indexer now retries a failing
  protocol within a wall-clock budget and POSTs to a webhook when one fails four consecutive cycles
  (~20 minutes), with a recovery message when it comes back. Failures are **louder and rarer, not
  hidden**: a run that ultimately fails is still recorded as `failed`. The consecutive-failure
  streak is derived from `risk_scores` rather than stored in a counter, so it needs no new table and
  cannot disagree with the history it describes. See [`architecture/index.md`](architecture/index.md).
- **A public freshness endpoint — `GET /api/v1/health`.** The failure-alerting above covers an
  adapter failing repeatedly; it cannot cover the indexer not running at all, because nothing runs
  to notice. There was previously no way to tell the difference short of querying Neon or eyeballing
  a timestamp in the UI, and the site keeps serving last-known scores either way. The endpoint
  publishes per-protocol run freshness and one overall status, and answers **503** when that status
  is not `healthy`, so an uptime monitor consumes it without parsing a body. Three states rather
  than a boolean, because "one adapter is broken" and "the pipeline is dead" need different first
  moves: `degraded` says read the rows, `down` says go look at the cron. Staleness is measured from
  each protocol's last **successful** run — measuring from the last run of any status would report
  an adapter failing every five minutes as perpetually fresh. Needed **no schema change**: it reuses
  the same two LATERAL subqueries the leaderboard already runs, one query, no fan-out. Thresholds
  are configurable (`STENION_HEALTH_STALE_MINUTES`, default 30) and sit above the alert threshold so
  the webhook fires before the monitor goes red. See [`architecture/index.md`](architecture/index.md).
- **Public API documentation.** [`api-docs/index.md`](api-docs/index.md), rendered on the site at `/docs/api`. Until now
  the only way to learn the contract was reading the route handlers on GitHub, which is a barrier
  for exactly the wallet-integrator audience the API exists for. Covers every endpoint with live
  captured examples, the versioning commitment (additive stays on `v1`, breaking gets a `v2`), the
  `ok`/`failed` history union, the staleness model, rate limits, and error shapes. Every example is
  a verbatim `curl` capture rather than written from the types; a newly-added route is recaptured
  against production after promotion.
- **Coverage decisions are published, not just recorded.** The registry now has a second section —
  **"Assessed, and not scored"** — listing what we investigated and declined, with a
  protocol-specific reason and a "verify it yourself" path for each. Until now the only record of
  that work was the footnote at the bottom of this file, which no visitor reads: absence told a
  reader nothing, so someone searching for a protocol learned only that it wasn't there. Four
  entries at launch — Templar, K2's two sub-floor markets, and Nectar — each backed by an
  investigation actually recorded in this repo. **Eight today**: the oracle-legibility precondition
  added the four Blend V2 markets whose oracles cannot be graded (Orbit, Forex, Spectra PTs, Solv), under a status of their own
  rather than folded into the size floor, because their exclusion has nothing to do with their size.

  Three properties are load-bearing. **Nothing in the section renders a numeral**, so "not scored"
  cannot be misread as "scored badly" — the chip standing where a scored row has its number is a
  phrase in the same neutral grey the never-scored state already uses, never a band colour. **The
  entries are unranked and structurally separate** from the ranked table, because a row inside a
  ranked list participates in the ranking claim even with a dash in its rank column. And **a reason
  resting on a measurement carries the date it was read** — `$3.62` is a reading, not a property,
  and an undated balance indexed by a search engine becomes a standing claim.

  It lives in `dashboard/app/lib/coverage.ts` — a static leaf module, deliberately **not** the
  `protocols` table. A row there with no history already renders as "never run — a gap in our
  coverage", which is our-pipeline-hasn't-got-there-yet; putting a deliberate decision in the same
  place collides the two states the section exists to separate. It would also inject unscored ids
  into `GET /api/v1/protocols`, which consumers parse as the ranked leaderboard. The same records
  now ship from the separate additive `GET /api/v1/coverage` endpoint, with the live leaderboard
  used only to prevent an entry appearing as both scored and unscored. The API carries the full
  reason, verification path and measurement date, but no `safetyScore` key or JSON numeric value.

  Two things it is **not**: it is unrelated to the not-scorable _run outcome_ below (that is a
  registered market draining below the floor, and needs a breaking third `RunRecord` status), and
  it is not a criticism of anything listed — the section says so in its own words.

- **The registry is a search tool, not just a leaderboard.** Its primary job is someone looking up a
  protocol by name, and a ranked table plus a growing list underneath it did not do that job. It now
  carries **search, a status filter and a sort**, all in query params (`?q=…&status=…&sort=…`) so a
  filtered view is linkable and survives a reload. The control is a real `<form method="get">` that
  works with JavaScript off; the enhancement only debounces it. Nothing is filtered client-side —
  the page is a Server Component rendering from the URL, which is what keeps every reason, summary
  and status phrase in the server-rendered HTML where find-in-page and search indexing can reach it.

  **Sorting is where the ranking rule is enforced.** Default is score descending, because the ranking
  is what the registry _is_ — making it opt-in would demote the product's only claim to a display
  option. Unscored entries never enter the ranked ordering: under either score sort they are a
  separate block below, grouped by coverage status. **Name sort is the one exception** and may merge
  both kinds into one list, because alphabetical order asserts no ranking. Two consequences fall out
  and are worth stating: the **position numeral only exists under score-descending** (under
  score-ascending row one is the _lowest_ score, so "01" would assert the reverse of the truth; under
  name it is alphabetical and means nothing) — and it is removed, not blanked, since a dash in a rank
  column is the same ambiguity as a dash in a score column. The ordering lives in
  `dashboard/app/lib/registry-query.ts` as pure functions precisely so "does an unscored entry ever
  land inside the ranked list" is a question a test can answer.

  **A third state got its own block**: a `protocols` row with `safetyScore: null` is our pipeline not
  having produced a number — neither rankable nor a coverage decision. It sits under "Awaiting a
  first score", after the ranked table and firmly out of the coverage section.

  **Which filters exist, and the trigger for each one that doesn't.** Only `status` earns a control
  today (scored · assessed-not-scored · each coverage status). Three were considered and declined
  with a condition attached, so they get revisited rather than forgotten:
  - **`chain`** — when a second chain exists. Every entry is `stellar`, so today it is a control with
    one option.
  - **`deployedOn`** (market vs independent protocol) — **when three or more entries carry it.** It
    is the strongest candidate, since the distinction is the whole reason `deployedOn` exists and it
    grows with every pool. Etherfuse took it from one entry to **two**; the trigger is unchanged and
    is now one pool away.
  - **freshness / failed last run** — not planned. The failed-run accent rule on the row already _is_
    the scanning affordance, over a set small enough to scan.

  Search matches name and id only. Matching `deployedOn.host` is deliberately excluded until a row
  can say _why_ it matched: "blend" surfacing YieldBlox with no visible reason implies YieldBlox is
  Blend, which is exactly what the deployment label exists to deny.

- **Every unscored entry has its own page, at `/coverage/<id>`.** The registry row is compact and
  links through; the full reasoning, the contract where we read one, the verify path and the date
  live on the page. The route is **not** `/protocol/<id>`, and that was the deciding constraint:
  that path would either render ids the API 404s on — the dashboard-vs-API divergence `lib/api.ts`
  exists to prevent — or force `getProtocolDetail` to serve a second, scoreless shape, which is the
  same divergence moved inside one function. `/coverage/<id>` is served entirely from the static
  coverage module and never touches that path. It also matches the `/api/v1/coverage` endpoint filed
  below, so if that ships, path and payload agree instead of colliding.

  **The URL is the disclaimer** — `/coverage/templar` says this is a page about Stenion's coverage of
  Templar, which is what it is. What makes it unmistakable on the page is not a label but the
  _absence_ of the four things a score page is made of: no score ring, no factor grid, no history
  chart, no run list. It states the negative outright in its first line ("no safety score — not a low
  one, not a zero"), renders no numeral where a score would be, and uses no band colour anywhere.
  A deep link to an entry the board has since scored redirects to `/protocol/<id>`, so the dedupe
  invariant holds for links as well as for the registry; `/coverage` with no id redirects to the
  registry filtered to those entries.

- **Sharding the registry across cron invocations.** The five-target ceiling was a per-_invocation_
  ceiling, and it still is; what changed is that the registry no longer has to fit in one
  invocation. `POST /api/cron/run-indexer?shard=<i>&totalShards=<n>` scores one shard, `n`
  cron-job.org jobs cover the registry, and `cycleFeasibility()` is evaluated against each shard's
  own subset — so `n` shards carry `5n` targets.

  **Freshness is NOT the cost, and this roadmap previously said it would be.** The entry that
  tracked this blocker costed sharding as "a five-minute cadence over three shards is a
  fifteen-minute worst case per market", and that is true of the shape it assumed — one job
  rotating through subsets on successive invocations. The shape that shipped is `n` **separate
  jobs, each every 5 minutes, staggered by a minute**. Every target is still scored every 5
  minutes, so `STENION_HEALTH_STALE_MINUTES` and `STENION_ALERT_THRESHOLD` keep their meanings and
  nothing had to be retuned. The staggering is load-bearing rather than tidy:
  `STENION_CYCLE_CONCURRENCY` bounds parallel targets _within_ an invocation and cannot see another
  invocation, so simultaneous shards would reproduce the concurrency-2 `429` incident from a
  direction the config does not control.

  **Assignment is a balanced deal, not `hash % n`, and that was the one real decision.** Targets
  are sorted by `(hash(id), id)` and dealt round-robin, which keeps shards within one target of
  each other — the property that makes `n` shards worth `5n` slots. The alternative that keeps a
  target's shard a function of its own slug alone was measured against this registry and rejected:
  today's five slugs land **4 and 1** across two shards. The cost of the balanced deal is that
  registering a target can move an existing one between shards, which is safe here for a specific
  reason — **nothing is keyed by shard.** Streaks are derived per protocol from `risk_scores`
  (`alerts.ts`, "WHY DERIVE"), so a move cannot reset or double-count one; `cycle.test.ts` pins
  that a target reaches a byte-identical alert decision sharded and unsharded.

  **Alerting is one POST per shard invocation** where it was one per cycle — an RPC-wide outage now
  reads as `n` messages covering disjoint target sets. Weighed and accepted; it also relieves the
  `MAX_MESSAGE_CHARS` truncation `alerts.ts` documents.

  Job table, staggering, and the full reasoning:
  [`architecture/deploy-architecture.md`](architecture/deploy-architecture.md) "Sharding the
  registry across invocations". **The mechanism is shipped; the capacity is not bought until the
  extra cron-job.org jobs exist**, which is infra config outside this repo.

- **The full stack:** on-chain adapters → indexer → Postgres → API → dashboard, deployed as a single
  Vercel project with external (cron-job.org) scheduling. See [`architecture/index.md`](architecture/index.md).

## Planned

Roughly in priority order, but not committed to dates. **The first item gates every other item that
adds a market** — it used to be a hard blocker with no mechanism behind it; it is now a matter of
provisioning the shards that sharding made possible.

- **Register more markets — the mechanism exists, the jobs do not yet.** Sharding shipped (see
  "Shipped" above), so the registry ceiling is now `5 x <number of cron-job.org jobs>` rather than a
  flat five. Nothing further is registered yet, because buying the capacity means adding those jobs
  in the cron-job.org dashboard — infra config outside this repo, with the job table in
  [`architecture/deploy-architecture.md`](architecture/deploy-architecture.md).

  **The per-shard five is unchanged and still pinned by measurement.** Within one invocation,
  `ceil(targets / concurrency) * STENION_ATTEMPT_TIMEOUT_MS <= STENION_CYCLE_BUDGET_MS` still holds
  at 50,000ms / 10,000ms / concurrency 1, and all three dials are where the deployed measurements
  put them:

  | Dial                         | Where it is | Why it has not moved                                                                                                                                                                                                                                                                       |
  | ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `STENION_CYCLE_BUDGET_MS`    | 50,000      | 60,000 is the `maxDuration` ceiling itself, so the next step up is the cliff. Sharding is what replaced raising it.                                                                                                                                                                        |
  | `STENION_CYCLE_CONCURRENCY`  | 1           | Shipped at 2 and reverted the same day when `mainnet.sorobanrpc.com` started refusing the target behind the burst. Raising it needs a **deployed** RPC-tolerance measurement, never an estimate.                                                                                           |
  | `STENION_ATTEMPT_TIMEOUT_MS` | 10,000      | The 2026-08-30 reading makes a case for lowering it — the slowest healthy attempt is kinetic at 5.5s — but `DEFAULT_RATE_LIMIT_POLICY` spends up to 2,000ms of that cap waiting out `429`s, leaving thinner margin than the durations suggest. Its own decision, with its own measurement. |

  So the honest answer to "can you score X?" is now **yes, once there is a job for its shard** —
  which is what `coverage.ts`'s `awaiting-capacity` status says on the registry for the 339
  Aquarius markets in that position. See
  [`architecture/deploy-architecture.md`](architecture/deploy-architecture.md) for the deployed
  measurements behind every number above.

- **More protocol adapters.** The open contribution path (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).
  The bar for a new **adapter** is unchanged: an _independently-scoreable native-Soroban lending
  protocol_ — not a deployment whose lending state lives on another chain, and not something that
  turns out to be a Blend pool.

  What changed is what happens when it _is_ a Blend pool. That is no longer a dead end: it is a
  `BLEND_POOLS` entry with a `deployedOn` label, which costs one config block and no scoring code.
  The two paths must not be confused — a Blend market gets a pool entry, never an adapter of its
  own, because an adapter would duplicate a rulebook that is already shared.
  - **Nectar Network — watching for mainnet.** Flagged as the next protocol to evaluate once it's
    live on Stellar mainnet. Not built yet, and won't be until we can confirm from its own contracts
    that it's an independently-scoreable native-Soroban lending protocol (reserves/utilization/oracle
    readable via Soroban RPC + Horizon) rather than another Blend pool or another-chain deployment.

- **A longer history window (raising the 50-row detail cap).** `GET /api/v1/protocol/:id` returns
  the newest 50 runs, which at the current 5-minute cadence is about four hours. That is enough to
  show _an_ event and not enough to show a _pattern_, and the difference is load-bearing: K2's
  oracle freshness cycle produced two "fresh" episodes in 65 hours of observation, 9.3 hours apart,
  so a four-hour window usually renders a flat line and at best catches one excursion that reads as
  a one-off. Roughly 24 hours (~290 rows) is where a repeating cycle becomes legible as repeating.
  Wanted, but it is a payload-size and query-cost decision on free tiers, not a UI tweak — likely a
  separate downsampled endpoint or a `?window=` parameter rather than simply raising the cap, since
  the detail response is already the largest thing the API serves.
- **K2 multi-market targeting — available, deliberately unused.** K2 deploys markets the way
  Blend's factory deploys pools: separate router contracts running byte-identical code. Three are
  live on mainnet (all wasm `df2831cf…`, sharing one oracle, one `PADMIN` and one treasury, each
  with its own configurator):

  | Router      | What                                                   | Reserves                  | Supplied |
  | ----------- | ------------------------------------------------------ | ------------------------- | -------- |
  | `CCTUJZLY…` | K2's primary pooled market — **the `kinetic` entry**   | USDC, XLM, PYUSD, SolvBTC | ~$1,781  |
  | `CCGXGXIL…` | SolvBTC / xSolvBTC isolated market, K2-listed          | SolvBTC, xSolvBTC         | $3.62    |
  | `CDWPVHKB…` | Earn (earnUSDC/USDC), third-party, run by Gami/Upshift | USDC, earnUSDC            | $0.00    |

  **The refactor is not needed to register them — the floor is.** `KineticAdapter` already takes a
  `routerId`, exactly as `BlendAdapter` took a `poolId` before the multi-pool change, so
  generalising it to a `KineticMarket` config would be the same shape of work and is available the
  day a market qualifies. It is **not built**, because neither additional market clears the
  [market-size floor](methodology/lending.md#the-market-size-floor) and building it now would be dead code
  guarding an empty list.

  **What K2's own market types turned out to be**, since the docs and the chain do not agree on
  this and it is the question that started the survey:

  - **Pooled vs isolated is Aave-V3 configuration** — the router wasm carries `IsolationModeData`,
    `isolation_mode_enabled`, `UserInIsolationMode` and `get_reserve_debt_ceiling`, all per-reserve
    settings inside one pool. **K2 does not use it that way:** every reserve on all three routers
    reports `debt_ceiling = 0`, and the isolated market was given its own router instead.
  - **Third-party markets are genuinely separate contracts**, and K2 says so: "Isolation is enforced
    at the contract level: collateral and debt in a third-party market cannot be combined with
    positions in K2's primary market."
  - **"Gated" — not found, and not asserted absent.** No market type by that name appears in the
    router's exported interface or in any documentation page reachable from
    `docs.k2lend.com/llms.txt`, which calls that section **Third Party Markets**. The nearest
    on-chain machinery is per-reserve allow/deny lists (`RWLMAP`/`RBLMAP`,
    `get_reserve_whitelist`, `is_whitelisted_for_reserve`) — router configuration, not a separate
    contract. If the term is current somewhere not reachable from that index, this is a gap in what
    was read, not a finding that no such thing exists.

- **A not-scorable run outcome, distinct from a score of 0.** The
  [market-size floor](methodology/lending.md#the-market-size-floor) is currently enforced **only by the
  decision not to register a market below it** — nothing in `Adapter`, the indexer or `RunRecord`
  can express "this market is not scorable" as distinct from "this market scored 0". So a
  registered market that drained below the floor would keep publishing a number computed from five
  can't-assess branches, which is the exact failure the floor is written against.

  The representation already exists at the far end: `safetyScore: null` is the never-scored state,
  documented in [`api-docs/index.md`](api-docs/index.md) and rendered as an em dash rather than a zero. What is missing is
  a path to reach it deliberately. That is a third `RunRecord` status alongside `ok`/`failed` — and
  a `failed` row is the wrong home for it, because a market that is empty has not failed: the
  adapter read it perfectly and the answer is that there is nothing to score. A new status touches
  the DB CHECK constraint, the `ok`/`failed` union every API consumer parses (a **breaking** change,
  so `v2` under the versioning policy), and the score chart's break rendering. Filed rather than
  slipped in.

- **The Kinetic / K2 naming mismatch.** The protocol rebranded to **K2** (k2lend.com). Stenion still
  displays `name: 'Kinetic'`, and now shows it beside the K2 mark — the logo work made an existing
  inconsistency visible rather than creating it. Renaming isn't cosmetic: `id: 'kinetic'` is the
  `protocols` primary key, the `risk_scores` foreign key, the public URL `/protocol/kinetic`, and
  the `GET /api/v1/protocol/:id` path any external consumer has hardcoded. Changing the slug is a
  breaking API change (a `v2` under the versioning policy in [`architecture/index.md`](architecture/index.md));
  changing only the display `name` is free and additive. Almost certainly the latter, but it should
  be a decision rather than a drift.
- **Per-factor history.** `risk_scores` stores the full factor map on every row, so the data is
  already there, but the API exposes only `safetyScore` per history point. Charting a single
  factor over time — watching `oracleSafety` sawtooth on its own axis — is deliberately deferred
  until the window question above is settled, because it multiplies the same payload by five.
- **Concurrent targets within a cycle — DONE.** The indexer no longer runs targets
  sequentially and no longer divides one budget between them. `STENION_CYCLE_CONCURRENCY` targets
  (default 2) run through a bounded worker pool, and each target's deadline is the end of
  `STENION_CYCLE_BUDGET_MS` minus one full attempt reserved for each wave still queued behind it.

  **What was actually wrong.** Under the old rule the first target's share was
  `STENION_CYCLE_BUDGET_MS / targetCount`: 14s at three targets — already below the 15s
  `STENION_ATTEMPT_TIMEOUT_MS` — and 10.5s at four, which is **below the healthy fetch duration of
  Kinetic (7.7–10.5s) and YieldBlox (8.1–12.5s), both already live**. Registering a pool could
  silently fail protocols that worked the day before. (Those durations are developer-machine
  figures, which is what was known at the time. The deployed function has since been measured at
  2.3–6.1s per target — see [`architecture/index.md`](architecture/index.md) — so the _margin_ was wider than it
  looked, but the shape of the bug was not: a deadline that shrinks as the registry grows is wrong
  whatever the constants happen to be.) The two obvious fixes both fail: the budget
  cannot be raised past Vercel Hobby's `maxDuration = 60`, and lowering the attempt timeout moves the
  cutoff earlier rather than removing it.

  **A fixed per-target floor with a shared overflow pool was costed first and rejected on
  arithmetic.** Any guaranteed floor `F` in a sequential loop needs `N × F <= budget`. At four
  targets `4 × 12s = 48s > 42s`, so the floor cannot be honoured at all — and 12s does not clear the
  12.5s slowest observed healthy fetch anyway, so the principled floor is 15s, which caps a
  sequential loop at **two** targets. It could not have unblocked a fourth target; its one good idea,
  an explicit checkable condition, survives as `cycleFeasibility()`.

  **The ceiling is now explicit:**
  `ceil(targets / concurrency) * attemptTimeoutMs <= budgetMs` — **five** targets at today's shipped
  defaults, failing at six, logged as a `[budget]` warning naming the numbers and the levers rather
  than discovered by someone adding a pool. Past it, behaviour degrades to whole attempts first-come
  with the tail failing cleanly and visibly on `/api/v1/health`, not a squeeze for everyone.

  **That ceiling has since been reached.** Registering the fifth target — the first dex market —
  raised the budget 42s → 50s to fit it, which was the last raise available under the 60s `maxDuration`. The registry
  is now full — see **the blocker at the top of this section**, which is where the exit from it is
  tracked.

  **The RPC-load cost — and the estimate that was wrong.** Both adapters are strictly sequential
  internally, so one target in flight is one request in flight. Total requests per cycle are
  unchanged whatever the concurrency (~58 across three targets), and unbounded fan-out was rejected
  because it makes the peak a function of registry size.

  What this entry originally claimed — that concurrency 2 moves the rate from ~2.3/s to ~4.5/s — was
  **wrong**, because it divided the request count by developer-machine durations. The deployed
  function is 2-3x faster, so wave 1 actually runs at ~11 requests/second, and
  `mainnet.sorobanrpc.com` (free, shared, keyless) started refusing the target behind the burst:
  **0 failures in 102 pre-deploy target-runs, then 4 of 8 cycles for Blend in a clean post-deploy
  window.** Shipped concurrency was reverted to **1** the same day, with
  `STENION_ATTEMPT_TIMEOUT_MS` lowered 15s → 10s alongside so a single-worker cycle stays feasible to
  four targets. Full incident, numbers and reasoning in [`architecture/index.md`](architecture/index.md).

  The durable lesson, and the reason the incident record is kept: **measure the deployed function;
  never compute an RPC-load claim from developer-machine timings.**

  **Ordering flipped with it.** Targets now run slowest-first (YieldBlox → Kinetic → Blend), because
  under a worker pool longest-processing-time-first minimises the makespan. Fastest-first was correct
  only under the division rule that has been removed. An unmeasured target sorts first, i.e. is
  assumed slowest.

  **Resolved by sharding**, which shipped: the budget-and-concurrency ceiling is per invocation,
  and the registry is now split across several. See the sharding entry under "Shipped".

- **An `AbortSignal` through `Adapter.fetchRawData`.** The per-attempt timeout is currently _soft_ —
  it races the attempt against a timer and abandons the loser rather than cancelling it, because no
  adapter accepts a cancellation signal and Node's `fetch` has no default timeout. That bounds the
  observed attempt duration, which is what the retry budget needs.

  **Abandoned sockets are harmless only under serverless**, where the invocation ends and takes them
  with it. `@stenion/indexer` also ships a long-lived standalone loop (`node dist/index.js`,
  `setInterval`), and there an abandoned attempt is a real leak: the socket and its parsed response
  stay alive with nothing waiting on them, accumulating one per timed-out attempt for the life of the
  process. Nothing runs that way in production today, which is why this is filed rather than fixed —
  but a move to a long-running host makes it a genuine bug, not a tidiness item.

  The fix is a breaking `Adapter` interface change (an optional `signal` on `fetchRawData`, threaded
  to every RPC and Horizon call in both adapters), so it goes through `ADAPTER_INTERFACE_VERSION`
  rather than being slipped in.

- **A typed `PermanentAdapterError` in `@stenion/core`.** The indexer deliberately does **not**
  distinguish transient failures from permanent ones, and retries everything. Today every adapter
  failure is a bare `new Error(string)` with no typed error and no preserved status code, so the only
  available classifier is regex over message text — which drifts silently the moment a message is
  reworded, and drifts _toward retrying nothing_, a failure nobody would notice. It would also buy
  little: structural failures (a missing storage key, a malformed decode) throw fast, while the slow
  failures are exactly the transient ones, so classification saves budget precisely where budget is
  not at risk.

  If it is ever wanted, the clean path is a typed error exported from `core` and thrown by adapters
  at their structural-decode sites, checked with `instanceof` — never string matching. That touches
  `core` and every adapter, so it is a deliberate change, flagged here rather than guessed at.

- **Alerting on infrastructure failure, not just protocol failure.** A total database outage is
  currently silent on the alerting path: no run row is written, so no streak advances and no alert
  fires — and the streak query would fail too. It surfaces as the cron route returning 500, which
  nothing watches. Naming what the alerting does _not_ cover matters as much as what it does; closing
  it means a second, differently-shaped signal (the cycle could not run at all, as distinct from a
  protocol that could not be scored), which is a separate feature rather than a wider threshold.
- **Scam / fake-asset warning API.** A real-time, queryable warning layer for wallets, built on top
  of [StellarExpert](https://stellar.expert)'s existing scam directory. A secondary feature, not the
  core pitch — but a natural fit for the "read the chain, warn users" mission.
- **Protocol self-service.** Let protocols claim their entry, read their factor breakdown, and
  challenge a threshold through a defined process — without ever being able to buy a better number.
  - **Which way the logo/links metadata leans, decided in advance.** `logo`, `contract_id`,
    `site_url` and `docs_url` are written from adapter metadata on **every** indexer cycle, so
    anything a protocol edited directly would be reverted within ~5 minutes. That is the correct
    default while these are maintainer-managed and reviewed in a PR. If self-service ships, a
    protocol-supplied mark must go in **separate columns that take precedence at read time** — not
    as an edit to these, and not by softening the upsert to preserve whatever is already there,
    which would quietly remove our ability to correct a protocol's own metadata. Presentation of a
    supplied mark shouldn't change: the same tile, the same attribution note, and no path by which
    a nicer logo touches a number.
- **Premium tiers.** Paid _visibility_ (a clearly-labeled, visually-separate "Spotlight" section),
  _speed_ (faster refresh), and _private tooling_ — never a paid score. The real registry stays free,
  public, and ranked purely on score. This is the intended business model, kept strictly walled off
  from the number.
- **AI explanations.** Plain-language summaries of _why_ a protocol scores the way it does, generated
  from the real underlying factor data. AI **only explains** — it never generates an independent risk
  assessment or sets a score.
- **Methodology v2 candidates** (breaking taxonomy changes, so deliberately not rushed — any of
  these would be the first version bump):
  - **Market-depth-aware oracle scoring.** Shipped v1 grades whether a price bound _exists_, not how
    cheap the underlying market is to move — and thin depth is what made the YieldBlox manipulation
    cost ~$5. SDEX depth is readable from Horizon, but order books are trivially spoofed with walls
    that are never hit, it only applies to DEX-priced assets, and it can't be validated
    retroactively because the exploited market has since been rebuilt. Wanted, not yet shippable on
    a defensible anchor. (Several other candidates — TWAP, provider identity, source counting, and a
    Stenion-computed deviation — were investigated and **rejected**; the reasoning is recorded in
    [`methodology/index.md`](methodology/index.md) §2 so they aren't re-proposed.)
  - **Beyond lending: a taxonomy per protocol category.** The five `*Safety` factors are
    lending-specific by design — utilization against a borrow cap and liquidity headroom for
    withdrawals don't mean anything for an AMM. Scoring other categories means designing a taxonomy
    that fits how each one actually fails, not stretching the lending model over them:
    - **DEXs / AMMs** (Soroswap, Phoenix, Aquarius) — **SHIPPED for Aquarius: rulebook complete
      (one review admitted the factor set, a second reviewed the weight table) and one market
      registered and scored.** See [`methodology/dex.md`](methodology/dex.md). The `dex` category is
      versioned at 1 on its own counter and published in full — **two** factors: `adminKeySafety` at
      **0.55** (seven named roles plus the two-step upgrade deadline, sharing lending's factor key
      deliberately) and `assetControlSafety` at **0.45** (whether a SAC issuer can freeze or claw
      back what the pool holds), each with its formula, its thresholds and a worked example computed
      from a captured mainnet fixture. **No size floor exists and none is pending** — neither factor
      is size-sensitive, so there is nothing for one to protect.

      **What is covered: one Aquarius market, `aquarius-xlm-usdc`.** The XLM/USDC constant-product
      pool (`CA6PUJLB…`), scoring **24** — `adminKeySafety` 10, `assetControlSafety` 40 — and
      carrying `category: 'dex'` and `methodology_version: 1` on every run. It renders as its own
      ranked block on the registry, numbered 01 of dex, because a position numeral is scoped to one
      rulebook, and this is the first time that rule has had two categories to enforce it against.

      **What is NOT covered: the other 339 Aquarius pools, and every other DEX.** The census, re-read
      at ledger 64,182,824 on 2026-08-29, is 340 pools across 304 token sets — 272 constant-product,
      42 stableswap, 26 concentrated, of which 46 hold zero in every reserve. Every one of them is
      **scorable**; 339 are unregistered because the indexer has five target slots and four were
      already lending. That is a capacity statement and it is published as one, through
      `coverage.ts`'s `awaiting-capacity` status. Soroswap and Phoenix are separate investigations
      needing their own contract reads, and are deliberately **not** listed as `out-of-category` —
      that status means "no rulebook exists", which is no longer true of a DEX.

      **The registry ceiling is now the deploy, not the rulebook, and it is a tracked blocker.**
      `cycleFeasibility()` requires `ceil(targets / concurrency) * attemptTimeoutMs <= budgetMs`; at
      concurrency 1 and a 10s attempt timeout that is five targets against the 50s budget, and a
      sixth would need 60s, which **is** Vercel Hobby's `maxDuration`. So a second dex market cannot
      be bought with a bigger budget — and neither can anything else, of any category. That is the
      blocker at the top of this section; the deployed measurements the 42s → 50s raise was made
      against are in
      [`architecture/deploy-architecture.md`](architecture/deploy-architecture.md).

      **The `Adapter` interface change that shipped unreviewed has been reviewed, and revised.** It
      added a third type parameter, `TFactors`, to make the first non-lending adapter compile at all,
      and flagged the decision as unreviewed. The review found the parameter was never tied to `TCategory`
      — `Adapter<Raw, 'dex', RiskFactorMap>` compiled, so a dex adapter could publish lending's five
      factors, and so could one with invented keys. The factor map is now **derived** from the
      category, `FactorMapFor<TCategory>`, read straight out of `CATEGORY_FACTORS`, so an adapter
      cannot disagree with its own rulebook. `ADAPTER_INTERFACE_VERSION` is **4**. The four frozen
      lending snapshots and both lending adapters are byte-identical either side of it. Decision
      record, with the two claims it corrects, in
      [`architecture/monorepo-layout.md`](architecture/monorepo-layout.md).

      **`@stenion/db` now carries any category's factor map.** `RunRecord.factors`,
      `ProtocolDetail.factors` and `HistoryEntry.factors` are `FactorMap`, and
      `getProtocolDetail`'s read-side cast asserts only the non-null the `risk_scores_shape` CHECK
      guarantees — it used to assert lending's five keys, which would have handed `undefined` to
      anything reading `.oracleSafety` off a dex row. Storage was always key-agnostic; the types
      were the lie. Proven by a `dex` write/read round-trip through a real Postgres in
      `store.integration.test.ts`, not through `JSON.stringify`.

      **A third factor, `depthSafety`, was proposed and deferred** — the pool's own `estimate_swap`
      simulation, which is the strongest read available and still cannot ship. Aquarius publishes no
      unit of value, so there is nothing to denominate a trade size in: a pool-relative size is a
      closed form that does not contain the reserves, so all 272 constant-product pools at one fee
      tier would score identically, and an absolute size would be a number Stenion chose rather than
      one the chain states. Deciding it now would also be **irreversible** — a published depth
      denomination becomes what stored scores mean, and history is never backfilled across a bump —
      whereas adding the factor later is additive and lands as a labelled version bump. Revisit when
      a second dex protocol exists to calibrate against, rather than designing a category rulebook
      around one protocol's shape.

      The consequence is stated in the rulebook rather than left implicit: a `dex` score is a
      **governance-and-asset-control** score, not a liquidity score.

      Two of the three candidates named here when this bullet was written were **rejected on
      measured grounds**, and the reasoning is in `methodology/dex.md` so they are not re-proposed.
      _LP concentration_ fails Gate 8 outright — the Aquarius LP share token is a plain SEP-41
      contract with no holder enumeration and no holder count, so the distribution is only
      recoverable from an off-chain event indexer. _Price divergence from reference markets_ fails
      for the same reason market-depth-aware oracle scoring does above: an AMM's price legitimately
      differs from SDEX by the fee plus un-run arbitrage, so a divergence reading cannot separate a
      real problem from a normal one. Only _liquidity depth against realistic trade size_ survived,
      and it survived because the pool's own contract computes it.

    - **Yield vaults** (DeFindex, Wellspring, Hoops Finance) — strategy transparency, underlying
      protocol exposure (a vault routing into Blend inherits Blend's risk), withdrawal liquidity.

    Each is a v2 project in its own right: a new taxonomy, designed and published to the same
    standard as the lending one, before any adapter is written. **That standard is written down:**
    [`TAXONOMY.md`](TAXONOMY.md) is the admission bar a category has to clear, stated as gates a
    reviewer checks off against a submission, with a pre-flight checklist at the end. Lending stays
    the priority until its own methodology is settled — an unvalidated oracle-robustness factor is a
    bigger problem than an unscored category.

    **The registry is already ready for the second one.** Two `safetyScore`s are comparable only
    when the same rulebook produced them, so `buildRegistryView` publishes one ranked block per
    category — each numbered 01..n within itself — and carries no flat ranked array for a
    cross-category ordering to live in, with a `?category=` filter on the same param pattern as
    `?status=`. With one category on the board that renders exactly what it always did, which is
    asserted rather than assumed. So a new taxonomy lands as a rulebook plus an adapter; it does
    not also arrive as a ranking bug.

- **Per-sub-reading carry-forward across cycles — raised and deferred, `2026-08-30`.** When a read
  fails for a reason that is about Stenion rather than about the protocol (an exhausted `429`, a
  dropped connection), the cycle now records a **failed run** and the previous score stands with its
  staleness advancing — see [`methodology/dex.md`](methodology/dex.md) § "A rate limit is not a
  reading". The alternative considered was to keep scoring the protocol and carry forward only the
  sub-reading that failed. It was **not** taken, and the reason is a real design question rather
  than effort: `risk_scores` stores outputs only, never the raw inputs a run was computed from, so
  there is nothing to carry forward without a new persistence layer for per-sub-value state — and a
  score assembled from two cycles' readings would be a fourth way to publish a fact, beside the
  three [`methodology/publishing-rules.md`](methodology/publishing-rules.md) defines. Neither is
  something to decide inside a bug fix. It stays open, and the current behaviour is honest in the
  meantime: a failed run says we did not learn anything about that protocol on that cycle.

## Out of scope (for now)

- **Multi-chain.** Stenion is deliberately Stellar/Soroban-only. The non-negotiable rule that
  adapters read directly from trustless Stellar infra (Soroban RPC + Horizon) is core to the pitch —
  expanding to read another chain's state (e.g. to score a NEAR-based protocol like Templar) would be
  a category change to the whole trustless-Stellar positioning, not an incremental feature.
- **TVL tracking.** [DefiLlama](https://defillama.com) already covers TVL for Stellar. Stenion's
  differentiator is continuous _risk_ scoring, not another TVL dashboard.
- **Any paid mechanism that touches the score.** Not a "not yet" — a permanent no.

## Protocols investigated and skipped

Confirming a protocol is _not_ in scope from its own contracts — before writing scoring logic — is
part of the discipline, not a failure. Four notable cases:

> **These decisions are now published on the site**, in the registry's "Assessed, and not scored"
> section, sourced from `dashboard/app/lib/coverage.ts`. This section keeps the _narrative_ — how the
> decision was reached and what it cost; the module holds the _published record_ a visitor reads.
> Neither restates the other, so a change to what we concluded belongs in both, at the same review
> bar. A protocol listed here that is **not** in that module is a deliberate omission, not an
> oversight: an entry needs a `verify` path and, for anything resting on a balance, a date. Figures
> we never checked against contracts don't qualify — which is why some things skipped early in the
> project's life appear in neither place.
>
> **Meru is omitted for a different reason, and the distinction matters.** It clears both tests — it
> has a `verify` path and a dated reading behind it — and is still kept here only. That is an
> editorial call about what belongs on the registry, recorded explicitly so it is not later mistaken
> for an entry that failed the bar above.

- **YieldBlox — skipped as an adapter, then shipped as a pool.** Still not an independent Soroban
  lending protocol: the YieldBlox DAO adopted Blend as its backbone, and what exists today is a
  DAO-managed pool _on Blend V2_ running the identical Blend contract. So it never got an adapter —
  a "YieldBlox adapter" would just be `BlendAdapter` pointed at a different pool. The multi-pool
  refactor this entry anticipated has since landed, and the pool is now a registered entry
  (`CCCCIQSD…`), scored by `BlendAdapter` and labelled a Blend V2 pool. The skip decision was never
  reversed — it is the reason the entry is a pool and not a protocol.
- **Four Blend V2 markets — scorable on four factors, declined on the fifth.** Orbit
  (`CAE7QVOM…`), Forex (`CBYOBT7Z…`), Spectra PTs (`CDZVHCO7…`) and Solv (`CC4HHXPK…`) all run the
  same pool wasm (`a41fc53d…`) Stenion already scores twice, and would otherwise be `BLEND_POOLS`
  config entries with no new scoring code. Their oracles are the problem: none publishes
  `max_age()`, `oracles()` or `asset_configs()` — the three reads `oracleSafety` is anchored to
  (METHODOLOGY.md §2e, "The oracle-legibility precondition"). Those are Blend's oracle-aggregator
  interface, not SEP-40, which defines no staleness tolerance and no deviation bound at all.

  **They are not one "non-aggregator shape", which is the finding that made this a rulebook
  decision rather than a patch.** Read out of each oracle's own wasm on 2026-08-26, they are four
  different contracts — a bridge (`a71a844e…`), a proxy onto a SEP-40 feed (`1d1c90d3…`), a
  deterministic zero-coupon-bond pricer (`4a444181…`) and a SEP-40 feed registry (`5700be21…`) —
  agreeing only on the column that decides it. So "support the other shape" was really "support
  four more shapes", each a separate reading of a separate contract's semantics.

  Both ways of scoring them anyway were rejected with numbers rather than on principle, and §2e
  records the working: substituting SEP-40's `resolution()` for the missing anchor rates Solv's
  6-hour-stale feeds as perfectly fresh, and dropping `oracleSafety` to a `null` factor would have
  published **Orbit at 71 — the top of the registry, twenty points above Blend Fixed** — while
  Admin-Frozen and 99.5% concentrated in a synthetic priced at a hardcoded 1.0. The second is the
  sharper failure: it pays a market _more_ for having an oracle we cannot inspect than YieldBlox
  gets for publishing a deviation bound and disabling it.

  Published instead in `dashboard/app/lib/coverage.ts` as `oracle-not-gradable`, one entry each with
  its own reading and date. **This is the one skip on this page a protocol can undo without any
  change here:** an oracle that starts publishing the two parameters makes its pool scorable under
  the existing rulebook, and the work is a `BLEND_POOLS` entry plus a deleted coverage entry in one
  PR. Etherfuse (`CDMAVJPF…`) was the fifth of the five and is _not_ on this list — it runs an
  aggregator, so it is scored, and it **is registered**: it is a ranked entry above, and the pool
  investigation is closed at one market registered and four published here.

  **The curation question that investigation raised is still open, and this pass did not close it.**
  Three of the five are tiny — read on 2026-08-26, Solv held $175.69, Spectra PTs $9.88, and Forex
  $504.17 in its one priceable reserve — and METHODOLOGY.md's market-size floor is explicit that it
  is a scorability test rather than a quality bar. All three are excluded by the oracle precondition
  regardless, so no curation judgment was needed to keep them out and the question was simply never
  reached. Etherfuse, at **$133,523.47** supplied on the same date, is not borderline under any
  plausible bar. Still flagged in METHODOLOGY.md, still resolved nowhere.

- **Templar.** A NEAR-based, chain-abstraction ("Cypher Lending") protocol. Its lending market state
  — reserves, supply/borrow, utilization, collateral positions — lives on **NEAR**, read via NEAR
  RPC. Stellar is only a wallet/collateral entry point via NEAR MPC. The only native-Soroban contract
  it ships is a price oracle, so just 1 of 5 factors is natively on Stellar. A faithful adapter would
  need to read NEAR, breaking the trustless-Stellar rule. Could only be represented if Stenion's
  model expands to read NEAR — see "Out of scope."
- **Meru.** Not a lending protocol at all — a Latin-American USDC wallet whose yield feature is a
  **DeFindex vault**. The only Meru-named contract on mainnet is `CCA2ZJP5…`, whose `METADATA` reads
  `DeFindex-Vault-Meru` / `MERU` and whose wasm (`ae3409a4…`) is byte-identical to the vault hash
  DeFindex publishes on its own mainnet-deployments page. Its single asset is USDC, deployed through
  two of DeFindex's _shared_ strategy contracts: "USDC Autocompound Blend Fixed"
  (`CDB2WMKQ…`, `Config.pool` = `CAJJZSGM…`) and "USDC Autocompound Blend YieldBlox"
  (`CCSRX5E4…`, `Config.pool` = `CCCCIQSD…`). Both of those pools are already registered, scored
  entries — `blend` and `yieldblox`.

  So this is neither the Templar reason nor the K2 reason. The vault held **18,686,143.05 USDC**
  (`fetch_total_managed_funds`, idle 0, all of it in the Fixed strategy — ledger 64069221,
  2026-08-22), three orders of magnitude _above_ the market-size floor, and every dollar of it sits
  inside pools Stenion already reads. A "Meru" entry would republish Blend Fixed's number under a
  second name. It also has no lending surface of its own to score: `get_reserve_list`,
  `get_reserves_list`, `get_config`, `oracle`, `get_reserve_data` and `get_positions` all fail
  against it with `WasmVm, MissingValue` — no reserves, no borrow side, no oracle, no utilization.

  Ruled out positively rather than from absence: every pool both Blend factories have ever deployed
  was enumerated from their `deploy` events — 11 on the V2 factory (`CDSYOAVX…`) and 17 on V1
  (`CCZD6ESM…`) — and none is named Meru. It is a depositor _into_ Blend, not a deployment of it.
  Nor is it a K2 router: different wasm from K2's `df2831cf…`, and K2's own docs list three markets
  with exactly one third-party operator, none of them Meru.

  Worth recording beside the K2 and YieldBlox documentation gaps: **Meru publishes no contract
  address anywhere.** No contracts page, no `/.well-known/stellar.toml`, no documentation site; its
  sitemap's 16 pages include `/defi/information/`, which names neither Blend nor DeFindex. DeFindex
  for its part publishes the factory, the vault wasm and the shared strategies, but not per-partner
  vault addresses. An $18.7M vault carrying a protocol's name therefore appears in no first-party
  published list and is reachable only from chain — which is why this took contract reads to settle
  rather than a reading of anyone's docs.

  To verify: read the instance storage of `CCA2ZJP5…` via Soroban RPC `getLedgerEntries` — `METADATA`
  names it and `["AssetStrategySet",0]` gives the strategy set — then read `Config.pool` out of each
  strategy's instance storage and compare against the pool ids in
  [`adapters/blend/`](adapters/blend). `fetch_total_managed_funds` on the vault gives the
  balance.
