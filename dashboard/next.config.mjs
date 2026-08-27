import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to the monorepo root. Without this, Next infers the
  // root from lockfiles and can pick a stray one outside the repo (it warned about
  // C:\Users\USER\pnpm-lock.yaml), which would break workspace-dependency tracing
  // on Vercel. The API + cron routes now live INSIDE this app (app/api/*) and read
  // @stenion/db / @stenion/indexer in-process, so their dist + node_modules must
  // trace correctly from the workspace root.
  outputFileTracingRoot: repoRoot,

  // `pg` (Postgres driver, pulled via @stenion/db) stays a runtime `require` rather
  // than being bundled into the serverless function.
  //
  // @stellar/stellar-sdk MUST NOT be added here — externalizing it is what broke the
  // cron route on the Next 15 -> 16 upgrade (#96), and re-adding it breaks it again:
  //
  //   @stenion/adapters compiles to CommonJS (no "type": "module"), so it reaches the
  //   SDK through the `require` condition -> lib/cjs/*, and the SDK's CJS build does
  //   `require('@noble/hashes/sha2.js')` — a package that is ESM-only since v2. That
  //   require only works on a runtime with require(esm) (Node >=22.12 / >=20.19);
  //   anywhere else it throws ERR_REQUIRE_ESM at import time, so the route 500s before
  //   the handler runs and the indexer silently stops.
  //
  //   Next 15 used webpack, which bundled the SDK and resolved that CJS->ESM edge at
  //   BUILD time, so the deployed runtime's Node version never mattered. Next 16 uses
  //   Turbopack, which honours this list and emits a native `require()` for it — the
  //   error surfaces through Turbopack's `externalRequire`, which is why the trace
  //   points at the bundler, but the bundler is only the messenger.
  //
  // Bundling the SDK is the Next 15 behaviour, and it is Node-version-independent —
  // verified by loading the production build with `--no-experimental-require-module`
  // (which simulates a pre-22.12 runtime): external => 500 ERR_REQUIRE_ESM, bundled =>
  // the route loads and a full cycle scores real on-chain data.
  serverExternalPackages: ['pg'],

  // The /methodology and /docs/api routes read their repo-root markdown file at
  // request time (single source of truth, not duplicated). Those files live
  // outside the dashboard dir, so include each explicitly in its route's
  // serverless bundle or the read 404s on Vercel — the failure is silent in dev,
  // where the file is simply there on disk.
  outputFileTracingIncludes: {
    '/methodology': ['../METHODOLOGY.md'],
    '/docs/api': ['../API.md'],
  },
};

export default nextConfig;
