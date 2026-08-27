'use client';

// Search, filter and sort for the registry.
//
// IT IS A REAL <form method="get">, and that is the whole design. The page is a
// Server Component that renders from the URL, so this control's only job is to
// change the URL — it never holds the protocol list and never filters one.
// Three things follow, and all three were requirements rather than bonuses:
//
//  1. It works with JavaScript off. The form submits, the server renders the
//     filtered page. The enhancement below only makes it feel live.
//  2. Every view is linkable and survives a reload, because the state IS the
//     URL rather than a copy of it living in a component.
//  3. Every reason, summary and status phrase stays in the server-rendered
//     HTML. Client-side filtering would have moved that text behind an
//     interaction, and find-in-page and search indexing are how someone looking
//     for a specific protocol reaches an unscored entry at all.
//
// The enhancement is deliberately thin: debounce the text box, submit the
// selects on change, and replace rather than push so the back button leaves the
// registry in one step instead of walking back through every keystroke.

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';

import { cn } from '../app/lib/cn';
import {
  REGISTRY_SORTS,
  registryHref,
  type RegistryCategoryFilter,
  type RegistryParams,
  type RegistrySort,
  type RegistryStatusFilter,
} from '../app/lib/registry-query';

/** How long to wait after the last keystroke before navigating. */
const DEBOUNCE_MS = 220;

const SORT_LABELS: Record<RegistrySort, string> = {
  'score-desc': 'Score: high to low',
  'score-asc': 'Score: low to high',
  name: 'Name: A–Z',
};

export interface RegistryControlsProps {
  params: RegistryParams;
  /**
   * The coverage statuses that actually have published members, with their
   * headings — never the full union. Offering a filter for a status with
   * nothing under it describes members that aren't there, the same failure
   * groupCoverage avoids for headings.
   */
  coverageStatuses: { value: string; label: string }[];
  /**
   * The protocol categories the board actually contains.
   *
   * The select renders only when there are TWO OR MORE. With one category the
   * choice is between "all" and the only thing there is — a control whose every
   * setting shows the same rows, which is noise rather than a filter.
   */
  categories: { value: string; label: string }[];
  className?: string;
}

export function RegistryControls({
  params,
  coverageStatuses,
  categories,
  className,
}: RegistryControlsProps) {
  const router = useRouter();
  const [q, setQ] = useState(params.q);
  // Navigating to a Server Component route is not instant: the RSC payload is a
  // round trip. Without a pending signal the control looks broken for that
  // window — the reader changes the sort, nothing moves, and they reach for
  // refresh. `isPending` is React's own answer to that, and it is honest: it is
  // true exactly while the new result set is in flight.
  const [isPending, startTransition] = useTransition();

  // The last value we navigated to. Without it, the effect below fires again on
  // the render that our own navigation caused, and a fast typist gets their
  // caret yanked by a redundant replace.
  const pushed = useRef(params.q);

  // Back/forward, or a link into a different search: adopt the URL's value.
  // Guarded on `pushed` so this never fights the user mid-word — it only runs
  // when the URL changed to something we did not put there.
  useEffect(() => {
    if (params.q !== pushed.current) {
      pushed.current = params.q;
      setQ(params.q);
    }
  }, [params.q]);

  // Depends on the PRIMITIVES, never on `params` itself. The page rebuilds that
  // object on every server render, so a `params` dependency re-runs this effect
  // — clearing and re-arming the timer — on renders that changed nothing about
  // the search. With a slow round trip that can defer the navigation the reader
  // is waiting for, which is the failure mode this control exists to avoid.
  const { status, category, sort } = params;
  useEffect(() => {
    if (q === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = q;
      startTransition(() => {
        // `scroll: false` keeps the reader where they are. Jumping to the top on
        // every keystroke would make the results they are reading unreadable.
        // Every param is carried, not just the query — a search typed inside a
        // filtered view must not silently drop the filter.
        router.replace(registryHref({ q, status, category, sort }), { scroll: false });
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, status, category, sort, router]);

  const go = (next: Partial<RegistryParams>) => {
    pushed.current = next.q ?? q;
    startTransition(() => {
      router.replace(registryHref({ ...params, q, ...next }), { scroll: false });
    });
  };

  return (
    <form
      // Both are what makes the no-JS path work: without an action the form has
      // nowhere to submit, and GET is what puts the fields in the query string.
      action="/registry"
      method="get"
      onSubmit={(e) => {
        e.preventDefault();
        go({ q });
      }}
      className={cn('flex flex-col gap-3 sm:flex-row sm:items-center', className)}
      role="search"
    >
      <div className="relative flex-1">
        {/* One slot, two icons: the magnifier idle, a spinner in flight. Same
            position and size, so nothing shifts as it swaps. */}
        {isPending ? (
          <Loader2
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-accent-ink motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
        )}
        <label htmlFor="registry-q" className="sr-only">
          Search protocols by name
        </label>
        <input
          id="registry-q"
          name="q"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name — scored and unscored"
          autoComplete="off"
          spellCheck={false}
          // `search` inputs render a native clear affordance in some browsers;
          // the button below is the one that also clears the URL, so both being
          // present is deliberate rather than redundant.
          className="w-full rounded-lg border border-line bg-surface py-2.5 pl-9 pr-9 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        {q !== '' && (
          <button
            type="button"
            onClick={() => {
              setQ('');
              go({ q: '' });
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex gap-3">
        <Select
          id="registry-status"
          name="status"
          label="Show"
          value={params.status}
          onChange={(value) => go({ status: value as RegistryStatusFilter })}
        >
          <option value="all">All entries</option>
          <option value="scored">Scored</option>
          <option value="not-scored">Assessed, not scored</option>
          {coverageStatuses.length > 0 && (
            <optgroup label="Not scored, because">
              {coverageStatuses.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          )}
        </Select>

        {/* Only once there is a second category. One category makes every
            setting of this control show the same rows. */}
        {categories.length > 1 && (
          <Select
            id="registry-category"
            name="category"
            label="Category"
            value={params.category}
            onChange={(value) => go({ category: value as RegistryCategoryFilter })}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        )}

        <Select
          id="registry-sort"
          name="sort"
          label="Sort"
          value={params.sort}
          onChange={(value) => go({ sort: value as RegistrySort })}
        >
          {REGISTRY_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>

      {/* The no-JS submit. Hidden from pointer users once the enhancement is
          live — but only visually, and only via CSS that requires JS to have
          run, so a browser without it still shows a working button. */}
      <noscript>
        <button
          type="submit"
          className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Search
        </button>
      </noscript>
    </form>
  );
}

function Select({
  id,
  name,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 sm:flex-none">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        name={name}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-auto"
      >
        {children}
      </select>
    </div>
  );
}
