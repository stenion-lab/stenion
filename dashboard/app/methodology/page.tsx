import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExternalLink, FileWarning } from 'lucide-react';
import { MarkdownDoc } from '../../components/markdown-doc';
import { METHODOLOGY_SOURCE_URL } from '../lib/site';
import { METHODOLOGY_PARTS } from '../lib/doc-parts.mjs';
import { Reveal } from '../../components/reveal';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'The public, challengeable rulebook: exactly how Stenion computes every safety factor, its thresholds and weights.',
};

// The methodology lives at the repo root as the single source of truth shared
// with the adapters. We render those same files here rather than duplicating
// them. (next.config pins outputFileTracingRoot to the repo root and traces
// every part for the /methodology route, so they're in the serverless output.)
//
// Joined on a single newline, which is exactly the blank line that used to sit
// between two sections of the one file. Prettier ends every part after its last
// non-blank line, so concatenating them raw would weld a section's closing `---`
// onto the next section's `##`; one newline puts the blank line back and the
// parts reassemble byte-for-byte into the METHODOLOGY.md this replaced.
//
// One missing part fails the whole read rather than rendering a document with a
// section silently absent — a half-rulebook that still looks complete is worse
// than the GitHub-fallback error state.
async function loadMethodology(): Promise<string | null> {
  try {
    const parts = await Promise.all(
      // `turbopackIgnore` because the part name is a variable now, and Turbopack's
      // static analysis answers "unknown path" by tracing the WHOLE repo into the
      // serverless output — a build warning, a slower deploy, and a real risk of
      // the size limit. What actually puts these files in the bundle is the
      // route's `outputFileTracingIncludes` entry, which names every part
      // explicitly from this same manifest; the analyser's guess was never what
      // carried them.
      METHODOLOGY_PARTS.map((part) =>
        readFile(path.join(/* turbopackIgnore: true */ process.cwd(), '..', part), 'utf8'),
      ),
    );
    return parts.join('\n');
  } catch {
    return null;
  }
}

export default async function MethodologyPage() {
  const source = await loadMethodology();

  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      <Reveal>
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
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
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-4 py-2 text-sm text-ink transition-colors hover:border-accent"
        >
          View source on GitHub <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Reveal>

      <Reveal delay={0.08} className="mt-12">
        {source ? (
          <MarkdownDoc source={source} basePath="methodology" />
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
              className="mt-5 inline-flex items-center gap-1.5 text-sm text-accent-ink hover:underline"
            >
              Open METHODOLOGY.md <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </Reveal>
    </div>
  );
}
