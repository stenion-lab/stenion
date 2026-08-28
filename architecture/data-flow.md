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
