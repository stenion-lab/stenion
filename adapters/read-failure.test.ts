// Tests for ./read-failure.ts — the line between a reading about the protocol
// and a reading about Stenion.
//
// WHAT MAKES THESE WORTH WRITING. Every branch here decides whether a number is
// published at all, and none of them can be reached from live data on demand: a
// 429 needs the shared endpoint to be under pressure, a 5xx needs Horizon to be
// broken, and a dropped connection needs the network to fail mid-cycle. Getting
// one wrong is silent — the pipeline goes on publishing, and what it publishes
// is a 0 that reads as "dangerous admin control" for a pool nobody could read.
//
// The `RateLimitExhaustedError` pass-through is the sharpest of them. `cycle.ts`
// flags a rate-limited failure by calling `isRateLimitExhausted` on the error it
// catches; wrapping one here would drop that flag and leave an operator reading
// a generic failure with no sign that the endpoint refused us.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_RATE_LIMIT_POLICY,
  RateLimitBudget,
  RateLimitExhaustedError,
  isRateLimitExhausted,
  runWithRateLimitBudget,
} from '@stenion/core';

import { horizonFetch } from './rate-limit.ts';
import {
  EndpointUnavailableError,
  SubjectAnswerError,
  isEndpointStatus,
  isEndpointUnavailable,
  isSubjectAnswer,
  readingOrRethrow,
  rethrowAsEndpointFailure,
  throwIfEndpointStatus,
} from './read-failure.ts';

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** A loopback Horizon that answers every request with one status. */
async function fakeHorizon(status: number, body = '{}') {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits };
}

// ---------------------------------------------------------------------------
// Which statuses are an answer about the subject
// ---------------------------------------------------------------------------

