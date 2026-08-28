import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GITHUB_URL, RENDERED_DOC_ROUTES } from '../app/lib/site';
import { CodeBlock } from './code-block';

const REPO_BLOB = `${GITHUB_URL}/blob/main`;

/** Flatten React children to a plain string (for deriving heading anchor ids). */
function toText(node: React.ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return toText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return '';
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Resolve a repo-relative link against the folder the doc it was written in
 * lives in, into a path from the repo root.
 *
 * Needed since the rendered docs became folders: `methodology/lending.md` links
 * to a sibling as `publishing-rules.md` and to a repo file as
 * `../core/src/weights.ts`, and both must resolve the same way here as they do
 * on GitHub. Before the split every doc sat at the repo root, so a link was
 * already root-relative and this was a no-op — which is what an empty
 * `basePath` still gives.
 */
function resolveRepoPath(href: string, basePath: string): string {
  const out: string[] = [];
  for (const segment of [...basePath.split('/'), ...href.split('/')]) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

// react-markdown gives no heading ids and leaves links repo-relative. We add
// slug ids (so the doc's own in-page anchors work) and rewrite relative links to
// the GitHub source (so file references like `adapters/blend/index.ts` resolve).
//
// A function of `basePath` rather than a module constant, because the `a`
// override needs it and every other override is independent of it.
const makeComponents = (basePath: string): Components => ({
  h1: ({ children }) => <h1 id={slug(toText(children))}>{children}</h1>,
  h2: ({ children }) => <h2 id={slug(toText(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slug(toText(children))}>{children}</h3>,
  // h4 too: METHODOLOGY.md's per-factor sub-sections are h4s and are linked to
  // from elsewhere in the doc. Without an id those anchors work on GitHub and
  // silently dead-end on the site.
  h4: ({ children }) => <h4 id={slug(toText(children))}>{children}</h4>,
  // h5/h6 for the same reason, and they exist because METHODOLOGY.md is now
  // organized per category: every factor heading sits one level deeper under its
  // category's section, so `#2e. The oracle-legibility precondition` — linked
  // from §2 — moved from h4 to h5. Mapping every level the document can reach
  // means a future nesting change cannot quietly break an in-page link again.
  h5: ({ children }) => <h5 id={slug(toText(children))}>{children}</h5>,
  h6: ({ children }) => <h6 id={slug(toText(children))}>{children}</h6>,
  // METHODOLOGY.md has several wide multi-column tables. A prose table is
  // width:100%, but its min-content width is set by its longest cell, so on a
  // narrow screen the table sets a floor on the page width and scrolls the whole
  // document sideways. Give each table its own horizontal scroll container.
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  // Fenced code blocks get a copy button. react-markdown hands `pre` a single
  // `code` child, so the raw text is flattened here rather than inside the client
  // component — it has the React nodes, and a DOM read-back would be at the mercy
  // of whatever whitespace the browser reports.
  pre: ({ children }) => <CodeBlock raw={toText(children)}>{children}</CodeBlock>,
  a: ({ href, children }) => {
    const h = href ?? '';
    if (h.startsWith('#')) return <a href={h}>{children}</a>;
    if (/^https?:\/\//.test(h)) {
      return (
        <a href={h} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    }
    // A repo-relative link. Most resolve to the GitHub source, because most of
    // the docs a rendered page references (architecture/, an adapter file) only
    // exist there. The exception is a doc that IS rendered on this site: sending
    // a reader from /docs/api out to raw markdown on GitHub for the methodology
    // is worse than keeping them here, so those few map to their own route.
    // Written as one relative link so the same file still resolves on GitHub.
    const [rawPath, hash] = h.split('#');
    const file = resolveRepoPath(rawPath, basePath);
    const route = RENDERED_DOC_ROUTES[file];
    if (route) return <a href={hash ? `${route}#${hash}` : route}>{children}</a>;
    return (
      <a href={`${REPO_BLOB}/${file}${hash ? `#${hash}` : ''}`} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
});

/**
 * Render a markdown string with the Stenion dark prose theme.
 *
 * `basePath` is the repo folder the source was assembled from ('methodology',
 * 'api-docs'), and is what the doc's own relative links resolve against. Omit it
 * for a doc that lives at the repo root.
 */
export function MarkdownDoc({ source, basePath = '' }: { source: string; basePath?: string }) {
  return (
    <div className="prose prose-stenion max-w-none prose-headings:font-display prose-headings:tracking-tight prose-h1:text-3xl prose-h2:mt-12 prose-h2:border-t prose-h2:border-line prose-h2:pt-8 prose-a:no-underline hover:prose-a:underline">
      <Markdown remarkPlugins={[remarkGfm]} components={makeComponents(basePath)}>
        {source}
      </Markdown>
    </div>
  );
}
