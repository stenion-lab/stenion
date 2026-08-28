## The score

`safetyScore` is **0 to 100, higher is safer**. It is a weighted mean of the five factors, each of
which is also 0–100 higher-is-safer.

**Five factors, and nothing else.** `operationalState` is published alongside the score and is
never an input to it — see
[Operational state is published, never scored](protocol-by-id.md#operational-state-is-published-never-scored). If you
sum the `factors` yourself, you get `safetyScore` back; that property is deliberate and is why no
pause multiplier was applied to it.

How each factor is computed — every formula, threshold, and weight — is in the
[Methodology](../methodology/index.md), which is the public, challengeable rulebook and the source of truth.
It is deliberately not restated here, so that this page cannot drift from it.

`methodologyVersion` is stamped onto every score at the moment it is computed, and history rows
carry their own. **Scores computed under different methodology versions are not comparable.** If you
chart history, treat a change in `methodologyVersion` between adjacent points as a discontinuity in
the rules, not a real move in risk. History is never backfilled — we label the break rather than
hide it. The current version is `1`.

---

## Caching

All three `/v1` read routes are served through a CDN. The two scored routes — `/v1/protocols` and
`/v1/protocol/:id` — use a TTL computed per response from the data in the body rather than a fixed
constant. The reason is directly relevant to you: a fixed TTL would serve a body claiming "the last
run succeeded at T" for some seconds after a later run had already failed — the cache would be lying
in exactly the field that exists to stop us lying about freshness.

**The guarantee, on those two routes: a cached response can hide a newer indexer run by at most 10
seconds.**

`GET /api/v1/coverage` is the deliberate exception, and says so rather than quietly differing. Its
body carries no `lastRunAt` — there is no run behind a coverage decision — and its records change
only when we deploy, so there is no freshness field for a cache to mask and nothing in the body to
derive a deadline from. It uses a fixed one-hour shared-cache TTL instead.

What you will actually observe on a `200`:

```http
Cache-Control: public, max-age=0
Age: 3
X-Vercel-Cache: HIT
```

The `s-maxage` directive that drives the TTL is consumed by the CDN and does not reach you, so do
not look for it. `Age` is how long the copy you received has been sitting in the cache — subtract it
from `Date` if you want the true age of the response. `max-age=0` is intentional: private browser
caches are deliberately kept out, so a copy's real age never exceeds what `Age` reports. There is no
`stale-while-revalidate`, also intentional — it works by serving a body past its deadline, which is
the exact masking described above.

Errors, `404`s, and `429`s are `no-store`.

**Polling advice:** scored data changes every ~5 minutes, so polling those routes faster than that
buys you nothing but cache hits. Once a minute is generous. Coverage records normally change only
on deploy and use a one-hour shared-cache TTL, so polling `/coverage` more than hourly is wasteful.
Note that the cache key includes the query string, so adding `?t=<random>` to defeat the cache does
not get you fresher data — it just guarantees a cache miss and pushes you toward the rate limit.

---

## Rate limits

**60 requests per minute per client, with a burst of 60**, as a token bucket.

The important and slightly unusual property: **only cache misses count.** The limiter runs inside
the function, and the CDN only invokes the function on a miss. So the documented limit is not a cap
on how many requests you may make — a client polling a cached endpoint can exceed it all day and
never be refused, because we never see those requests. What it bites is the client that defeats the
cache, where every request is a database query.

Clients are identified by IP. **Behind a shared NAT you share a bucket** with everyone else on that
address — survivable in practice because NAT'd browser traffic overwhelmingly hits the CDN. We store
a salted hash of the address, never the address itself; this is a limiter, not an access log.

The limiter **fails open**. If its own machinery breaks, requests are allowed rather than refused — a
broken guard rail must not become a broken API.

### 429 Too Many Requests

A real refusal, captured live:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Retry-After: 2
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1787145533
Cache-Control: no-store
Access-Control-Allow-Origin: *
```

```json
{
  "error": "Too many requests. This endpoint is rate limited per client; retry after the wait in the Retry-After header.",
  "retryAfter": 2
}
```

| Header                  | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `Retry-After`           | **Seconds** to wait. This is the one to back off on.                           |
| `X-RateLimit-Limit`     | The sustained per-minute allowance.                                            |
| `X-RateLimit-Remaining` | Always `0` — this header only ships on a refusal.                              |
| `X-RateLimit-Reset`     | **Unix epoch seconds**, the GitHub convention — an absolute time, not a delta. |

`retryAfter` in the body carries the same seconds value as the `Retry-After` header, for clients that
find it easier to read the body.

**How to back off:**

```ts
async function get(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status !== 429) return res;
    const wait = Number(res.headers.get('retry-after') ?? 1);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
  throw new Error('stenion: still rate limited after 5 attempts');
}
```

Honour `Retry-After` rather than retrying immediately or on a fixed schedule — the value is computed
from your actual token balance, so it is the shortest correct wait.

**These headers are absent on a `200`.** That is deliberate, not an oversight: a `200` is
shared-cached and served to many clients, so an `X-RateLimit-Remaining` baked into one would be a
single client's balance, frozen and replayed to everybody — a number wrong for every reader,
including the one it came from. You learn your standing the one time it matters, which is when you
are refused.

---

## Errors

Every error a consumer can hit, with the real body.

### 404 Not Found — unknown protocol id

```bash
curl https://stenion.vercel.app/api/v1/protocol/does-not-exist
```

```json
{ "error": "Protocol not found", "id": "does-not-exist" }
```

The id you asked for is echoed back. Ids are **case-sensitive** — `/protocol/BLEND` is a `404`, and
that is the most common cause of an unexpected one.

A `404` is `no-store` and never cached, on purpose: a protocol added in the next cycle would
otherwise keep 404ing out of a shared cache after it went live.

### 429 Too Many Requests

See [Rate limits](#rate-limits) above.

### 500 Internal Server Error

```json
{ "error": "Internal server error" }
```

Deliberately generic — the underlying error is logged server-side and never leaked. Never cached, so
a `500` cannot outlive the outage that caused it. Retry with backoff.

### 405 Method Not Allowed

All three routes are `GET` (plus `HEAD` and `OPTIONS`) only. Any other method returns `405` with an
empty body.

### Two rough edges, stated rather than hidden

- **`GET /api/v1/protocol` with no id returns an HTML `404`, not JSON.** No route matches, so the
  site's own not-found page is served. If you build the URL by concatenation, guard against an empty
  id — a JSON parse of that response will throw something unhelpful.
- **A `404` from a path that matches no route at all** (`/api/v2/protocols`, the removed
  `/api/protocols`) is likewise HTML. JSON error bodies come from paths that matched a route.

So: **branch on `res.status` before parsing, not the other way round.**

```ts
const res = await fetch('https://stenion.vercel.app/api/v1/protocol/blend');
if (!res.ok) {
  // A 404/429/500 from a matched route is JSON; anything else may be HTML.
  throw new Error(`stenion: ${res.status}`);
}
const detail = await res.json();
```

---

## CORS

All three read routes send `Access-Control-Allow-Origin: *` and answer the preflight, so browser
clients on any origin can call them directly — no proxy needed. Allowed methods are `GET, OPTIONS`;
the only allowed request header is `content-type`. Preflights are cached for a day.

The data is public, read-only, and payment-blind, so `*` is the correct policy here rather than a
shortcut.

---

## Not in this API

Stated so you do not go looking:

- **No pagination, filtering, or sort parameters.** Two protocols are tracked today; the leaderboard
  is one small response and returns everything, already ranked. If the set grows enough to need
  paging, that is an additive change and would arrive on `v1` with a documented default.
- **No historical range query.** `history` is the most recent 50 runs, fixed. There is no `?from=`
  or `?limit=`.
- **No historical factor DIFF.** History rows do carry their own `factors` (added in #82), so you
  can see which factor moved a score. What there is not is a server-side comparison endpoint: diff
  two rows yourself, and only when their `methodologyVersion` matches — factors from two rulebooks
  are no more comparable than the scores are.
- **No webhooks or streaming.** Poll.
- **No authentication.** There is nothing to authenticate; it is all public.

---

## Questions, bugs, and disputes

Stenion is open source — the route handlers behind this document are
[`dashboard/app/api/v1/`](../dashboard/app/api/v1/), and if the code and this page ever disagree, that
is a bug worth an issue.

If you are a protocol being scored and think a threshold is wrong,
[`methodology/index.md`](../methodology/index.md) is the rulebook and it tells you how to dispute it. Payment is not
a route to a better number, and never will be.
