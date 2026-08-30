# Stenion Public API

**Free, public, read-only risk data for Stellar/Soroban DeFi lending protocols.**

Four `GET` endpoints, no authentication, no API key, CORS open to any origin. If you are building a
wallet, an aggregator, or a dashboard and you want a live safety number for a protocol your users
are about to interact with, this is the whole surface area.

The scored examples below were captured from the live production API, not written from the type
definitions. They are verbatim bodies: `/v1/protocols` and `/v1/protocol/aquarius-xlm-usdc` from
**2026-08-30T08:35Z**, `/v1/protocol/blend` from **2026-08-28T12:25Z**. The numbers move every
~5 minutes, the shapes do not.

> **Both categories appear in the examples.** `/v1/protocols` returns `"lending"` and `"dex"`
> entries side by side, and a `dex` protocol's `factors` object has **two** keys rather than
> lending's five — `adminKeySafety` and `assetControlSafety`, at their own weights.
> [The `factors` section](protocol-by-id.md#the-factors-object) explains how to read a factor map
> whose keys you do not recognise, and carries a full `dex` response beside the `lending` one.
> **Scores are comparable only within one `category`**, and so are the keys and weights of
> `factors`.

The coverage example was `curl`ed from production on **2026-08-25T18:20Z**.

One consequence of "verbatim" worth knowing before you diff these against the field tables: the keys
inside `operationalState` come back in a different order from the tables below, because the value is
stored as Postgres `jsonb`, which does not preserve key order. JSON objects are unordered and no
consumer should care — but the examples are copied from the wire rather than tidied, so the
difference is real and is left alone.

The `/v1/health` examples are mixed, and marked individually at the endpoint. The `healthy` body was
`curl`ed from production on **2026-08-25T18:20Z**. The `degraded` body is **constructed, not
captured**: `risk_scores` has never held a failed run, so that state has never occurred in production
and cannot be observed until it does.

---

## Base URL

```
https://stenion.vercel.app/api/v1
```

There is no separate API host and no sandbox. The production API is the only API, and it serves the
same data the [registry](https://stenion.vercel.app/registry) renders — the site's own pages and
these routes read the same store, so what you get and what we show cannot drift apart.

### Versioning, and whether we will break you

Every public path carries a version segment. There are **no unversioned paths** — `/api/protocols`
and `/api/protocol/:id` existed briefly during the move to `/v1` and now `404`.

The policy, stated plainly because "will you break my integration" is the only versioning question
that actually matters:

- **Additive changes stay on `v1`.** A new field in a response — a sixth `*Safety` factor, another
  piece of protocol metadata, a new component inside a factor — ships on `v1`. It cannot break a
  client that ignores fields it does not recognise, so **parse defensively and tolerate unknown
  fields**. That is the one thing we ask of you in return.
- **Breaking changes get a `v2`.** Renaming a field, removing one, changing a type, changing what an
  existing value _means_, or restructuring the envelope — all of it goes to a new version path.
  `v1` keeps serving its existing contract until it is deliberately retired, which would be
  announced, not silent.

**A methodology change is not an API change.** If we change a formula, a threshold, or a weight,
`safetyScore` is still a 0–100 number meaning the same thing, so the contract holds and the version
does not move. What moves is `methodologyVersion` in the response body — see
[The score](conventions.md#the-score). A change to the factor _taxonomy_, though — renaming or
removing a factor an existing category publishes — is breaking, and would be a `v2`. **Admitting a
new category, with its own factor keys, is additive and stays on `v1`**: no existing entry's shape
changes, and a client that iterates `factors` by its own keys reads the new one correctly. That is
why the [`factors` section](protocol-by-id.md#the-factors-object) tells you to iterate rather than
index.

---

## Two commitments

**The public registry data is free, and stays free.** The score, the factor breakdown, the history,
and these endpoints are public and unmetered beyond the rate limit below. Stenion's paid tiers add
capability — private tooling, faster refresh, visibility placement — and they never gate access to
anything that is already public, and never change a score. The ranked registry is sorted purely on
`safetyScore` with no paid exceptions. This is a project rule enforced in code and review, not a
launch promise.

**Nothing here is an endorsement.** A `safetyScore` is analysis of on-chain state, not a
recommendation, a rating, an audit, or financial advice. Protocol names, logos, links, and contract
ids appear as the subject's own properties. Displaying a protocol does not imply endorsement,
partnership, or any relationship between Stenion and that protocol — in either direction — and
integrating this API does not create one either.

---

## Quick start

```bash
# every protocol, ranked
curl https://stenion.vercel.app/api/v1/protocols

# protocols Stenion assessed and deliberately does not score
curl https://stenion.vercel.app/api/v1/coverage

# one protocol, with factors and run history
curl https://stenion.vercel.app/api/v1/protocol/blend

# is the data fresh? (answers 503 when it is not)
curl -i https://stenion.vercel.app/api/v1/health
```

---
