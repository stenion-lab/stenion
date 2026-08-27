// Tests for how the status page interprets `GET /api/v1/health`.
//
// WHY THESE EXIST: the case that matters most — a 503 carrying a complete,
// valid body — is unreachable from live data on any healthy deployment, and it
// is precisely the case the page previously got wrong (`if (!res.ok) throw`,
// which rendered "Unable to load status" for `degraded` and `down`: the two
// states the page was built to show). "The status page looked fine" proves
// nothing about it, because when the pipeline is healthy the endpoint answers
// 200 and that branch never runs. So it is pinned here.
//
// Run with: pnpm --filter @stenion/dashboard test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fetchErrorMessage,
  interpretHealthResponse,
  isHealthResponse,
  type HealthResponse,
} from './health-fetch.ts';

const body = (status: HealthResponse['status']): HealthResponse => ({
  status,
  thresholdMinutes: 30,
  protocols: [
    {
      id: 'blend',
      lastSuccessfulRunAt: '2026-08-27T16:30:21.952Z',
      lastRunAt: '2026-08-27T16:30:21.952Z',
      lastRunStatus: 'ok',
      staleMinutes: 79,
    },
  ],
});

describe('interpretHealthResponse', () => {
  it('accepts a 200 healthy body', () => {
    const result = interpretHealthResponse(200, body('healthy'));
    assert.equal(result.kind, 'data');
  });

  // THE REGRESSION. 503 is what the route serves for degraded and down, with a
  // full body attached. Treating it as a failed request is what broke the page.
  it('accepts a 503 degraded body rather than treating it as an error', () => {
    const result = interpretHealthResponse(503, body('degraded'));
    assert.equal(result.kind, 'data');
    if (result.kind === 'data') assert.equal(result.body.status, 'degraded');
  });

  it('accepts a 503 down body rather than treating it as an error', () => {
    const result = interpretHealthResponse(503, body('down'));
    assert.equal(result.kind, 'data');
    if (result.kind === 'data') assert.equal(result.body.status, 'down');
  });

  // The distinction the page exists to make: the pipeline being behind (503 with
  // a body) must not look the same as the health check itself being broken.
  it('reports the route’s own 500 as an error', () => {
    const result = interpretHealthResponse(500, { error: 'Internal server error' });
    assert.equal(result.kind, 'error');
  });

  it('reports a 429 from the rate limiter as an error', () => {
    const result = interpretHealthResponse(429, { error: 'Too many requests' });
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.match(result.message, /429/);
  });

  // A 503 is not exclusively ours — a CDN or load balancer serves them too, with
  // an HTML body. Casting one of those would render a page of undefineds.
  it('rejects a 503 whose body is not a health body', () => {
    const result = interpretHealthResponse(503, '<html>Service Unavailable</html>');
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.match(result.message, /unrecognised body/);
  });

  it('rejects a 200 whose body is malformed', () => {
    const result = interpretHealthResponse(200, { status: 'healthy', protocols: [] });
    assert.equal(result.kind, 'error');
  });
});

describe('isHealthResponse', () => {
  it('accepts an empty protocol list', () => {
    assert.equal(isHealthResponse({ status: 'down', thresholdMinutes: 30, protocols: [] }), true);
  });

  it('accepts nulls on a never-scored protocol', () => {
    const never = {
      status: 'down',
      thresholdMinutes: 30,
      protocols: [
        {
          id: 'new',
          lastSuccessfulRunAt: null,
          lastRunAt: null,
          lastRunStatus: null,
          staleMinutes: null,
        },
      ],
    };
    assert.equal(isHealthResponse(never), true);
  });

  it('rejects an unknown overall status', () => {
    assert.equal(
      isHealthResponse({ status: 'unknown', thresholdMinutes: 30, protocols: [] }),
      false,
    );
  });

  it('rejects a protocol row missing its id', () => {
    const bad = {
      status: 'healthy',
      thresholdMinutes: 30,
      protocols: [
        { lastSuccessfulRunAt: null, lastRunAt: null, lastRunStatus: null, staleMinutes: null },
      ],
    };
    assert.equal(isHealthResponse(bad), false);
  });

  it('rejects null and non-objects', () => {
    assert.equal(isHealthResponse(null), false);
    assert.equal(isHealthResponse(undefined), false);
    assert.equal(isHealthResponse('healthy'), false);
  });
});

describe('fetchErrorMessage', () => {
  it('names a different owner per class of failure', () => {
    assert.match(fetchErrorMessage(429), /Rate limited/);
    assert.match(fetchErrorMessage(504), /did not respond in time/);
    assert.match(fetchErrorMessage(500), /health endpoint itself failed/);
    assert.match(fetchErrorMessage(404), /Unexpected response/);
  });
});
