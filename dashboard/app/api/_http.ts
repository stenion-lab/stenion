// HTTP shaping for the public API routes — headers, status, JSON envelope.
//
// Split out of _shared.ts so it can be tested. _shared.ts imports `server-only`
// and `@stenion/db`, and `server-only` is a bare specifier that only Next's
// bundler resolves, so importing it from a plain Node test fails outright. This
// module deliberately imports nothing: it is the part of the response contract
// that is pure, and therefore the part worth pinning.

// CORS for the PUBLIC data routes only. Stenion's /v1/protocols + /v1/protocol/:id serve
// public, read-only, payment-blind data — any origin may read them (a wallet, a
// third-party dashboard, anyone), so `*` is the correct, simplest policy, carried
// over verbatim from the standalone @stenion/api. NOTE: the Stenion dashboard's
// own pages do NOT rely on this — they read the Store in-process (see app/lib/api.ts),
// never cross-origin. CORS here is purely for external browser clients. The cron
// route deliberately gets NO CORS (it's secret-gated, not public).
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/** JSON response carrying the CORS headers, matching the shipped API contract. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}
