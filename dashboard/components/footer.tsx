import Link from 'next/link';
import { Github } from 'lucide-react';
import { GITHUB_URL, NAV_LINKS } from '../app/lib/site';
import { FooterStatusPill } from './footer-status-pill';

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line/70">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <div className="font-display text-base font-semibold text-ink">Stenion</div>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Continuous, on-chain-derived risk intelligence for Stellar / Soroban DeFi. The score
              is public, free, and payment-blind always.
            </p>
          </div>

          <div className="flex gap-12">
            <nav aria-label="Site navigation" className="flex flex-col gap-2 text-sm">
              <span className="text-xs uppercase tracking-wider text-faint">Site</span>
              {NAV_LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
                >
                  {l.label}
                </Link>
              ))}
            </nav>
            <nav aria-label="Community and documentation" className="flex flex-col gap-2 text-sm">
              <span className="text-xs uppercase tracking-wider text-faint">Open source</span>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="GitHub (opens in a new tab)"
                className="inline-flex items-center gap-1.5 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              >
                <Github className="h-3.5 w-3.5" aria-hidden="true" /> GitHub
              </a>
              <Link
                href="/methodology"
                className="text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              >
                Methodology
              </Link>
              <Link
                href="/docs/api"
                className="text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              >
                API docs
              </Link>
              <Link
                href="/status"
                className="text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
              >
                Status
                <FooterStatusPill />
              </Link>
            </nav>
          </div>
        </div>

        <div className="mt-10 border-t border-line-soft pt-6 text-xs text-faint">
          Not audited financial advice. Stenion surfaces on-chain risk signals; it does not custody
          funds or endorse any protocol.
        </div>
      </div>
    </footer>
  );
}
