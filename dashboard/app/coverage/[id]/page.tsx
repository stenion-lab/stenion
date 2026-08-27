// A protocol we assessed and do not score, in full.
//
// WHY THIS ROUTE EXISTS AT ALL, AND WHY IT IS NOT /protocol/[id]. Giving these
// entries a `/protocol/<id>` page would take one of two bad shapes: an id the
// dashboard renders and `GET /api/v1/protocol/<id>` 404s on — the
// dashboard-vs-API divergence lib/api.ts exists to prevent — or a second,
// scoreless shape out of getProtocolDetail, which is the same divergence moved
// inside one function. `/coverage/<id>` avoids both by never touching that path:
// everything on this page comes from the static coverage module.
//
// THE URL IS THE DISCLAIMER. `/coverage/templar` says this is a page about
// Stenion's coverage of Templar, which is exactly what it is. `/protocol/templar`
// would assert a registry entry that does not exist. It also matches the
// /api/v1/coverage endpoint filed in ROADMAP.md, so if that ships, path and
// payload agree instead of colliding.
//
// WHAT MAKES IT VISUALLY UNMISTAKABLE. Not a label — the ABSENCE of the four
// things a score page is made of: there is no score ring, no factor grid, no
// history chart and no run list. A reader who has seen a protocol page reads
// that difference before they read any word on this one. On top of that,
// nothing here renders a numeral where a score would go, and nothing uses a
// band colour: a red or amber panel would say "dangerous" where the page means
// "we publish no number".

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, BookText, CircleSlash, ExternalLink, Globe, Search } from 'lucide-react';

import { getProtocols } from '../../lib/api';
import { COVERAGE_STATUS_META, coverageById, type CoverageEntry } from '../../lib/coverage';
import { contractExplorerUrl, shortenContractId } from '../../lib/explorer';
import { MarkAttribution, ProtocolLogo } from '../../../components/protocol-logo';
import { Reveal, RevealGroup, RevealItem } from '../../../components/reveal';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const entry = coverageById(id);
  // An unknown id makes the page below throw notFound(), which renders
  // app/not-found.tsx and supplies its own title. Anything returned here for a
  // missing entry is discarded, so don't pretend to set one.
  if (!entry) return {};
  return {
    // "not scored" in the title, because this is the text a shared link and a
    // search result render. A card reading just the protocol's name, from a site
    // that publishes safety scores, implies a score exists.
    title: `${entry.name} — not scored`,
    description: `Why Stenion publishes no safety score for ${entry.name}. ${entry.summary}`,
  };
}

export default async function CoveragePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entry = coverageById(id);
  // Real 404 status, not just the 404 UI — same constraint as the protocol
  // route: this only works because there is NO Suspense boundary above it. DO
  // NOT add a loading.tsx to this route without re-checking the status code.
  if (!entry) notFound();

  // The dedupe invariant, enforced on deep links too. The registry filters this
  // entry out once the live board scores it; a link straight to this URL would
  // otherwise keep showing a coverage note for a protocol we now score. The
  // redirect resolves such a link to the real score page instead.
  //
  // Fail-open on a database error, exactly as coverageToPublish does with an
  // empty `scoredIds`: this page is static and stays true during an outage, and
  // silently 500ing a page that needs no database would be the worse trade.
  // `redirect` is called OUTSIDE the try — it signals by throwing, and catching
  // that here would swallow the navigation.
  let scoredIds: string[] = [];
  try {
    scoredIds = (await getProtocols()).map((p) => p.id);
  } catch {
    scoredIds = [];
  }
  if (scoredIds.includes(entry.id)) redirect(`/protocol/${entry.id}`);

  const meta = COVERAGE_STATUS_META[entry.status];

  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <Reveal>
        <Link
          href="/registry"
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Registry
        </Link>
      </Reveal>

      <Header entry={entry} chip={meta.chip} />

      {/* The category, in the words the registry uses for it. Placed before the
          protocol-specific reasoning because it frames what kind of statement
          the reasoning is: a property of Stenion's scope, not a finding about
          this protocol. */}
      <Reveal delay={0.1} className="mt-8">
        <div className="rounded-2xl border border-line surface-lit p-6">
          <h2 className="font-display text-base font-semibold text-ink">{meta.heading}</h2>
          <p className="adapter-prose mt-2 text-sm leading-relaxed text-muted">{meta.blurb}</p>
        </div>
      </Reveal>

      <Reasoning entry={entry} />

      <Verify entry={entry} />

      <Reveal delay={0.05} className="mt-10">
        <p className="text-xs leading-relaxed text-faint">
          This page is a coverage decision, not an assessment of the protocol&rsquo;s safety, and
          nothing on it feeds any score. If {entry.name} becomes scorable, this page goes away in
          the same change that registers it — it is replaced by a real entry in the{' '}
          <Link href="/registry" className="underline hover:text-ink">
            registry
          </Link>
          , with a number derived from its own contracts.
        </p>
        <MarkAttribution className="mt-5 border-t border-line-soft pt-4" />
      </Reveal>
    </div>
  );
}

