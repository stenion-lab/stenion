## Staleness is your problem too

Stenion re-scores every ~5 minutes. Runs can fail. The API is built to be honest about that rather
than to paper over it, which means you get two independent pieces of information:

- **`safetyScore` / `computedAt`** — the last score we computed **successfully**.
- **`lastRunAt` / `lastRunStatus`** — the most recent run attempt, of **any** outcome.

When `lastRunStatus` is `"ok"`, these agree and there is nothing to think about.

**When `lastRunStatus` is `"failed"`, the score you are holding is still real, but our data is older
than it looks.** It is the last one we successfully computed — at `computedAt` — and we have since
tried and failed to refresh it. The gap between `computedAt` and now is how stale the number
actually is, and `lastRunAt` tells you we were still trying.

```ts
const stale = detail.lastRunStatus === 'failed';
const scoreAgeMs = detail.computedAt ? Date.now() - Date.parse(detail.computedAt) : null;
```

We think an integrator should surface that to their own users rather than absorb it silently — a
safety number that quietly stopped updating is worse than one labelled as stale, because a user acts
on it either way. Our own registry does this: a failed run gets a pill, a caption, and both
timestamps on the protocol page.

One deliberate detail worth copying: **never colour a staleness marker with the score bands.**
Green/amber/red mean risk level here. Painting a pipeline fault amber reports our outage as a verdict
on the protocol.

`safetyScore: null` together with `lastRunStatus: "failed"` means we have **never** had a good score
for that protocol. Render it as unknown. It is not a zero.

---

## GET /api/v1/health

The machine-readable version of everything the previous section just described. Point an uptime
monitor at it and you will know when our data stops updating without polling scores and diffing
timestamps yourself.

**Request**

```bash
curl -i https://stenion.vercel.app/api/v1/health
```

**Response** — `200 OK`

This one is a real capture: `curl`ed over HTTP from the production endpoint on
**2026-08-26T10:04Z**. The `Cache-Control: no-store` described under [Caching](conventions.md#caching) was verified
on the same request — staleness here advances with the wall clock, so any TTL could serve a
`healthy` 200 after the true answer had become `degraded`.

```json
{
  "status": "healthy",
  "thresholdMinutes": 30,
  "protocols": [
    {
      "id": "blend",
      "lastSuccessfulRunAt": "2026-08-26T10:01:25.334Z",
      "lastRunAt": "2026-08-26T10:01:25.334Z",
      "lastRunStatus": "ok",
      "staleMinutes": 3
    },
    {
      "id": "etherfuse",
      "lastSuccessfulRunAt": "2026-08-26T10:00:59.824Z",
      "lastRunAt": "2026-08-26T10:00:59.824Z",
      "lastRunStatus": "ok",
      "staleMinutes": 3
    },
    {
      "id": "kinetic",
      "lastSuccessfulRunAt": "2026-08-26T10:01:08.636Z",
      "lastRunAt": "2026-08-26T10:01:08.636Z",
      "lastRunStatus": "ok",
      "staleMinutes": 3
    },
    {
      "id": "yieldblox",
      "lastSuccessfulRunAt": "2026-08-26T10:01:17.757Z",
      "lastRunAt": "2026-08-26T10:01:17.757Z",
      "lastRunStatus": "ok",
      "staleMinutes": 3
    }
  ]
}
```

**Response** — `503 Service Unavailable`

> **This second body is NOT a capture.** `risk_scores` has never held a failed run in production, so
> `degraded` has never occurred and cannot be captured. It is constructed from the route's tests.
> The shape is exact; the values are illustrative.

```json
{
  "status": "degraded",
  "thresholdMinutes": 30,
  "protocols": [
    {
      "id": "blend",
      "lastSuccessfulRunAt": "2026-08-22T12:41:00.000Z",
      "lastRunAt": "2026-08-22T12:41:00.000Z",
      "lastRunStatus": "ok",
      "staleMinutes": 9
    },
    {
      "id": "kinetic",
      "lastSuccessfulRunAt": "2026-08-22T09:10:00.000Z",
      "lastRunAt": "2026-08-22T12:49:00.000Z",
      "lastRunStatus": "failed",
      "staleMinutes": 220
    }
  ]
}
```

### Fields

| Field                             | Type                                | Meaning                                                                                                                                     |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                          | `"healthy" \| "degraded" \| "down"` | The overall verdict. See below.                                                                                                             |
| `thresholdMinutes`                | number                              | The staleness threshold this response was judged against. Echoed so you never have to guess what produced the verdict.                      |
| `protocols[].id`                  | string                              | The protocol slug, same id as everywhere else in this API.                                                                                  |
| `protocols[].lastSuccessfulRunAt` | ISO 8601 \| `null`                  | The newest run that **succeeded**. `null` = never scored successfully.                                                                      |
| `protocols[].lastRunAt`           | ISO 8601 \| `null`                  | The newest run of **any** outcome. `null` = never ran.                                                                                      |
| `protocols[].lastRunStatus`       | `"ok" \| "failed" \| null`          | Outcome of that newest run. Same vocabulary as `/v1/protocols` — `ok`/`failed`, not `success`/`failure`.                                    |
| `protocols[].staleMinutes`        | number \| `null`                    | Whole minutes since `lastSuccessfulRunAt`, computed at request time. `null` when there is no successful run to measure from — **not zero**. |

Protocols are ordered by `id`. That is deliberate and carries no ranking: entries here are only ever
current or not, and alphabetical is the one ordering that asserts nothing about which protocol is
doing better.

### The status, and the HTTP code

| `status`   | Meaning                                                                | HTTP  |
| ---------- | ---------------------------------------------------------------------- | ----- |
| `healthy`  | Every protocol scored successfully within `thresholdMinutes`.          | `200` |
| `degraded` | Some protocols are current, some are not. Probably one broken adapter. | `503` |
| `down`     | Nothing is current anywhere. Our indexer itself looks dead.            | `503` |

**Both non-healthy states answer `503`**, so a monitor that only reads the status line works with no
body parsing at all. The distinction between them is for the human who opens it afterwards.

A `500` on this route means something different from a `503`: `503` is us successfully reporting
that the pipeline is behind, `500` is us being unable to find out. If you alert on this endpoint,
they are both worth catching, but only the `503` tells you the scores are aging.

### How to read it

- **Staleness is measured from `lastSuccessfulRunAt`, never `lastRunAt`.** An adapter failing every
  five minutes has a perpetually fresh `lastRunAt`; measuring from it would report the exact failure
  this endpoint exists to catch as perfectly healthy.
- **The two timestamps together tell you where the problem is.** A fresh `lastRunAt` beside a stale
  `lastSuccessfulRunAt` is one adapter failing while our pipeline runs fine. Both stale together
  means our indexer is not running at all. The `kinetic` row above is the first case.
- **A single fresh failure does not make us unhealthy.** If a protocol's newest run failed but its
  newest _success_ is minutes old, `status` stays `healthy` — the data you are being served is
  current, and we would rather not cry wolf over one cycle. Sustained failure crosses the threshold
  on its own. If you want to react to any failed cycle, read `lastRunStatus` yourself; that is why
  it is published.

### Caching and limits

**Never cached** — this route sends `Cache-Control: no-store`, unlike the other three. A health
check that can be stale is a contradiction, and a cached `503` would go on being served after we
recovered. It is rate limited like everything else, which at 60 requests/minute is far more than a
monitor probing every 30 seconds will use.

Polling faster than once a minute gains you nothing: we re-score every ~5 minutes, so the answer
cannot change more often than that.

---
