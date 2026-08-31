// Server-side data access for the dashboard's Server Components.
//
// ARCHITECTURE NOTE — deploy merge (2026-08-12). The public API used to be a
// separate @stenion/api service that this module fetched over HTTP (STENION_API_URL).
// For the Vercel deploy the API is merged INTO this Next.js app as Route Handlers
// (app/api/v1/protocols, app/api/v1/protocols/export, app/api/v1/coverage,
// app/api/v1/protocol/[id], app/api/v1/health) so there is one deployable, not two.
//
// Because the dashboard renders on the server, its pages now read the same
// @stenion/db Store DIRECTLY here — no HTTP hop, no self-fetch. Self-fetching our
// own routes would need an absolute base URL AND could be blocked by Vercel's
// deployment protection on preview URLs, so a direct in-process Store call is both
// simpler and more robust. The HTTP routes still exist and return the identical
// shapes for EXTERNAL consumers (wallets/third parties) — this module and those
// routes both go through the same Store methods, so the contract can't drift.
//
// This file is SERVER-ONLY (it imports `pg` transitively via @stenion/db). The
// `server-only` import makes a build fail loudly if a client component ever
// imports it. Client components must import the contract TYPES from ./contract.

import 'server-only';
import { createStore, getPool, type Store } from '@stenion/db';

import type { LeaderboardEntry, ProtocolDetail } from './contract';

// Re-export the contract types + FACTOR_ORDER so existing server-component
// importers (`from '../lib/api'`) keep working unchanged.
export * from './contract';

// One Store per server process, created lazily on first use and reused across
// warm invocations (the underlying pg Pool is a module singleton — see
// @stenion/db's getPool). Never closed here: closing it would break connection
// reuse on the next warm request; the Neon pooler manages the actual connections.
let store: Store | undefined;
function getStore(): Store {
  if (!store) store = createStore(getPool());
  return store;
}

/**
 * The leaderboard: every protocol with its latest-ok score, ranked by score desc.
 * Delegates to the same Store method the HTTP route uses, so both agree.
 */
export async function getProtocols(): Promise<LeaderboardEntry[]> {
  return getStore().listProtocolsWithLatestScore();
}

/**
 * One protocol's detail, or null if the id is unknown (the page renders
 * notFound() on null — same behaviour as the old 404-from-fetch path).
 */
export async function getProtocolDetail(id: string): Promise<ProtocolDetail | null> {
  return getStore().getProtocolDetail(id);
}
