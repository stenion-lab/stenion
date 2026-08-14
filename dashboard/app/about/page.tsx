import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Bot, GitPullRequest, Radar, ScanEye, ShieldOff } from 'lucide-react';
import { GITHUB_URL } from '../lib/site';
import { Reveal, RevealGroup, RevealItem } from '../../components/reveal';

export const metadata: Metadata = {
  title: 'About',
  description:
    'What Stenion is, why continuous scoring beats static audits and TVL trackers, and the trust rules that cannot be bought.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      <Reveal>
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs text-muted">
          <Radar className="h-3.5 w-3.5 text-accent" />
          About Stenion
        </span>
        <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
          Risk you can watch, not just read about
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-muted">
          Stenion is an open-source, live risk-intelligence platform for Stellar and Soroban DeFi
          lending protocols. It reads each protocol directly from the chain and continuously scores
          how safe it is right now — then publishes exactly how it got that number.
        </p>
      </Reveal>

      <Section title="Why continuous scoring">
        <p>
          Two things dominate how people currently judge DeFi risk, and both miss the moment that
          matters:
        </p>
        <ul className="mt-4 space-y-3">
          <li className="flex gap-3">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span>
              <strong className="text-ink">Static audits</strong> confirm the code was sound on a
              particular date. They say nothing about the pool becoming 95% concentrated in one
              asset, or an oracle drifting stale, weeks later.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span>
              <strong className="text-ink">TVL trackers</strong> (DeFiLlama already does this well
              for Stellar) measure how much is at stake — not how risky the position is. Size is not
              safety.
            </span>
          </li>
        </ul>
        <p className="mt-4">
          Stenion&apos;s differentiator is the gap between those two: continuous, on-chain-derived
          risk scoring — collateral concentration, oracle staleness, admin-key control, liquidity
          depth, and utilization headroom — recomputed on an interval and timestamped so you always
          know how fresh a number is.
        </p>
      </Section>

      <Section title="How the score is built">
        <p>
          Every protocol is graded on the same five factors, each on a 0–100 scale where higher is
          safer. The overall safety score is a fixed weighted mean of those factors. Wherever
          possible a factor is anchored to the protocol&apos;s <em>own</em> on-chain parameters —
          Stenion grades a pool against the line it set for itself, not against an arbitrary
          constant.
        </p>
        <p className="mt-4">
          Adapters read data directly from Soroban RPC and Horizon — official, trustless Stellar
          infrastructure — so nothing is self-reported by the protocols being scored. The exact
          formulas are public in the{' '}
          <Link href="/methodology" className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            methodology
          </Link>
          , and they&apos;re meant to be challenged.
        </p>
      </Section>

      <Reveal>
        <h2 className="mt-16 font-display text-2xl font-semibold text-ink">
          Rules that cannot be bought
        </h2>
        <p className="mt-2 text-muted">
          These are non-negotiable and enforced in the methodology itself.
        </p>
      </Reveal>
      <RevealGroup className="mt-6 grid gap-4 sm:grid-cols-2">
        {[
          {
            icon: ShieldOff,
            title: 'Payment never affects the score',
            body: 'Protocols can pay for visibility, speed, or private tooling — never for a better number. Paid "Spotlight" placement is a visually separate, clearly labeled section. The real ranking is always free, public, and purely score-ordered.',
          },
          {
            icon: Bot,
            title: 'AI never invents an assessment',
            body: 'Any AI feature only explains or summarizes the real underlying data. It never generates an independent risk judgment and never sets a score.',
          },
          {
            icon: ScanEye,
            title: 'No fabricated numbers',
            body: 'When real data genuinely isn’t available for a factor, Stenion uses a clearly-flagged neutral baseline and says so — never an invented, plausible-looking value.',
          },
          {
            icon: GitPullRequest,
            title: 'Open source, one adapter per protocol',
            body: 'Coverage grows DeFiLlama-style: each protocol is a small, open-source, PR-reviewed adapter reading directly from on-chain infra. Anyone can inspect, verify, or contribute one.',
          },
        ].map((c) => (
          <RevealItem key={c.title}>
            <div className="h-full rounded-xl border border-line surface-lit p-6">
              <c.icon className="h-5 w-5 text-accent" strokeWidth={2} />
              <h3 className="mt-4 font-medium text-ink">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{c.body}</p>
            </div>
          </RevealItem>
        ))}
      </RevealGroup>

      <Section title="Honest about the limits">
        <p>
          Stenion measures what it can read trustlessly on-chain, and is explicit about what it
          can&apos;t. Oracle scoring currently measures price <em>freshness</em>, not manipulation
          of a fresh price — a real, recorded limitation, not a hidden one. Every threshold is
          labeled as either anchored to an external/on-chain value or an unvalidated v1 judgment
          call open to challenge.
        </p>
        <p className="mt-4">
          It&apos;s built in the open by a solo developer in the Stellar ecosystem. If you think a
          threshold is wrong — especially if you&apos;re a protocol being scored — the methodology
          explains how to dispute it.
        </p>
      </Section>

      <Reveal>
        <div className="mt-14 flex flex-col items-start justify-between gap-5 rounded-2xl border border-line bg-gradient-to-br from-surface-2 to-surface p-8 sm:flex-row sm:items-center">
          <div>
            <h3 className="font-display text-xl font-semibold text-ink">See it working</h3>
            <p className="mt-1 text-sm text-muted">
              Live scores for the protocols Stenion tracks today.
            </p>
          </div>
          <div className="flex gap-3">
            <Link
              href="/registry"
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-accent to-accent-2 px-5 py-2.5 text-sm font-semibold text-bg transition-transform hover:-translate-y-0.5"
            >
              Open the registry <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-5 py-2.5 text-sm font-medium text-ink hover:border-accent/40"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </Reveal>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Reveal className="mt-14">
      <h2 className="font-display text-2xl font-semibold text-ink">{title}</h2>
      <div className="mt-4 space-y-1 leading-relaxed text-muted [&_strong]:font-semibold">
        {children}
      </div>
    </Reveal>
  );
}
