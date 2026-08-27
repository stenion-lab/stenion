import Link from 'next/link';
import { Github } from 'lucide-react';
import { GITHUB_URL, NAV_LINKS } from '../app/lib/site';

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
            <nav className="flex flex-col gap-2 text-sm">
              <span className="text-xs uppercase tracking-wider text-faint">Site</span>
              {NAV_LINKS.map((l) => (
                <Link key={l.href} href={l.href} className="text-muted hover:text-ink">
                  {l.label}
                </Link>
              ))}
            </nav>
            <nav className="flex flex-col gap-2 text-sm">
              <span className="text-xs uppercase tracking-wider text-faint">Open source</span>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-muted hover:text-ink"
              >
                <Github className="h-3.5 w-3.5" /> GitHub
              </a>
              <Link href="/methodology" className="text-muted hover:text-ink">
                Methodology
              </Link>
              <Link href="/docs/api" className="text-muted hover:text-ink">
                API docs
              </Link>
              <Link href="/status" className="text-muted hover:text-ink">
                Status
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
