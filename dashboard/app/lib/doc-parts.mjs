// The repo-root docs are folders, not single files: METHODOLOGY.md became
// methodology/, ARCHITECTURE.md became architecture/, API.md became api/.
//
// ORDER IS THE CONTENT. Each list below concatenates, in order, back to exactly
// the file it replaced — the rendered pages join the parts with no separator, so
// a reordering here silently reorders the published document.
//
// Plain .mjs on purpose: next.config.mjs and the App Router pages both import
// this, and a TS module cannot be imported by the Next config. One list, so the
// route's `outputFileTracingIncludes` cannot fall behind the files the route
// actually reads — that gap is #96's failure mode, which is invisible in
// `next dev` and 404s only on Vercel.

/** @type {readonly string[]} */
export const METHODOLOGY_PARTS = [
  'methodology/index.md',
  'methodology/lending.md',
  'methodology/dex.md',
  'methodology/publishing-rules.md',
];

/** @type {readonly string[]} */
export const ARCHITECTURE_PARTS = [
  'architecture/index.md',
  'architecture/monorepo-layout.md',
  'architecture/data-flow.md',
  'architecture/deploy-architecture.md',
];

// `api-docs/`, not `api/`: the repo root already has an `api/` — the legacy
// @stenion/api workspace package — and dropping markdown into a package
// directory would put the public API contract inside a package that is kept
// but not deployed.
/** @type {readonly string[]} */
export const API_PARTS = [
  'api-docs/index.md',
  'api-docs/protocols.md',
  'api-docs/coverage.md',
  'api-docs/protocol-by-id.md',
  'api-docs/health.md',
  'api-docs/conventions.md',
];

/** Every doc part, whatever folder it lives in — for link rewriting and tracing. */
export const ALL_DOC_PARTS = [...METHODOLOGY_PARTS, ...ARCHITECTURE_PARTS, ...API_PARTS];