/**
 * The header, built to be read as the opposite of a score hero.
 *
 * A protocol page opens with a 176px score ring. This opens with a rule, a
 * phrase-not-a-number, and a sentence that states the negative outright. Saying
 * "no safety score — not a low one, not a zero" in the first line does more work
 * than any amount of styling: it forecloses the misreading instead of relying on
 * the reader to infer it from what's missing.
 */
function Header({ entry, chip }: { entry: CoverageEntry; chip: string }) {
  return (
    <Reveal delay={0.05} className="mt-6">
      {/* Dashed, neutral, full width — a register used nowhere else on the site,
          so the page announces its kind before the name is read. Never accent
          (that means "our data is stale") and never a band colour (that means
          "this is dangerous"). */}
      <div className="flex items-center gap-2 rounded-t-2xl border border-b-0 border-dashed border-line bg-surface-2/60 px-6 py-3">
        <CircleSlash className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-faint">
          Coverage note · not a score
        </span>
      </div>

      <div className="rounded-b-2xl border border-line surface-lit p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <ProtocolLogo name={entry.name} logo={entry.logo} size={44} />
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
            {entry.name}
          </h1>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-faint">
            <CircleSlash className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            {chip}
          </span>
        </div>

        <p className="mt-5 text-lg leading-relaxed text-ink">
          Stenion publishes <span className="font-semibold">no safety score</span> for {entry.name}
          &nbsp;— not a low one, not a zero.
        </p>
        <p className="adapter-prose mt-2 leading-relaxed text-muted">{entry.summary}</p>

        {(entry.links.site !== null || entry.links.docs !== null) && (
          <p className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {entry.links.site !== null && (
              <OutboundLink
                href={entry.links.site}
                icon={<Globe className="h-3.5 w-3.5" />}
                label={`${entry.name} website`}
                value="Protocol site"
              />
            )}
            {entry.links.docs !== null && (
              <OutboundLink
                href={entry.links.docs}
                icon={<BookText className="h-3.5 w-3.5" />}
                label={`${entry.name} documentation`}
                value="Docs"
              />
            )}
          </p>
        )}
      </div>
    </Reveal>
  );
}

/**
 * The protocol-specific reasoning — the thing the registry row can't carry and
 * the reason this page exists.
 *
 * Rendered open, never behind a disclosure: this is the content someone came
 * for, and both find-in-page and search indexing need it in the document.
 */
function Reasoning({ entry }: { entry: CoverageEntry }) {
  return (
    <section className="mt-12">
      <Reveal>
        <h2 className="font-display text-xl font-semibold text-ink">
          Why {entry.name} isn&rsquo;t scored
        </h2>
        <p className="mt-1 text-sm text-muted">
          What we found, stated as what is verified and what is inferred.{' '}
          <span className="text-faint">
            None of this is a risk finding, and none of it feeds a number.
          </span>
        </p>
      </Reveal>

      <RevealGroup className="mt-5 space-y-4" stagger={0.05}>
        {entry.reason.map((para, i) => (
          <RevealItem key={i}>
            <p className="adapter-prose leading-relaxed text-muted">{para}</p>
          </RevealItem>
        ))}
      </RevealGroup>
    </section>
  );
}

/**
 * How a reader checks it themselves, plus the date behind any measurement.
 *
 * The `verify` sentence is the bar for an entry existing at all (see the header
 * of coverage.ts), so it gets its own block rather than a footnote. The contract
 * link appears only where a full address was recorded — a truncated one cannot
 * build an explorer URL, and a half-built link is worse than none.
 */
function Verify({ entry }: { entry: CoverageEntry }) {
  return (
    <section className="mt-12">
      <Reveal>
        <div className="rounded-2xl border border-line surface-lit p-6">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted" />
            <h2 className="font-display text-base font-semibold text-ink">Verify this yourself</h2>
          </div>
          <p className="adapter-prose mt-3 text-sm leading-relaxed text-muted">{entry.verify}</p>

          {entry.contractId !== null && (
            <p className="mt-4">
              <OutboundLink
                href={contractExplorerUrl(entry.contractId)}
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                label={`${entry.name} contract on the explorer`}
                value={shortenContractId(entry.contractId)}
                title={entry.contractId}
                mono
              />
            </p>
          )}

          {/* The date is the honesty mechanism for anything resting on a
              reading: a balance is a measurement, and an undated one silently
              becomes a standing claim. It sits with the verify text so a reader
              sees how old the reading is at the moment they consider re-taking
              it. */}
          {entry.asOf !== null && (
            <p className="tnum mt-4 border-t border-line-soft pt-3 text-xs leading-relaxed text-faint">
              Figures above read on <time dateTime={entry.asOf}>{entry.asOf}</time>. Balances
              change; re-read them rather than relying on this date.
            </p>
          )}
        </div>
      </Reveal>
    </section>
  );
}

/**
 * One outbound reference. `nofollow` for the same reason as on a protocol page:
 * Stenion ranks protocols, so an unqualified outbound link from this site could
 * be read as conferring standing on the destination. It cannot, and shouldn't
 * look like it does.
 */
function OutboundLink({
  href,
  icon,
  label,
  value,
  title,
  mono = false,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label={`${label} (opens in a new tab)`}
      title={title}
      className="group inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-muted transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span aria-hidden="true">{icon}</span>
      <span className={mono ? 'adapter-prose font-mono text-xs' : ''}>{value}</span>
    </a>
  );
}
