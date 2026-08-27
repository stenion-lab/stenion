// How the status page interprets a response from `GET /api/v1/health`.
//
// A LEAF — it imports nothing, so it is loadable from a plain Node test under
// native type stripping, and so the client component that uses it never pulls a
// server-only module into the bundle. The types below mirror `HealthBody` in
// app/api/_health.ts, declared structurally rather than imported for that reason.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: 503 IS A SUCCESSFUL ANSWER, NOT A FAILED REQUEST
//
// `/api/v1/health` serves 503 for both `degraded` and `down` (see
// `healthHttpStatus`), and it serves them WITH a complete body. That is the
// endpoint's design: an uptime monitor reading only the status line catches the
// outage, and the human who then opens it gets the detail.
//
// A browser client that branches on `res.ok` therefore has it exactly inverted.
// `res.ok` is false for 503, so the status page would throw away a perfectly
// good body and render "Unable to load status" precisely in the two states it
// was built to display — and it would look identical to the health endpoint
// itself being broken, which is the one distinction this page exists to make.
//
// So the rule is: the STATUS LINE decides whether a body is expected, and the
// SHAPE decides whether we got one. 200 and 503 are the two codes the route
// answers a `HealthBody` on; everything else (429 from the rate limiter, the
// route's own generic 500, a platform 504 from a cold database, an HTML error
// page from a proxy) is a failure to find out, and is reported as one.
// ---------------------------------------------------------------------------

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface HealthProtocol {
  id: string;
  lastSuccessfulRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | null;
  staleMinutes: number | null;
}

export interface HealthResponse {
  status: HealthStatus;
  thresholdMinutes: number;
  protocols: HealthProtocol[];
}

/**
 * The two HTTP codes on which the route returns a `HealthBody`.
 *
 * 503 covers `degraded` and `down` alike — it is not an error here, and the
 * whole point of this module is that it must not be treated as one.
 */
export const HEALTH_BODY_STATUSES: readonly number[] = [200, 503];

/** What the page should do with a response. */
export type HealthFetchResult =
  { kind: 'data'; body: HealthResponse } | { kind: 'error'; message: string };

function isRunStatus(value: unknown): value is 'ok' | 'failed' | null {
  return value === 'ok' || value === 'failed' || value === null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isHealthProtocol(value: unknown): value is HealthProtocol {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    isNullableString(p.lastSuccessfulRunAt) &&
    isNullableString(p.lastRunAt) &&
    isRunStatus(p.lastRunStatus) &&
    isNullableNumber(p.staleMinutes)
  );
}

/**
 * Structural check on a parsed body.
 *
 * Validated rather than cast because the two codes above are not exclusively
 * ours: a 503 can also come from a CDN or a load balancer with an HTML body, and
 * casting one of those would render a page of `undefined`s under a confident
 * "healthy". A body that fails this is treated as not having arrived.
 */
export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  if (b.status !== 'healthy' && b.status !== 'degraded' && b.status !== 'down') return false;
  if (typeof b.thresholdMinutes !== 'number' || !Number.isFinite(b.thresholdMinutes)) return false;
  return Array.isArray(b.protocols) && b.protocols.every(isHealthProtocol);
}

/**
 * An HTTP status the route does not answer a body on → the message to show.
 *
 * Each one names a different owner, because "could not load the status page" is
 * useless to whoever has to fix it.
 */
export function fetchErrorMessage(httpStatus: number): string {
  if (httpStatus === 429) return 'Rate limited by the API (HTTP 429) — retrying shortly.';
  if (httpStatus === 504 || httpStatus === 502)
    return `The health endpoint did not respond in time (HTTP ${httpStatus}). The database may be cold.`;
  if (httpStatus >= 500) return `The health endpoint itself failed (HTTP ${httpStatus}).`;
  return `Unexpected response from the health endpoint (HTTP ${httpStatus}).`;
}

/**
 * Status line + parsed body → what to render.
 *
 * Pure, and takes the already-parsed body rather than a `Response`, so every
 * case this page can hit is reachable from a test without a fetch stub.
 */
export function interpretHealthResponse(httpStatus: number, body: unknown): HealthFetchResult {
  if (!HEALTH_BODY_STATUSES.includes(httpStatus)) {
    return { kind: 'error', message: fetchErrorMessage(httpStatus) };
  }
  if (!isHealthResponse(body)) {
    return {
      kind: 'error',
      message: `The health endpoint returned HTTP ${httpStatus} with an unrecognised body.`,
    };
  }
  return { kind: 'data', body };
}
