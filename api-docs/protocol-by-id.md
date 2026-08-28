## GET /api/v1/protocol/:id

One protocol: metadata, the current score, the full factor breakdown, and recent run history.

**Request**

```bash
curl https://stenion.vercel.app/api/v1/protocol/blend
```

**Response** `200 OK`

> `history` is truncated to **one** entry below. The live response returns up to **50** rows,
> newest first, and every `ok` one carries a `factors` object of exactly the shape shown here —
> which is why one is shown in full rather than three with it cut out. Everything else is verbatim.

```json
{
  "id": "blend",
  "name": "Blend",
  "chain": "stellar",
  "category": "lending",
  "adapter": "BlendAdapter",
  "logo": "/assets/protocols/blend.svg",
  "contractId": "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
  "site": "https://www.blend.capital",
  "docs": "https://docs.blend.capital",
  "deployedOn": null,
  "safetyScore": 49,
  "computedAt": "2026-08-28T12:25:19.635Z",
  "factors": {
    "oracleSafety": {
      "value": 97,
      "detail": "all 3 reserves score the same — 319s old (fresh<300s, dead>900s); all reserves have a deviation bound",
      "weight": 0.25,
      "components": [
        {
          "id": "priceFreshness",
          "label": "Price freshness",
          "value": 97,
          "detail": "all 3 reserves score the same — 319s old (fresh<300s, dead>900s); anchored to the aggregator's own resolution and max_age (900s)"
        },
        {
          "id": "deviationBound",
          "label": "Deviation bound",
          "value": 100,
          "detail": "all 3 reserves score the same — CAS3J7… bounded at 60% per 300s step; CCW67T… bounded at 20% per 300s step; CDTKPW… bounded at 20% per 300s step"
        },
        {
          "id": "priceAges",
          "label": "Price age by feed (not scored)",
          "value": null,
          "detail": "Other:XLM 319s, Other:USDC 319s, Other:EURC 319s — all 3 within the protocol's own 900s staleness limit. Reported, not graded: priceFreshness already scores the worst of these."
        },
        {
          "id": "deviationTightness",
          "label": "Bound tightness (not scored)",
          "value": null,
          "detail": "per-reserve max_dev: CAS3J7… 60%, CCW67T… 20%, CDTKPW… 20%. Measured against the previous upstream record, so this bounds movement per publish interval. Reported, not graded — see METHODOLOGY.md §2."
        }
      ]
    },
    "adminKeySafety": {
      "value": 40,
      "detail": "single-key admin (1 signer(s), high-threshold 0), 0 op(s) in 30d",
      "weight": 0.2
    },
    "liquiditySafety": {
      "value": 20,
      "detail": "worst reserve (CCW67T…) has 20% of supply as free liquidity",
      "weight": 0.15
    },
    "collateralSafety": {
      "value": 58,
      "detail": "top reserve holds 74% of supplied value across 3 reserves (HHI 0.61)",
      "weight": 0.2
    },
    "utilizationSafety": {
      "value": 11,
      "detail": "worst reserve (CCW67T…) at 80% util vs 90% cap",
      "weight": 0.2
    }
  },
  "operationalState": {
    "asOf": "2026-08-28T12:25:19.000Z",
    "level": "active",
    "detail": "pool status 1 (Active) — all operations available.",
    "origin": "protocol",
    "source": "PoolConfig.status = 1",
    "blocked": []
  },
  "methodologyVersion": 1,
  "lastRunAt": "2026-08-28T12:25:17.171Z",
  "lastRunStatus": "ok",
  "history": [
    {
      "status": "ok",
      "safetyScore": 49,
      "methodologyVersion": 1,
      "factors": {
        "oracleSafety": {
          "value": 97,
          "detail": "all 3 reserves score the same — 319s old (fresh<300s, dead>900s); all reserves have a deviation bound",
          "weight": 0.25,
          "components": [
            {
              "id": "priceFreshness",
              "label": "Price freshness",
              "value": 97,
              "detail": "all 3 reserves score the same — 319s old (fresh<300s, dead>900s); anchored to the aggregator's own resolution and max_age (900s)"
            },
            {
              "id": "deviationBound",
              "label": "Deviation bound",
              "value": 100,
              "detail": "all 3 reserves score the same — CAS3J7… bounded at 60% per 300s step; CCW67T… bounded at 20% per 300s step; CDTKPW… bounded at 20% per 300s step"
            },
            {
              "id": "priceAges",
              "label": "Price age by feed (not scored)",
              "value": null,
              "detail": "Other:XLM 319s, Other:USDC 319s, Other:EURC 319s — all 3 within the protocol's own 900s staleness limit. Reported, not graded: priceFreshness already scores the worst of these."
            },
            {
              "id": "deviationTightness",
              "label": "Bound tightness (not scored)",
              "value": null,
              "detail": "per-reserve max_dev: CAS3J7… 60%, CCW67T… 20%, CDTKPW… 20%. Measured against the previous upstream record, so this bounds movement per publish interval. Reported, not graded — see METHODOLOGY.md §2."
            }
          ]
        },
        "adminKeySafety": {
          "value": 40,
          "detail": "single-key admin (1 signer(s), high-threshold 0), 0 op(s) in 30d",
          "weight": 0.2
        },
        "liquiditySafety": {
          "value": 20,
          "detail": "worst reserve (CCW67T…) has 20% of supply as free liquidity",
          "weight": 0.15
        },
        "collateralSafety": {
          "value": 58,
          "detail": "top reserve holds 74% of supplied value across 3 reserves (HHI 0.61)",
          "weight": 0.2
        },
        "utilizationSafety": {
          "value": 11,
          "detail": "worst reserve (CCW67T…) at 80% util vs 90% cap",
          "weight": 0.2
        }
      },
      "computedAt": "2026-08-28T12:25:19.635Z",
      "runAt": "2026-08-28T12:25:17.171Z"
    }
  ]
}
```

