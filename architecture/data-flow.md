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
