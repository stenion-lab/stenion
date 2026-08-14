# Stenion

**Live, on-chain risk intelligence for Stellar/Soroban DeFi.**

[stenion.vercel.app](https://stenion.vercel.app) · [Methodology](METHODOLOGY.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md)

---

## What Stenion is

Stenion continuously scores the safety of Stellar/Soroban DeFi protocols — starting with
lending protocols ([Blend](https://blend.capital) and [Kinetic/K2](https://k2lend.com)) — by
reading their state **directly from the chain** and turning it into a single, comparable
`safetyScore` (0–100, higher = safer), broken down into five risk factors.

It is **not** a TVL tracker. [DefiLlama](https://defillama.com) already covers TVL for Stellar.
The thing Stenion measures that a TVL dashboard and a one-time audit both miss is **risk that
moves every block**:

- **Collateral concentration** — is the pool's value spread across assets, or all in one?
- **Oracle staleness** — how old is the worst price feed the protocol is trading on?
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
`/api/v1/protocols` and `/api/v1/protocol/:id` — versioned, with the policy in
[`ARCHITECTURE.md`](ARCHITECTURE.md#api-versioning).

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
is only needed for local blame. Formatting workflow is in [`CONTRIBUTING.md`](CONTRIBUTING.md#formatting).)

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
