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

That honesty has to survive the trip to the screen, so the UI never leaves a failed run as nothing
but an older timestamp. `dashboard/app/lib/format.ts`'s `freshness()` turns the pair into a tone, a
short label, and a full explanation; the registry row carries an accent rule plus a pill and caption,
and the protocol page carries a notice with both timestamps. **Freshness never borrows the score
bands** — `safe`/`warn`/`danger` mean risk level, so a stale marker in amber or red would report a
pipeline fault as a verdict on the protocol. `freshnessPillClass` uses the accent and the neutrals
instead, and `format.test.ts` asserts that mechanically rather than leaving it to review attention.

### How adapters read the chain: batched ledger entries

An adapter reads through two RPC methods, and they behave nothing alike. `simulateTransaction`
takes **one** transaction per call, so a contract getter is always one request. `getLedgerEntries`
takes **up to 200 ledger keys** per call — confirmed empirically against
`https://mainnet.sorobanrpc.com` on 2026-08-30, where 200 keys returns a well-formed result and 201
is refused outright with `-32602: key count (201) exceeds maximum supported (200)` rather than
silently truncated.

Adapters used to ignore that and issue one call per key: one per Blend reserve pair, one per
Aquarius reserve token, one per contract instance. `adapters/ledger-entries.ts` now collects a
target's keys and dispatches them together. Measured per target against mainnet, before → after:

| target            | reserves/tokens | `getLedgerEntries` calls | total RPC requests |
| ----------------- | --------------- | ------------------------ | ------------------ |
| blend             | 3               | 5 → **2**                | 14 → **11**        |
| yieldblox         | 8               | 10 → **2**               | 24 → **16**        |
| etherfuse         | 5               | 7 → **2**                | 18 → **13**        |
| kinetic           | 4               | 2 → **2**                | 27 → **27**        |
| aquarius-xlm-usdc | 2               | 4 → **1**                | 22 → **19**        |
| **whole cycle**   |                 | **28 → 9**               | **105 → 86**       |

**Kinetic is unchanged, and that is a property of the contracts rather than a gap.** Its only two
ledger-entry reads are the router's instance storage and the oracle's, and the oracle's address is
only learnable from the router's — the second key does not exist until the first call has returned.
Everything else Kinetic reads is a simulation, which has no batch form. It is also, at 27 requests,
the most expensive target in the registry: **batching does not touch the dominant RPC cost, which
is `simulateTransaction` volume.** Anything that materially lowers a cycle's request count from
here has to reduce simulations, not ledger reads.

Three properties of the endpoint drive the module's shape, all confirmed live rather than assumed:

- **An absent key is omitted from the response**, with no placeholder. So a response is shorter than
  its request whenever anything is missing, and demultiplexing is by the key the RPC echoes back —
  never by array position. `LedgerEntries` exposes no index accessor at all, so positional access is
  absent rather than merely discouraged.
- **A duplicate key fails the whole call**, opaquely (`-32603: could not query captive core … 404`).
  Deduplication is therefore a correctness requirement of batching, not an optimisation — one call
  per key could never collide with itself.
- **A failed call is a failed run.** A timeout or 429 throws out of `readLedgerEntries` and reaches
  the indexer's per-target try/catch unchanged. It is never degraded into "none of those keys
  exist", which would republish every optional-entry path as its absent case and turn a transport
  fault into a confident wrong reading.

**Cross-target batching is not implemented, deliberately.** Coalescing every registered pool's
reserve reads into one call is the larger win on paper, and it buys nothing at
`STENION_CYCLE_CONCURRENCY = 1`: the worker pool never has two targets in flight, so there is
nothing concurrent to coalesce. Making it possible would mean splitting `fetchRawData()` into a
collect-keys phase and a consume-entries phase — an `Adapter` interface change, and one that fights
the sequential dependencies every adapter has (a pool's oracle address comes out of its instance
entry; a pool's token addresses come out of a simulation). It is a design question of its own, and
it should be revisited only if concurrency is raised.

### Rate limiting: retried in place, and never mistaken for a broken protocol

A `429` from the shared public RPC is a fact about our path to the endpoint, not about the protocol
being scored. Recording it identically to a changed contract interface is what makes an alert stop
meaning anything, so the pipeline separates the two — and separates both from a target that merely
had to wait.

**Two retry layers, doing different jobs.** `indexer/src/retry.ts` retries a whole TARGET: it re-runs
`fetchRawData()` from the first request. That is right for "this protocol's read failed" and wrong
for "request 15 of 20 was refused" — re-running reissues the fourteen requests that already
succeeded, costs a full extra attempt, and raises the very request rate that caused the 429.
Measured on the deployed cron route on 2026-08-30: three targets failed with
`Request failed with status code 429` after `attempts: 3`, i.e. the target-level retry ran three
times and was rate-limited every time. `core/src/rate-limit.ts` plus `adapters/rate-limit.ts` add a
second layer that retries only the ONE call that was refused, in place.

**Only a 429 is retried.** A malformed response, a simulation error, a decode failure, the
oracle-legibility verdict and an attempt timeout all propagate on the first throw, exactly as
before. Detection is on the status the server sent, never on the error's class (minified in the
dashboard bundle) and never primarily on message text:

| transport                            | how a 429 arrives                                                                                                         | detected by                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Soroban RPC (`@stellar/stellar-sdk`) | **throws** an AxiosError, `message: "Request failed with status code 429"`, `code: ERR_BAD_REQUEST` (shared by every 4xx) | `error.response.status === 429`                          |
| Horizon (plain `fetch`)              | **resolves** with a `Response`, `status: 429`, `Retry-After` header                                                       | `response.status === 429`, converted into the same shape |

Both confirmed empirically on 2026-08-30 against a loopback server, and the RPC message string
matches what the deployed run summary recorded.

**The schedule fits inside `STENION_ATTEMPT_TIMEOUT_MS`; it does not extend it.**

```
attempt cap                                  10,000 ms
slowest healthy attempt (kinetic, deployed)   6,363 ms
headroom                                      3,637 ms

schedule      250 ms -> 500 ms -> 1,000 ms   (<=3 retries for any one call)
attempt caps  <=4 retries total, <=2,000 ms asleep total
worst case    2,000 ms sleeping + 4 x 235 ms retried calls = 2,940 ms
              6,363 + 2,940 = 9,303 ms       — 697 ms of margin
```

The budget is **per attempt, not per call**: a target makes 11–27 requests, and per-call budgets
would let a handful of refusals walk straight through the timeout. It is carried from the indexer
into the adapters through an `AsyncLocalStorage` scope rather than a parameter, because a parameter
would mean changing `Adapter.fetchRawData()` across core and every adapter, and a module global
would have two concurrent targets silently spend each other's allowance the day
`STENION_CYCLE_CONCURRENCY` is raised.

It is also **deadline-aware**, which is the structural half of the guarantee: a retry is started only
when the sleep plus a call worth making both fit before the attempt ends. So a persistently-429ing
endpoint runs out of rate-limit budget _before_ the attempt timeout fires, and fails as
`RateLimitExhaustedError` naming the 429s rather than as a generic
`attempt exceeded its 10000ms time budget`. That ordering is the whole point of capping the retries
low — the cap is not caution, it is what keeps the failure legible.

**Three outcomes, told apart** (`CycleRunResult`, returned by the cron route):

| outcome                 | `status` | fields                                       | alert path                                               |
| ----------------------- | -------- | -------------------------------------------- | -------------------------------------------------------- |
| clean success           | `ok`     | neither field present                        | not reached                                              |
| retry-success           | `ok`     | `rateLimitRetries: n > 0`                    | **not reached** — `decideAlert` reads `failed` rows only |
| retry-exhausted failure | `failed` | `rateLimited: true`, `error` naming the 429s | normal streak alerting                                   |

Retries are logged per occurrence at `warn` (`[rate-limit] 429 on … — retrying in 250ms`), and a
retry-success is still logged as a success — logging it as an error is how real failures stop being
noticed.

**An exhausted 429 fails the run — it never becomes a scored reading.** That is not automatic for
an adapter that scores through failures. Aquarius captures a localized cannot-assess (one role, one
issuer) as a reading that resolves to 0, per `methodology/dex.md`, and it used to capture the
`RateLimitExhaustedError` the same way — so a refused Horizon read published as "this issuer could
not be read", scored 0, and, because the budget is per attempt, took the reads after it down with
it. `adapters/read-failure.ts` now draws the line once, on one test: **a failure is a reading only
when the subject answered.** Horizon answers with a status, so a `4xx` is a reading and a throw
never is; the RPC answers with a simulation error, minted as `SubjectAnswerError`. A rate limit, a
dropped connection and a `5xx` all throw, and the cycle records a failed run with the previous score
standing. The decision and the options weighed against it are in `methodology/dex.md` § "A rate
limit is not a reading"; the `RateLimitExhaustedError` is rethrown untouched so `cycle.ts` can still
flag `rateLimited: true`.

**The policy is a code constant, not an env var**, deliberately. Its numbers are valid only in
relation to `STENION_ATTEMPT_TIMEOUT_MS`; an env var that let the two be set independently would
let someone configure a backoff that cannot fit, which converts honest 429s back into misleading
timeouts. Changing it means changing `DEFAULT_RATE_LIMIT_POLICY` and the arithmetic beside it, at
the same review bar — and `core/src/rate-limit.test.ts` asserts the worst case still clears the
attempt cap with at least 500ms to spare.