| Field                         | Type           | Notes                                                                                                                                                                                                                    |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `name`, `chain`, `logo` |                | Same as the leaderboard.                                                                                                                                                                                                 |
| `category`                    | string         | Same as the leaderboard. Pairs with `methodologyVersion` — see that row.                                                                                                                                                 |
| `adapter`                     | string         | Which Stenion adapter produced the score. Informational.                                                                                                                                                                 |
| `contractId`                  | string or null | The Soroban contract the score was derived from. A raw `C…` address, deliberately **not** an explorer URL — pick your own.                                                                                               |
| `site`, `docs`                | string or null | The protocol's own links. Listed as its properties, not as a recommendation.                                                                                                                                             |
| `deployedOn`                  | object or null | Same as the leaderboard. See [Not every entry is a protocol](coverage.md#not-every-entry-is-a-protocol).                                                                                                                 |
| `operationalState`            | object or null | Same as the leaderboard. See [Operational state](#operational-state-is-published-never-scored).                                                                                                                          |
| `safetyScore`, `computedAt`   |                | Latest **`ok`** run. Both `null` if never successfully scored.                                                                                                                                                           |
| `factors`                     | object or null | The five-factor breakdown, or `null` if never scored. See below.                                                                                                                                                         |
| `methodologyVersion`          | number or null | Which rulebook version the current score was computed under. **Read it with `category`, not alone** — every category's version counter starts at 1, so the pair identifies a rulebook and the number by itself does not. |
| `lastRunAt`, `lastRunStatus`  |                | Newest run of any status. See [Staleness](health.md#staleness-is-your-problem-too).                                                                                                                                      |
| `history`                     | array          | Up to 50 recent runs, newest first, each `ok` one carrying its own `factors`. **A discriminated union — see below.**                                                                                                     |

### The `factors` object

Five keys, always all five present, defined once as a shared taxonomy so they mean the same thing
for every protocol: `collateralSafety`, `oracleSafety`, `adminKeySafety`, `liquiditySafety`,
`utilizationSafety`.

Each is either a factor object or `null` (the factor genuinely does not apply to that protocol —
render "N/A", do not treat it as zero).

| Field        | Type            | Notes                                                                                    |
| ------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `value`      | number          | 0–100, **higher = safer** — the same direction as the overall score.                     |
| `weight`     | number          | This factor's share of the overall score. Weights of all non-`null` factors sum to 1.    |
| `detail`     | string          | Human-readable, includes the raw on-chain figure it came from. Safe to surface directly. |
| `components` | array, optional | Sub-signals behind `value`. Absent on a factor computed from a single signal.            |

A component with a non-`null` `value` is a scored sub-signal that fed the parent. A component with
`value: null` is a **disclosure** — a real on-chain quantity published deliberately ungraded,
because scoring it would invent comparability the underlying data does not support. Its `detail`
carries the figure. Treat `components` as additive: it may gain entries on `v1`.

Every factor name ends in `*Safety`, and every one is 0–100 higher-is-safer. There is no factor
anywhere in this API where a bigger number is worse.

---

## Operational state is published, never scored

`operationalState` reports **which user operations a market's own contracts were refusing** when it
was last scored. It appears on both `/v1/protocols` and `/v1/protocol/:id`, and it is **not an input
to `safetyScore`** — a halted market and a fully open one can publish the same number.

That is deliberate, not an oversight. A pause can mean an admin containing a threat or a market
being abandoned, and no on-chain data separates the two; the protocols' restricted states are not
even the same shape (Blend never blocks a withdrawal at any of its seven pool statuses, while a
paused Kinetic router blocks withdrawals, repayments and liquidations alike). Grading either into
one number would assert an equivalence that is not true. The full reasoning, including the scored
designs that were rejected, is in
[`methodology/`](https://stenion.vercel.app/methodology#operational-state-is-published-never-scored).

```json
"operationalState": {
  "level": "entryDisabled",
  "source": "PoolConfig.status = 4",
  "blocked": ["supply", "borrow"],
  "origin": "admin",
  "detail": "pool status 4 (Admin Frozen) — borrowing and supplying are disabled; withdrawals and repayments still work.",
  "asOf": "2026-08-25T07:40:53.654Z"
}
```

| Field     | Type            | Notes                                                                                                                    |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `level`   | string enum     | One of `active`, `borrowingDisabled`, `entryDisabled`, `exitDisabled`, `notOperational`. See the table below.            |
| `source`  | string          | The protocol's **own** reading, verbatim, so you can check it on chain yourself. Never a Stenion label.                  |
| `blocked` | array of string | Which of `supply`, `withdraw`, `borrow`, `repay`, `liquidate` are refused, in that canonical order. Empty when `active`. |
| `origin`  | string enum     | `admin` \| `protocol` \| `indeterminate` — who **could** have set this state, never why. See below.                      |
| `detail`  | string          | One sentence: what was read and what it means for a user.                                                                |
| `asOf`    | string          | ISO 8601 UTC. A live state is only true as of an instant.                                                                |

| `level`             | What it means for someone with funds in the market                      |
| ------------------- | ----------------------------------------------------------------------- |
| `active`            | Nothing restricted.                                                     |
| `borrowingDisabled` | Cannot borrow. Depositing and withdrawing both work.                    |
| `entryDisabled`     | Cannot borrow or supply — no new exposure — but **you can still exit**. |
| `exitDisabled`      | **Cannot withdraw.** Capital cannot leave the market while this holds.  |
| `notOperational`    | The market was never opened for use.                                    |

`origin` is the closest the chain comes to the question the score cannot answer, and it is not that
answer. `admin` means only an admin could have set this state — not that they were right or wrong to.
`protocol` means the protocol's own mechanism produced it without anyone acting. `indeterminate` is a
real reading rather than a gap: Blend's status 3 is settable by an admin _and_ by its backstop update
path, and Kinetic's pause flag carries no origin at all.

**If you render `safetyScore`, render this beside it.** It is on the leaderboard rather than only on
the detail response for exactly that reason — a reader who scans a list and leaves must not have
been shown only the number. `null` means the state was not read (never scored, or a run predating
the field); it never means "nothing is restricted".

---

## History rows are a discriminated union — read this one

This is the single most likely thing to get wrong, so it gets its own section.

`history[]` entries are **not** a uniform shape with nullable fields. They are a union discriminated
on `status`:

- an **`ok`** row carries `safetyScore`, `methodologyVersion`, `factors`, `computedAt`, and
  `runAt`.
- a **`failed`** row carries `error` and `runAt`, and **does not have a `safetyScore` key at all** —
  not `null`, not `0`. The key is absent. Nor a `factors` key: a run that failed produced no
  breakdown, and an empty object here would read as five factors that all scored nothing.

That absence is deliberate. A failed run is a **gap in our data**, never a score of zero, and giving
it a `safetyScore: 0` would let a pipeline outage render as a protocol suddenly becoming maximally
dangerous.

```ts
type HistoryEntry =
  | {
      status: 'ok';
      safetyScore: number;
      methodologyVersion: number;
      // the same shape as the top-level `factors`, as THAT run computed it
      factors: Record<string, RiskFactor | null>;
      computedAt: string;
      runAt: string;
    }
  | {
      status: 'failed';
      error: string;
      runAt: string;
    };
```

A `failed` row looks like this — captured live, from Blend's history on 2026-08-28. It is a run the
shared public RPC refused, which is what most failures here are: our failure to read the chain, not
anything about the protocol.

```json
{
  "status": "failed",
  "error": "Request failed with status code 429",
  "runAt": "2026-08-28T12:30:18.171Z"
}
```

(This example was previously constructed from the schema, because at the time no production run had
ever failed. Some now have.)

**Do this** — branch on `status` and let a failure be a gap:

```ts
for (const entry of detail.history) {
  if (entry.status === 'ok') {
    plot(entry.runAt, entry.safetyScore);
  } else {
    markGap(entry.runAt, entry.error);
  }
}
```

**Not this** — it silently plots a zero for every failed run, drawing a cliff that never happened:

```ts
// WRONG
for (const entry of detail.history) {
  plot(entry.runAt, entry.safetyScore ?? 0);
}
```

`error` is our own message, and it is meant to be readable. It describes **our** failure to read the
chain — an RPC timeout, a decode error — and says nothing about the protocol's safety. Do not
surface it as a risk signal.

### A history row's `factors` belong to that row

An `ok` row's `factors` are what **that run** computed, from the on-chain state it read at
`computedAt` — not the current breakdown restated under an old date. That is the whole point of
returning them: a score moving from 51 to 49 tells you nothing until you can see which factor moved.

Read them under that row's own `methodologyVersion`, exactly as you read its `safetyScore`. Two rows
stamped with different versions were scored by different rules, so a factor that appears in both is
not necessarily the same measurement — and a factor may not appear in both at all. Nothing is
backfilled across a version bump; `risk_scores` stores outputs, never the raw on-chain inputs, so an
old row cannot be recomputed under new rules and never will be.

Sizing note: 50 rows each carry a full factor map, so this response is measured in tens of
kilobytes, not hundreds of bytes. It is one response — there is no per-row fetch, and adding one
would be 50 requests for data you already have.

---
