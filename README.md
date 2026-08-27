# Stenion

**Live, on-chain risk intelligence for Stellar/Soroban DeFi.**

[stenion.vercel.app](https://stenion.vercel.app) · [API](API.md) · [Methodology](METHODOLOGY.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md)

---

## What Stenion is

Stenion continuously scores the safety of Stellar/Soroban DeFi protocols — starting with
lending protocols ([Blend](https://blend.capital) and [Kinetic/K2](https://k2lend.com)) — by
reading their state **directly from the chain** and turning it into a single, comparable
`safetyScore` (0–100, higher = safer), broken down into five risk factors.

Scoring is per **market**, not per brand: four entries across those two protocols today — Blend's
own Fixed pool, Kinetic, and the YieldBlox and Etherfuse pools on Blend V2. A market running another
protocol's contracts is labelled as one everywhere it appears — the registry ranks what is actually
deployed, and never lets a pool pass for a protocol.

It is **not** a TVL tracker. [DefiLlama](https://defillama.com) already covers TVL for Stellar.
The thing Stenion measures that a TVL dashboard and a one-time audit both miss is **risk that
moves every block**:

- **Collateral concentration** — is the pool's value spread across assets, or all in one?
- **Oracle trustworthiness** — how old is the worst price feed the protocol is trading on, _and_
  does the pool's price path bound how far a single update can move it?
- **Admin-key control** — single hot key, or a multisig? How active is it?
- **Liquidity depth** — how much could be withdrawn before a reserve is drained?
- **Utilization headroom** — how close is borrowing to the protocol's own stress line?

A static audit is a snapshot of one moment. TVL tells you how much is at stake, not how safe it
is. Stenion re-derives all five factors from on-chain data on a short interval, so the number you
see reflects the protocol **now**, not at audit time.

## The rules that make the number trustworthy

These are non-negotiable and enforced in code and review:

- **Payment never changes a score.** Protocols can pay for visibility, speed, or private tooling
  — never for a better number. The ranked registry is always free, public, and sorted purely on
  `safetyScore`.
- **Adapters read trustless on-chain data** (Soroban RPC + Horizon) — never self-reported figures.
- **No fabricated numbers.** Where real data genuinely isn't available for a factor, Stenion uses
  a clearly-flagged neutral baseline — never an invented, plausible-looking value.
- **AI only explains, never scores.** Any AI feature summarizes the real underlying data; it never
  generates an independent risk assessment.

The full, challengeable rulebook — every formula, threshold, and weight — lives in
[`METHODOLOGY.md`](METHODOLOGY.md). If you're a protocol being scored and think a threshold is
wrong, that document tells you how to dispute it.

## Quick start (run it locally)

**Prerequisites:** [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io) (via
[corepack](https://nodejs.org/api/corepack.html) — the version is pinned in the root
`package.json`). A Postgres database — the project uses [Neon](https://neon.tech)'s free tier, but
any Postgres works.

> `pnpm test` needs a newer Node than the app itself does: the tests are `*.test.ts` files run by
> Node's built-in runner on **native TypeScript type stripping** (Node 22.18+ / 24 — developed and
> verified on 24), which is what keeps the suite at zero dependencies. Everything else runs on 20+.

```bash
# 1. Install (pnpm workspaces — installs every package)
corepack enable
pnpm install

# 2. Configure. Copy the example env and fill in DATABASE_URL (+ RPC/Horizon if you
#    want non-default endpoints). One repo-root .env covers every package.
cp .env.example .env
#    Edit .env:
#      DATABASE_URL         — Postgres connection string (Neon pooled string works out of the box)
#      STENION_RPC_URL      — Soroban RPC (defaults to the public keyless mainnet RPC)
#      STENION_HORIZON_URL  — Horizon (defaults to the public mainnet Horizon)
#      CRON_SECRET          — only needed to test the dashboard's cron-trigger route

# 3. Build the workspace packages and run migrations
pnpm --filter @stenion/db build
pnpm --filter @stenion/db migrate

# 4. Run one scoring cycle against live mainnet and write it to Postgres
pnpm --filter @stenion/core build
pnpm --filter @stenion/adapters build
pnpm --filter @stenion/indexer build
pnpm --filter @stenion/indexer start -- --once   # drop --once to loop on an interval

# 5. Run the dashboard (reads the DB directly; also serves the public API routes)
pnpm --filter @stenion/dashboard dev             # http://localhost:3000
```

The dashboard reads Postgres in-process, so once step 4 has landed at least one row you'll see
real scores at `http://localhost:3000`. The public API is served by the dashboard at
`/api/v1/protocols`, `/api/v1/coverage`, `/api/v1/protocol/:id`, and `/api/v1/health` — versioned,
with the policy in [`ARCHITECTURE.md`](ARCHITECTURE.md#api-versioning).

### Using the public API

**The full reference is [`API.md`](API.md)** — every endpoint with live example responses, the
`ok`/`failed` history union, the staleness model, error shapes, and the versioning commitment. It's
also rendered on the site at [/docs/api](https://stenion.vercel.app/docs/api). The summary:

It's free, open, needs no key, and allows any origin. Two things to know before you build against
it:

- **It's cached, briefly.** The TTL is computed per response, between 10 and 45 seconds, so a
  cached body can never hide a newer indexer run by more than 10 seconds. The `s-maxage` that
  drives it is consumed by the CDN and never reaches you — what you see is
  `Cache-Control: public, max-age=0` plus an `Age` header, which is the one to read if you need to
  know exactly how old a response is. Scores only change every ~5 minutes, so **polling faster than
  once a minute gains you nothing.**
- **It's rate limited: 60 requests/minute per client, with a burst of 60.** Only requests that miss
  the cache count, so ordinary polling will never come close. Over the limit you get a `429` with a
  `Retry-After` header in seconds — honour it and you'll be served immediately. `X-RateLimit-Limit`
  and `X-RateLimit-Reset` (unix epoch seconds) come with it.

Behind a shared NAT you share a bucket with everyone on that address; cached responses don't count,
which is what makes that workable in practice. If you're building something that genuinely needs
more, open an issue — the numbers are policy, not physics. Full reasoning, and what the limiter
does and doesn't protect against, is in
[`ARCHITECTURE.md`](ARCHITECTURE.md#caching-and-rate-limits).

### Is the data fresh? — `GET /api/v1/health`

Stenion's worst failure mode is quiet: if the indexer stops, the site keeps serving last-known
scores, every page renders, nothing 500s, and the numbers just age. `/api/v1/health` gives that a
machine-readable signal so you don't have to trust a timestamp in the UI.

```bash
curl -i https://stenion.vercel.app/api/v1/health
```

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

Three things to know:

- **`status` has three values, and the non-healthy two both answer `503`.** So an uptime monitor
  can point at this URL and needs no body parsing at all. `healthy` = every protocol scored
  successfully within the threshold (`200`). `degraded` = some are current and some aren't — read
  the per-protocol rows, it's probably one adapter. `down` = nothing is current anywhere, i.e. the
  indexer itself looks dead.
- **`staleMinutes` is measured from `lastSuccessfulRunAt`, never from `lastRunAt`.** An adapter
  failing every five minutes has a perpetually fresh `lastRunAt`; measuring from it would report
  the exact failure this endpoint is for as perfectly healthy. The two timestamps together are the
  useful signal — a fresh `lastRunAt` beside a stale `lastSuccessfulRunAt` is one broken adapter,
  and both stale together is the cron not arriving.
- **It is never cached.** Unlike the other routes, this one sends `Cache-Control: no-store` — a
  health check that can be stale is a contradiction. It is still rate limited like everything else,
  which at 60/min is ~30× more than a monitor probing every 30 seconds needs.

`thresholdMinutes` is echoed in the body so you can see what number produced the verdict. It
defaults to 30 (six missed cycles at the ~5-minute indexer cadence) and is configurable via
`STENION_HEALTH_STALE_MINUTES`. Full reasoning for both thresholds is in
[`ARCHITECTURE.md`](ARCHITECTURE.md#the-health-endpoint).

There is also a human-readable **[/status](https://stenion.vercel.app/status)** page on the site
that fetches this endpoint and renders the overall state prominently, plus per-protocol freshness
cards showing last-successful-run time, staleness, and last-run status. It auto-refreshes every 30
seconds — the same data, for a browser instead of `curl`.

To smoke-test the deployed 404 behaviour for an unknown protocol id, run:

```bash
pnpm smoke:protocol-404 https://stenion.vercel.app
```

The smoke test calls `/api/v1/protocol/:id` with a known-bad id and expects status `404` with
`{ "error": "Protocol not found", "id": "<id>" }`. It is a manual production check, not part of CI,
because it intentionally hits the deployed dashboard URL. Pass any deployed base URL — a preview
deployment works as well as production — or set `STENION_SMOKE_BASE_URL` instead of the argument.

Point it at a deployment, not `next dev`: in dev mode that route answers `200` rather than `404`,
which is Next.js behaviour we document rather than fight.

Locally you run scoring cycles by hand (step 4). In production nothing in this repo schedules them:
`POST /api/cron/run-indexer` runs exactly one cycle per request, and an external cron-job.org job
calls it every 5 minutes with `Authorization: Bearer <CRON_SECRET>`. **That schedule is configured
in cron-job.org's dashboard, not in version control** — there's no workflow or `vercel.json` `crons`
entry here to find. See [`ARCHITECTURE.md`](ARCHITECTURE.md#deploy-architecture) for why.

> **Note:** the public RPC (`mainnet.sorobanrpc.com`) is shared and rate-limited — fine for trying
> it out, but use your own endpoint for anything sustained.

See [`.env.example`](.env.example) for every variable and [`ARCHITECTURE.md`](ARCHITECTURE.md) for
what each package does and how data flows through the system.

**One-time git setup.** Formatting is enforced by Prettier, and the repo was reformatted in a
single bulk commit. Point git at the ignore list so `git blame` skips it and attributes each line
to the commit that actually wrote it:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

(GitHub's blame view applies [`.git-blame-ignore-revs`](.git-blame-ignore-revs) automatically; this
is only needed for local blame. Formatting and commit workflow is in [`CONTRIBUTING.md`](CONTRIBUTING.md#formatting).)

## Contributing an adapter

The main way to contribute is to **write an adapter for a new protocol** — DeFiLlama-style, one
open-source, PR-reviewed adapter per protocol. Everything you need is in
[`CONTRIBUTING.md`](CONTRIBUTING.md): the `Adapter` interface, the fixed `*Safety` taxonomy every
adapter must populate, the error convention, and the rule that thresholds are anchored to a
protocol's real on-chain parameters — never invented.

## Documentation

| Doc                                  | What's in it                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [`METHODOLOGY.md`](METHODOLOGY.md)   | The source of truth for every factor's formula, thresholds, and weights. Public and challengeable. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Monorepo layout, what each package does, data flow, and the deploy architecture.                   |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to write an adapter, the taxonomy and conventions, PR expectations, local dev.                 |
| [`ROADMAP.md`](ROADMAP.md)           | What's live, what's planned, what's out of scope.                                                  |

## License

[MIT](LICENSE).
