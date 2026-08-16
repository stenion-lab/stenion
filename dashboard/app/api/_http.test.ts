// Tests for the public API's HTTP envelope.
//
// WHY THESE EXIST: these headers are the part of the contract that no consumer
// ever asks for explicitly and every browser consumer depends on. A missing
// `access-control-allow-origin` doesn't fail a test, break a build, or show up
// on the dashboard's own pages — those read the Store in-process and never go
// cross-origin. It fails only in someone else's browser, silently, after deploy.
//
// The 404 *body* for an unknown id is covered end-to-end against a deployed URL
// by scripts/smoke-protocol-404.mjs; this covers the shaping underneath it.
//
// Run with: pnpm --filter @stenion/dashboard test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CORS_HEADERS, jsonResponse } from './_http.ts';

describe('jsonResponse', () => {
  it('defaults to 200 with a JSON content type', async () => {
    const res = jsonResponse({ protocols: [] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { protocols: [] });
  });

  it('carries CORS on every response, including errors', async () => {
    // The failure mode this guards: CORS applied only on the happy path, so a
    // third-party client sees an opaque network error instead of the 404 or 500
    // it could have handled.
    for (const status of [200, 404, 500]) {
      const res = jsonResponse({ error: 'x' }, status);
      assert.equal(res.status, status);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    }
  });

  it('serializes the documented 404 body for an unknown protocol id', async () => {
    // Matches what scripts/smoke-protocol-404.mjs asserts against a deployment.
    const res = jsonResponse({ error: 'Protocol not found', id: 'nope' }, 404);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Protocol not found', id: 'nope' });
  });

  it('emits a JSON null rather than an empty body for null', async () => {
    // `JSON.stringify(undefined)` is undefined, which would produce an empty
    // body with a JSON content type — unparseable for a client. null must not
    // go the same way.
    const res = jsonResponse(null);
    assert.equal(await res.text(), 'null');
  });

  it('does not mutate the shared CORS header object', async () => {
    // jsonResponse spreads CORS_HEADERS into a new object; if that ever became
    // a mutation, one route's status or content-type would leak into every
    // other response in the process.
    const before = { ...CORS_HEADERS };
    jsonResponse({ a: 1 }, 500);
    jsonResponse({ b: 2 });
    assert.deepEqual({ ...CORS_HEADERS }, before);
  });
});

describe('CORS_HEADERS', () => {
  it('allows any origin, for public payment-blind data', () => {
    assert.equal(CORS_HEADERS['access-control-allow-origin'], '*');
  });

  it('permits only GET and the preflight itself', () => {
    // The public API is read-only. If a write method ever appears here it should
    // be a deliberate decision, not an inherited default.
    const methods = CORS_HEADERS['access-control-allow-methods'];
    assert.match(methods, /GET/);
    assert.match(methods, /OPTIONS/);
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.doesNotMatch(methods, new RegExp(verb));
    }
  });
});
