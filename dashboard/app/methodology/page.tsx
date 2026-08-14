import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BookOpenText, ExternalLink, FileWarning } from 'lucide-react';
import { MarkdownDoc } from '../../components/markdown-doc';
import { METHODOLOGY_SOURCE_URL } from '../lib/site';
import { Reveal } from '../../components/reveal';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'The public, challengeable rulebook: exactly how Stenion computes every safety factor, its thresholds and weights.',
};

// The methodology lives at the repo root as the single source of truth shared
// with the adapters. We render that same file here rather than duplicating it.
// (next.config pins outputFileTracingRoot to the repo root and includes this
// file for the /methodology route, so it's bundled in the serverless output.)
async function loadMethodology(): Promise<string | null> {
  try {
    const p = path.join(process.cwd(), '..', 'METHODOLOGY.md');
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export default async function MethodologyPage() {
  const source = await loadMethodology();

  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      <Reveal>
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs text-muted">
          <BookOpenText className="h-3.5 w-3.5 text-accent" />
          The rulebook
        </span>
        <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink">
          Methodology
        </h1>
        <p className="mt-3 text-muted">
          Every formula, threshold, and weight Stenion uses — extracted directly from the shipped
          adapter code. It exists so anyone, including the protocols being scored, can verify and
          challenge the rules, not just the output. Code and this document are not allowed to drift.
        </p>
        <a
          href={METHODOLOGY_SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface/60 px-4 py-2 text-sm text-ink transition-colors hover:border-accent/40"
        >
          View source on GitHub <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Reveal>

      <Reveal delay={0.08} className="mt-12">
        {source ? (
          <MarkdownDoc source={source} />
        ) : (
          <div className="rounded-xl border border-danger/25 bg-danger/5 p-8 text-center">
            <FileWarning className="mx-auto h-8 w-8 text-danger" />
            <h2 className="mt-4 font-display text-lg font-semibold text-ink">
              Couldn&apos;t load the methodology
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              The rendered copy is temporarily unavailable. You can always read the canonical source
              on GitHub.
            </p>
            <a
              href={METHODOLOGY_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-flex items-center gap-1.5 text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              Open METHODOLOGY.md <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </Reveal>
    </div>
  );
}
