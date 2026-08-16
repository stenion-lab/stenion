// Shared server-side wiring for the merged public API routes.
//
// This lives under app/api/ but is named with a leading underscore folder-free
// (it's a plain module, not a route.ts), so Next never treats it as an endpoint.
// It is server-only — it imports @stenion/db (pg).
//
// The pure HTTP shaping (CORS_HEADERS, jsonResponse) lives in ./_http and is
// re-exported here so route files keep one import site. It is separate because
// `server-only` below is a bare specifier only Next's bundler resolves, which
// makes this module unimportable from a plain Node test — see _http.test.ts.

import 'server-only';
import { createStore, getPool, type Store } from '@stenion/db';

export { CORS_HEADERS, jsonResponse } from './_http';

// One Store per server process, reused across warm invocations (the pg Pool is a
// module singleton in @stenion/db). Deliberately never closed — closing would
// break reuse on the next request; the Neon pooler owns connection lifecycle.
let store: Store | undefined;
export function getStore(): Store {
  if (!store) store = createStore(getPool());
  return store;
}
