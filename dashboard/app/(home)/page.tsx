import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Bot,
  Boxes,
  Camera,
  Coins,
  Gauge,
  KeyRound,
  ShieldOff,
  Timer,
  Waves,
} from 'lucide-react';
import { getProtocols, type LeaderboardEntry } from '../lib/api';
import { GITHUB_URL } from '../lib/site';
import { MarkAttribution } from '../../components/protocol-logo';
import { ProtocolCarousel } from '../../components/protocol-carousel';
import { Reveal, RevealGroup, RevealItem } from '../../components/reveal';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let protocols: LeaderboardEntry[] | null = null;
  try {
    protocols = await getProtocols();
  } catch {
    protocols = null; // proof strip degrades gracefully; the pitch still stands
  }

  // EVERY scored protocol, not a top three: the strip is a carousel now, so
  // there is no row length to cut the registry down to. A truncated strip and a
  // complete one looked identical, which on the page that claims live coverage
  // is exactly the wrong ambiguity to ship.
  const scored = (protocols ?? []).filter((p) => p.safetyScore !== null);

  return (
    <>
      {/* ---------- Hero ---------- */}
      <section className="relative overflow-hidden">
        {/* The dotted backdrop stays (white-alpha texture, no hue). The teal
            radial glow that used to sit here is gone: an ambient wash of the
            accent is the accent behaving as decoration, which is exactly what
            this palette is built to avoid. */}
        <div className="grid-backdrop pointer-events-none absolute inset-0" />
        <div className="relative mx-auto max-w-6xl px-5 pb-20 pt-20 sm:pt-28">
          <Reveal>
            <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
              Live risk intelligence for Stellar / Soroban DeFi
            </span>
          </Reveal>

          <Reveal delay={0.06}>
            <h1 className="mt-6 max-w-3xl font-display text-4xl font-semibold leading-[1.08] tracking-tight text-ink sm:text-6xl">
              Audits are a snapshot. Risk moves <span className="text-accent-ink">every block</span>
              .
            </h1>
          </Reveal>

          <Reveal delay={0.12}>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              Stenion reads lending protocols straight from the chain and scores their safety
              continuously — collateral concentration, oracle staleness, admin-key control,
              liquidity and utilization. Then it shows its work.
            </p>
          </Reveal>

          <Reveal delay={0.18}>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/registry"
                className="group inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Explore the registry
                <ArrowRight
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
              <Link
                href="/methodology"
                className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Read the methodology
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- Live proof ---------- */}
      <section className="mx-auto max-w-6xl px-5 py-6">
        <Reveal>
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl font-semibold text-ink">
                Scored right now, from on-chain data
              </h2>
              <p className="mt-1 text-sm text-muted">
                Not a mock. These numbers are recomputed on every indexer cycle.
              </p>
            </div>
            <Link
              href="/registry"
              className="hidden shrink-0 items-center gap-1 text-sm text-accent-ink transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm sm:inline-flex"
            >
              All protocols <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </Reveal>

        {scored.length === 0 ? (
          <div className="mt-6 rounded-xl border border-line bg-surface p-6 text-sm text-muted">
            Live scores are warming up — the indexer hasn&apos;t published a run yet.{' '}
            <Link
              href="/registry"
              className="text-accent-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
            >
              Open the registry
            </Link>{' '}
            to check again.
          </div>
        ) : (
          <Reveal className="mt-6">
            <ProtocolCarousel protocols={scored} />
          </Reveal>
        )}

        {/* Marks appear on this page too, so the note travels with them. */}
        {scored.length > 0 && <MarkAttribution className="mt-6 max-w-7xl" />}
      </section>

      {/* ---------- Why continuous ---------- */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <Reveal>
          <h2 className="max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink">
            A one-time audit can&apos;t see today&apos;s risk
          </h2>
          <p className="mt-3 max-w-2xl text-muted">
            TVL dashboards tell you how much is at stake. Audits tell you the code was sound on a
            date. Neither tells you the pool is 95% concentrated in one asset, or that an oracle
            went stale six hours ago. Stenion does — continuously.
          </p>
        </Reveal>

        <RevealGroup className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: Camera,
              title: 'Audits are static',
              body: 'A code review is a snapshot of a point in time. Positions, oracles, and admin keys all change after the auditors leave.',
            },
            {
              icon: Coins,
              title: 'TVL is not risk',
              body: 'A billion dollars in a single-asset pool near its utilization cap is riskier than a diversified pool a tenth the size. Size isn’t safety.',
            },
            {
              icon: Activity,
              title: 'Stenion is live',
              body: 'Adapters read Soroban RPC + Horizon on an interval and re-score. Every number is timestamped and freshness-flagged.',
            },
          ].map((c) => (
            <RevealItem key={c.title}>
              <div className="h-full rounded-xl border border-line surface-lit p-6">
                <div className="grid h-10 w-10 place-items-center rounded-lg bg-surface-2 ring-1 ring-inset ring-line">
                  <c.icon className="h-5 w-5 text-accent" strokeWidth={2} />
                </div>
                <h3 className="mt-4 font-medium text-ink">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{c.body}</p>
              </div>
            </RevealItem>
          ))}
        </RevealGroup>
      </section>

      {/* ---------- Factor teaser ---------- */}
      <section className="mx-auto max-w-6xl px-5 py-10">
        {/* `panel-glow` (globals.css) adds a drifting layer BEHIND this panel's
            content. Scoped here only. The nested factor cards keep their opaque
            bg-surface, which is what keeps them crisp over it. */}
        <div className="panel-glow rounded-2xl border border-line surface-lit p-8 sm:p-10">
          <Reveal>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="font-display text-2xl font-semibold text-ink">
                  Five factors, one transparent formula
                </h2>
                <p className="mt-2 max-w-xl text-sm text-muted">
                  Every protocol is graded on the same five dimensions, each 0–100 and
                  higher-is-safer, anchored to the protocol&apos;s own on-chain parameters wherever
                  they exist. The exact thresholds are public and challengeable.
                </p>
              </div>
              <Link
                href="/methodology"
                className="inline-flex items-center gap-1 text-sm text-accent-ink transition-colors hover:text-ink"
              >
                Full methodology <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </Reveal>

          <RevealGroup className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              { icon: Boxes, name: 'Collateral', hint: 'Concentration (HHI)' },
              { icon: Timer, name: 'Oracle', hint: 'Price-feed freshness' },
              { icon: KeyRound, name: 'Admin key', hint: 'Signer control' },
              { icon: Waves, name: 'Liquidity', hint: 'Withdrawal cushion' },
              { icon: Gauge, name: 'Utilization', hint: 'Headroom to cap' },
            ].map((f) => (
              <RevealItem key={f.name}>
                <div className="rounded-lg border border-line-soft bg-surface p-4">
                  <f.icon className="h-5 w-5 text-accent" strokeWidth={2} />
                  <div className="mt-3 text-sm font-medium text-ink">{f.name}</div>
                  <div className="mt-0.5 text-xs text-faint">{f.hint}</div>
                </div>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* ---------- Trust rules ---------- */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <Reveal>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-ink">
            Rules that can&apos;t be bought
          </h2>
          <p className="mt-3 max-w-2xl text-muted">
            The score only reflects real, on-chain data. These are non-negotiable and written into
            the methodology.
          </p>
        </Reveal>

        <RevealGroup className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: ShieldOff,
              title: 'Payment never moves the number',
              body: 'Protocols can pay for visibility, speed, or private tooling — never for a better score. Paid placement is a separate, clearly labeled section.',
            },
            {
              icon: Bot,
              title: 'AI explains, never decides',
              body: 'Any AI feature summarizes the real underlying data. It never generates an independent risk assessment or invents a value.',
            },
            {
              icon: BadgeCheck,
              title: 'Trustless & open',
              body: 'Adapters read directly from Soroban RPC and Horizon — nothing is self-reported by protocols. One adapter per protocol, open-source and PR-reviewed.',
            },
          ].map((c, i) => (
            <RevealItem key={c.title}>
              {/* `border-sheen` (globals.css) — the same travelling light the
                  live-score cards carry, unmodified. These three are the other
                  place on the site where the claim is "this is alive and it is
                  ours": the score cards say the numbers are being computed right
                  now, and these say the rules holding them can't be bought. The
                  negative delay spreads the three lights around the loop rather
                  than firing them in unison, and it is offset from the score
                  strip's own stagger so the two sections aren't in step. */}
              <div
                style={{ '--sheen-delay': `${i * -3 - 1.5}s` } as React.CSSProperties}
                className="border-sheen h-full rounded-xl border border-line surface-lit p-6"
              >
                <c.icon className="h-5 w-5 text-accent" strokeWidth={2} />
                <h3 className="mt-4 font-medium text-ink">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{c.body}</p>
              </div>
            </RevealItem>
          ))}
        </RevealGroup>

        <Reveal delay={0.1}>
          <div className="mt-12 flex flex-col items-start justify-between gap-5 rounded-2xl border border-line bg-surface-2 p-8 sm:flex-row sm:items-center">
            <div>
              <h3 className="font-display text-xl font-semibold text-ink">
                See where the protocols stand
              </h3>
              <p className="mt-1 text-sm text-muted">
                Ranked purely by safety score. Free, public, payment-blind.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/registry"
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-bg transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Open the registry <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Contribute an adapter on GitHub (opens in a new tab)"
                className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Contribute an adapter
              </a>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
