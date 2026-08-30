## GET /api/v1/protocols

The leaderboard: every protocol Stenion tracks, with its latest score. Ranked by `safetyScore`
descending, with never-scored protocols last.

> **The array's order never implies a rank across categories, and two scores are comparable only
> when their `category` matches.** Each category is scored on its own factors under its own weights
> — a `safetyScore` of 70 in one says nothing at all about a 65 in another, and the gap between them
> is not a quantity. This response is a flat data feed sorted by a single column; it is not a
> leaderboard across categories, and building one from it by reading positions off the array would
> assert a comparison the number cannot support. Rank within one `category` and present the
> categories separately. **That stopped being hypothetical on 2026-08-29**: `"dex"` entries are now
> published alongside `"lending"` ones, so the flat order of this array is no longer a valid ranking
> and never will be again. Sorting by `safetyScore` across the whole array would put a `dex` market
> above or below a `lending` one on a comparison neither rulebook supports.

**Request**

```bash
curl https://stenion.vercel.app/api/v1/protocols
```

**Response** `200 OK`

```json
{
  "protocols": [
    {
      "id": "etherfuse",
      "name": "Etherfuse",
      "chain": "stellar",
      "category": "lending",
      "logo": null,
      "deployedOn": {
        "host": "Blend",
        "label": "Blend V2 pool"
      },
      "safetyScore": 65,
      "computedAt": "2026-08-30T08:30:10.636Z",
      "operationalState": {
        "asOf": "2026-08-30T08:30:10.000Z",
        "level": "entryDisabled",
        "detail": "pool status 4 (Admin Frozen) — borrowing and supplying are disabled; withdrawals and repayments still work.",
        "origin": "admin",
        "source": "PoolConfig.status = 4",
        "blocked": ["supply", "borrow"]
      },
      "lastRunAt": "2026-08-30T08:30:07.381Z",
      "lastRunStatus": "ok"
    },
    {
      "id": "blend",
      "name": "Blend",
      "chain": "stellar",
      "category": "lending",
      "logo": "/assets/protocols/blend.svg",
      "deployedOn": null,
      "safetyScore": 49,
      "computedAt": "2026-08-30T07:45:25.080Z",
      "operationalState": {
        "asOf": "2026-08-30T07:45:25.000Z",
        "level": "active",
        "detail": "pool status 1 (Active) — all operations available.",
        "origin": "protocol",
        "source": "PoolConfig.status = 1",
        "blocked": []
      },
      "lastRunAt": "2026-08-30T08:30:23.669Z",
      "lastRunStatus": "failed"
    },
    {
      "id": "kinetic",
      "name": "Kinetic",
      "chain": "stellar",
      "category": "lending",
      "logo": "/assets/protocols/kinetic.png",
      "deployedOn": null,
      "safetyScore": 27,
      "computedAt": "2026-08-30T08:30:18.555Z",
      "operationalState": {
        "asOf": "2026-08-30T08:30:16.000Z",
        "level": "active",
        "detail": "the router is not paused",
        "origin": "indeterminate",
        "source": "router.is_paused() = false",
        "blocked": []
      },
      "lastRunAt": "2026-08-30T08:30:12.987Z",
      "lastRunStatus": "ok"
    },
    {
      "id": "yieldblox",
      "name": "YieldBlox",
      "chain": "stellar",
      "category": "lending",
      "logo": "/assets/protocols/yieldblox.png",
      "deployedOn": {
        "host": "Blend",
        "label": "Blend V2 pool"
      },
      "safetyScore": 27,
      "computedAt": "2026-08-30T07:45:21.408Z",
      "operationalState": {
        "asOf": "2026-08-30T07:45:21.000Z",
        "level": "active",
        "detail": "pool status 0 (Admin Active) — all operations available.",
        "origin": "admin",
        "source": "PoolConfig.status = 0",
        "blocked": []
      },
      "lastRunAt": "2026-08-30T08:30:18.749Z",
      "lastRunStatus": "failed"
    },
    {
      "id": "aquarius-xlm-usdc",
      "name": "Aquarius XLM/USDC",
      "chain": "stellar",
      "category": "dex",
      "logo": null,
      "deployedOn": null,
      "safetyScore": 24,
      "computedAt": "2026-08-30T08:30:12.798Z",
      "operationalState": {
        "asOf": "2026-08-30T08:30:12.000Z",
        "level": "active",
        "detail": "the AMM router CBQDHN… is not in emergency mode",
        "origin": "indeterminate",
        "source": "router.get_emergency_mode() = false",
        "blocked": []
      },
      "lastRunAt": "2026-08-30T08:30:10.864Z",
      "lastRunStatus": "ok"
    }
  ]
}
```

| Field              | Type                     | Notes                                                                                                                                                                                                                                     |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string                   | Stable identifier, **case-sensitive**, used as the path segment on the detail endpoint.                                                                                                                                                   |
| `name`             | string                   | Display name.                                                                                                                                                                                                                             |
| `chain`            | string                   | Currently always `"stellar"`.                                                                                                                                                                                                             |
| `category`         | string                   | Which rulebook produced `safetyScore` — `"lending"` or `"dex"` today. **Scores are comparable only within one category, and so are the keys of `factors`.** Tolerate an unrecognised value: new categories are additive and stay on `v1`. |
| `logo`             | string or null           | Root-relative path to a mark **Stenion hosts** — prefix with the base host. `null` is a normal state, not a broken image.                                                                                                                 |
| `deployedOn`       | object or null           | **Present when this entry is not an independent protocol** — see [Not every entry is a protocol](coverage.md#not-every-entry-is-a-protocol). `null` means it runs on its own contracts.                                                   |
| `safetyScore`      | number or null           | 0–100, higher = safer. From the latest **`ok`** run. `null` means never successfully scored — not "zero", not "unsafe".                                                                                                                   |
| `computedAt`       | string or null           | ISO 8601 UTC. When that score was computed. `null` if and only if `safetyScore` is `null`.                                                                                                                                                |
| `operationalState` | object or null           | **What the market's own contracts are currently refusing** — see [Operational state](protocol-by-id.md#operational-state-is-published-never-scored). Never folded into `safetyScore`. `null` means not read, never "unrestricted".        |
| `lastRunAt`        | string or null           | ISO 8601 UTC. The most recent run of **any** status. See [Staleness](health.md#staleness-is-your-problem-too).                                                                                                                            |
| `lastRunStatus`    | `"ok"`, `"failed"`, null | Status of that most recent run. `null` means the protocol has never been run at all.                                                                                                                                                      |

The board deliberately carries no `contractId`, `site`, or `docs` — those are verification detail
nobody acts on from a list, and repeating them on every row of every fetch is waste. They live on
the detail response. `deployedOn` and `operationalState` are the exceptions, and for the opposite
reason: neither is detail you look up after deciding to care, both are part of what the row _is_,
and a reader who scans the board and leaves has to have seen them.

---