describe('an HTTP status is classified by what it is ABOUT', () => {
  it('treats a 4xx as Horizon answering about the subject', () => {
    // A 404 is "that account is not here", which is a fact about the account.
    // methodology/dex.md sends exactly this to the unsafe end as a reading, so
    // it must NOT be reclassified as a read-path failure.
    for (const status of [400, 403, 404, 410, 422]) {
      assert.equal(isEndpointStatus(status), false, `${status} is an answer about the subject`);
      assert.doesNotThrow(() => throwIfEndpointStatus('Horizon /accounts/GABC', status));
    }
  });

  it('treats a 429 and every 5xx as the endpoint reporting itself', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(isEndpointStatus(status), true, `${status} is not about the subject`);
      assert.throws(
        () => throwIfEndpointStatus('Horizon /accounts/GABC', status),
        (error: unknown) =>
          isEndpointUnavailable(error) && (error as EndpointUnavailableError).status === status,
        `${status} must fail the run`,
      );
    }
  });

  it('names the subject and the status in the message, and says whose failure it is', () => {
    // The message is what lands in `risk_scores.error` and in the alert body, so
    // it has to be diagnosable without the code in front of you.
    const error = new EndpointUnavailableError('Horizon /accounts/GABC', 'HTTP 503', 503);
    assert.match(error.message, /Horizon \/accounts\/GABC/);
    assert.match(error.message, /HTTP 503/);
    assert.match(error.message, /not a reading about the protocol/);
  });

  it('identifies its own errors by a literal name, never by instanceof', () => {
    // The workspace packages are minified into the dashboard's serverless
    // bundle, where a class name is renamed and two copies of a class fail
    // `instanceof` against each other. A structurally-identical error from
    // another bundle must still be recognised.
    const fromAnotherBundle = Object.assign(new Error('x'), { name: 'EndpointUnavailableError' });
    assert.equal(isEndpointUnavailable(fromAnotherBundle), true);
    assert.equal(new EndpointUnavailableError('s', 'd').name, 'EndpointUnavailableError');
    assert.equal(new SubjectAnswerError('m').name, 'SubjectAnswerError');
    assert.equal(
      isSubjectAnswer(Object.assign(new Error('x'), { name: 'SubjectAnswerError' })),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Throws
// ---------------------------------------------------------------------------

describe('a throw out of a transport call is never a reading', () => {
  it('wraps an ordinary throw as a read-path failure', () => {
    assert.throws(
      () => rethrowAsEndpointFailure('Horizon /accounts/GABC', new Error('ECONNRESET')),
      (error: unknown) =>
        isEndpointUnavailable(error) && /ECONNRESET/.test((error as Error).message),
    );
  });

  it('handles a non-Error throw without losing it', () => {
    assert.throws(
      () => rethrowAsEndpointFailure('subject', 'a bare string'),
      (error: unknown) =>
        isEndpointUnavailable(error) && /a bare string/.test((error as Error).message),
    );
  });

  it('passes a RateLimitExhaustedError through UNTOUCHED', () => {
    // cycle.ts sets `rateLimited: true` on the cycle summary by calling
    // `isRateLimitExhausted` on the error it catches. Wrapping one here would
    // still fail the run — correctly — while silently costing the operator the
    // one signal that says the shared endpoint refused us.
    const original = new RateLimitExhaustedError(
      'Horizon /accounts/GABC',
      new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY),
      'callRetriesExhausted',
    );
    assert.throws(
      () => rethrowAsEndpointFailure('Horizon /accounts/GABC', original),
      (error: unknown) => error === original && isRateLimitExhausted(error),
    );
  });

  it('does not double-wrap an already-classified failure', () => {
    // `throwIfEndpointStatus` fires INSIDE the caller's own try block, so its
    // error lands in the same catch that calls this.
    const already = new EndpointUnavailableError('Horizon /accounts/GABC', 'HTTP 503', 503);
    assert.throws(
      () => rethrowAsEndpointFailure('Horizon /accounts/GABC', already),
      (error: unknown) => error === already,
    );
  });
});

// ---------------------------------------------------------------------------
// The RPC side, where both kinds of failure arrive as exceptions
// ---------------------------------------------------------------------------

describe('readingOrRethrow separates a contract revert from a read that never landed', () => {
  it('returns the message of a SubjectAnswerError, for the caller to capture', () => {
    const answered = new SubjectAnswerError('Aquarius: simulation of get_privileged_addrs failed');
    assert.equal(readingOrRethrow('get_privileged_addrs() on CPOOL', answered), answered.message);
  });

  it('rethrows anything the contract did not say', () => {
    for (const error of [new Error('socket hang up'), new TypeError('fetch failed'), 'nope']) {
      assert.throws(
        () => readingOrRethrow('get_privileged_addrs() on CPOOL', error),
        isEndpointUnavailable,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Composed with the real retry wrapper
// ---------------------------------------------------------------------------

describe('composed with horizonFetch, against a real loopback Horizon', () => {
  it('a persistently rate-limited read reaches the caller as a rate limit, not a reading', async () => {
    const { url, hits } = await fakeHorizon(429);
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    const deps = { now: () => 0, sleep: async () => {} };

    const caught = await runWithRateLimitBudget(budget, async () => {
      try {
        await horizonFetch(`${url}/accounts/GABC`, deps);
        return null;
      } catch (error) {
        try {
          rethrowAsEndpointFailure(`Horizon /accounts/GABC`, error);
        } catch (rethrown) {
          return rethrown;
        }
      }
      return null;
    });

    assert.ok(isRateLimitExhausted(caught), 'still recognisable as a rate limit downstream');
    assert.equal(hits(), 4, '1 call + 3 retries, then it gives up rather than scoring a 0');
  });

  it('a 503 is a failed run and a 404 is a reading, from the same call site', async () => {
    const down = await fakeHorizon(503);
    const missing = await fakeHorizon(404);

    const downResp = await horizonFetch(`${down.url}/accounts/GABC`);
    assert.equal(downResp.ok, false);
    assert.throws(() => throwIfEndpointStatus('Horizon /accounts/GABC', downResp.status));

    const missingResp = await horizonFetch(`${missing.url}/accounts/GABC`);
    assert.equal(missingResp.ok, false);
    assert.doesNotThrow(() => throwIfEndpointStatus('Horizon /accounts/GABC', missingResp.status));
  });
});
