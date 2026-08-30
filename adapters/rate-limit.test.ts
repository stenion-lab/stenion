// Tests for ./rate-limit.ts — what a 429 looks like coming back from each
// transport, and that only a 429 is ever retried.
//
// THE SCOPING TEST IS THE IMPORTANT ONE. A retry wrapper that quietly swallows
// and re-runs unrelated failures is worse than no wrapper: it turns "this pool's
// oracle changed shape" into three slow identical failures, spends the attempt
// budget learning nothing, and blurs the one signal an alert exists for. So
// "a non-429 is rethrown on the first throw, having been called exactly once"
// is asserted for both transports, not just described.
//
// The error shapes here are the ones confirmed live on 2026-08-30 — an
// AxiosError carrying `response.status: 429` from the SDK, and a resolved
// `Response` with `status: 429` from Horizon's plain `fetch`. The Horizon side
// is tested against a real loopback HTTP server rather than a stubbed `fetch`,
// because the thing being tested is precisely that a 429 arrives as a RESOLVED
// response and not as a throw — a stub would let that assumption be written into
// the test instead of checked by it.
//
// Nothing sleeps: `sleep` and `now` are injected.
//
// Run with: pnpm --filter @stenion/adapters test

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_RATE_LIMIT_POLICY,
  RateLimitBudget,
  isRateLimitExhausted,
  runWithRateLimitBudget,
} from '@stenion/core';

import { contractInstanceKey } from './ledger-entries.ts';
import {
  horizonFetch,
  httpStatusOf,
  isRateLimited,
  rateLimitedServer,
  retryAfterFromHeaders,
  retryAfterMs,
  withRateLimitRetry,
} from './rate-limit.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The error the Stellar SDK throws on a 429, in the shape it actually has.
 *
 * Captured on 2026-08-30 by pointing `rpc.Server` at a loopback server
 * answering 429: an AxiosError whose `message` is the sentence below, whose
 * `response.status` is 429, and whose `response.headers` is a WHATWG `Headers`
 * (so `.get()` works and bracket access does not). `code` is `ERR_BAD_REQUEST`,
 * which axios uses for every 4xx and is therefore useless for telling a rate
 * limit from a bad request.
 */
function sdkRateLimitError(retryAfterSeconds?: number): Error {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) headers.set('retry-after', String(retryAfterSeconds));
  const error = new Error('Request failed with status code 429') as Error & {
    response: { status: number; headers: Headers };
    code: string;
    isAxiosError: boolean;
  };
  error.name = 'AxiosError';
  error.code = 'ERR_BAD_REQUEST';
  error.isAxiosError = true;
  error.response = { status: 429, headers };
  return error;
}

/** Injected clock/sleep: instant, and recording what it was asked to wait. */
function fakeDeps() {
  const slept: number[] = [];
  let clock = 0;
  return {
    slept,
    advance: (ms: number) => void (clock += ms),
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
    },
  };
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** A loopback Horizon that answers each request from `plan`, in order. */
async function fakeHorizon(plan: { status: number; retryAfter?: number; body?: string }[]) {
  let i = 0;
  const hits: number[] = [];
  const server = createServer((_req, res) => {
    const step = plan[Math.min(i, plan.length - 1)];
    i += 1;
    hits.push(step.status);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (step.retryAfter !== undefined) headers['Retry-After'] = String(step.retryAfter);
    res.writeHead(step.status, headers);
    res.end(step.body ?? '{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, hits };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('a 429 is told apart from every other failure', () => {
  it('recognises the SDK error by its status, not by its text', () => {
    assert.equal(httpStatusOf(sdkRateLimitError()), 429);
    assert.equal(isRateLimited(sdkRateLimitError()), true);
  });

  it('recognises a bare status-carrying error', () => {
    assert.equal(isRateLimited({ status: 429 }), true);
    assert.equal(isRateLimited({ response: { status: 429 } }), true);
  });

  it('does not mistake other 4xx/5xx responses for rate limiting', () => {
    for (const status of [400, 401, 403, 404, 422, 500, 502, 503]) {
      assert.equal(
        isRateLimited({ response: { status } }),
        false,
        `${status} must not be retried as a rate limit`,
      );
    }
  });

  it('does not mistake the failures the adapters already handle', () => {
    // Every one of these has its own meaning and its own handling. Retrying any
    // of them would spend the attempt budget re-learning a settled answer — the
    // oracle-legibility verdict most of all, which is a permanent property of a
    // deployed contract.
    const notRateLimits = [
      new Error(
        'HostError: Error(WasmVm, MissingValue) … "trying to invoke non-existent contract function", max_age',
      ),
      new Error('Blend: pool CAJJ… has no Config in instance storage'),
      new Error('Aquarius: pool CA6P… returned an empty token list'),
      new Error('attempt exceeded its 10000ms time budget'),
      new Error('could not query captive core: http request failed with non-200 status code (404)'),
      new Error('socket hang up'),
      null,
      undefined,
      'a string',
    ];
    for (const error of notRateLimits) {
      assert.equal(isRateLimited(error), false, `wrongly treated as a rate limit: ${error}`);
    }
  });

  it('reads Retry-After from both header shapes, and rejects nonsense', () => {
    // The SDK's fetch-based axios adapter hands back a WHATWG `Headers`; a plain
    // object is what a different transport would give. Both are accepted because
    // getting this wrong silently means ignoring the server's own instruction.
    const headers = new Headers();
    headers.set('retry-after', '3');
    assert.equal(retryAfterFromHeaders(headers), 3_000);
    assert.equal(retryAfterFromHeaders({ 'retry-after': '2' }), 2_000);
    assert.equal(retryAfterMs(sdkRateLimitError(5)), 5_000);

    // An HTTP-date Retry-After is legal but neither endpoint uses it; reading it
    // as "unspecified" is better than reading it as an epoch.
    assert.equal(retryAfterFromHeaders({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), null);
    assert.equal(retryAfterFromHeaders({ 'retry-after': '-1' }), null);
    assert.equal(retryAfterFromHeaders(null), null);
    assert.equal(retryAfterMs(sdkRateLimitError()), null);
  });
});

// ---------------------------------------------------------------------------
// Retrying, and not retrying
// ---------------------------------------------------------------------------

describe('withRateLimitRetry retries a 429 and nothing else', () => {
  it('recovers when a retried call succeeds inside the cap', async () => {
    const { deps, slept } = fakeDeps();
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    let calls = 0;

    const value = await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw sdkRateLimitError();
        return 'the answer';
      },
      () => 'simulateTransaction',
      budget,
      deps,
    );

    assert.equal(value, 'the answer');
    assert.equal(calls, 3, 'two refusals then a success');
    assert.deepEqual(slept, [250, 500], 'the per-call schedule escalates');
    // The count that separates a retry-success from a clean success upstream.
    assert.equal(budget.retriesUsed, 2);
    assert.equal(budget.backoffUsedMs, 750);
    assert.equal(budget.wasRateLimited, true);
  });

  it('never retries a failure that is not a rate limit', async () => {
    const { deps, slept } = fakeDeps();
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    let calls = 0;

    await assert.rejects(
      () =>
        withRateLimitRetry(
          async () => {
            calls += 1;
            throw new Error('Blend: simulation of max_age on CORACLE… failed: unreachable');
          },
          () => 'simulateTransaction',
          budget,
          deps,
        ),
      /simulation of max_age/,
      'the original error must reach the adapter unchanged',
    );

    assert.equal(calls, 1, 'called exactly once — no retry, no swallowing');
    assert.deepEqual(slept, []);
    assert.equal(budget.retriesUsed, 0);
    assert.equal(budget.wasRateLimited, false);
  });

  it('gives up on a persistent 429 with an error that names it', async () => {
    const { deps, slept } = fakeDeps();
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    let calls = 0;

    const error = await withRateLimitRetry(
      async () => {
        calls += 1;
        throw sdkRateLimitError();
      },
      () => 'getLedgerEntries (9 keys)',
      budget,
      deps,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(isRateLimitExhausted(error), 'must be the rate-limit failure, not a generic one');
    const message = (error as Error).message;
    assert.match(message, /rate limited \(HTTP 429\)/);
    assert.match(message, /getLedgerEntries \(9 keys\)/);
    assert.match(message, /not the protocol being unreadable/);

    // Bounded, and bounded by the per-call cap — 4 calls is 1 + 3 retries.
    assert.equal(calls, 4);
    assert.deepEqual(slept, [250, 500, 1000]);
    assert.ok(
      slept.reduce((a, b) => a + b, 0) <= DEFAULT_RATE_LIMIT_POLICY.backoffBudgetMs,
      'the whole giving-up path stays inside the backoff budget',
    );
  });

  it('stops before the attempt deadline rather than running into the timeout', async () => {
    // The point of point 4: a persistently-429ing endpoint has to fail AS a
    // rate limit, inside the attempt window — never as a generic timeout after
    // it. The budget is given a deadline 400ms out, which is less than one
    // backoff plus a call worth making.
    const { deps } = fakeDeps();
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY, 400);

    const error = await withRateLimitRetry(
      async () => {
        throw sdkRateLimitError();
      },
      () => 'getLedgerEntries (1 key)',
      budget,
      deps,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(isRateLimitExhausted(error));
    assert.match((error as Error).message, /too little of the attempt timeout was left/);
    assert.equal(budget.retriesUsed, 0, 'it did not spend a retry it could not finish');
  });

  it('waits as long as the server asked when the server asked for longer', async () => {
    const { deps, slept } = fakeDeps();
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
    let calls = 0;

    await withRateLimitRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw sdkRateLimitError(1);
        return 'ok';
      },
      () => 'call',
      budget,
      deps,
    );

    assert.deepEqual(slept, [1_000], 'Retry-After: 1 beats our 250ms first step');
  });
});

// ---------------------------------------------------------------------------
// Horizon
// ---------------------------------------------------------------------------

describe('horizonFetch treats a 429 response as a rate limit', () => {
  it('retries a 429 response and returns the eventual success', async () => {
    // Horizon does NOT throw on 429 — it resolves with the response — so this
    // path only works if the status is inspected rather than the promise's
    // rejection awaited.
    const { deps, slept } = fakeDeps();
    const { url, hits } = await fakeHorizon([
      { status: 429, retryAfter: 1 },
      { status: 200, body: '{"ok":true}' },
    ]);
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);

    const response = await runWithRateLimitBudget(budget, () =>
      horizonFetch(`${url}/accounts/GABC`, deps),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(hits, [429, 200]);
    assert.deepEqual(slept, [1_000], "Horizon's own Retry-After is honoured");
    assert.equal(budget.retriesUsed, 1);
  });

  it('hands back every other status untouched, including the ones adapters handle', async () => {
    // A 404 on an admin account is a real reading the adapters already turn into
    // their own error or captured verdict. Intercepting it here would move a
    // decision out of the adapter that owns it.
    const { deps } = fakeDeps();
    const { url, hits } = await fakeHorizon([{ status: 404 }]);

    const response = await horizonFetch(`${url}/accounts/GNOPE`, deps);
    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
    assert.deepEqual(hits, [404], 'called once — a 404 is not retried');
  });

  it('exhausts on a persistently rate-limited Horizon and says so', async () => {
    const { deps } = fakeDeps();
    const { url, hits } = await fakeHorizon([{ status: 429 }]);
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);

    const error = await runWithRateLimitBudget(budget, () =>
      horizonFetch(`${url}/accounts/GABC/operations?order=desc&limit=200`, deps),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(isRateLimitExhausted(error));
    // Named by path, so an alert says which Horizon read was refused without
    // pasting a host into the message.
    assert.match((error as Error).message, /Horizon \/accounts\/GABC\/operations/);
    assert.equal(hits.length, 4, '1 call + 3 retries');
  });
});

// ---------------------------------------------------------------------------
// Budget sharing
// ---------------------------------------------------------------------------

describe('one budget covers the whole attempt, not each call', () => {
  it('spends a shared allowance across several rate-limited calls', async () => {
    // 27 requests in a Kinetic attempt; if each could retry independently the
    // backoff would walk straight through the attempt timeout. The fourth call
    // finds the attempt's allowance already spent.
    const { deps } = fakeDeps();
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);

    const oneRefusalThenOk = (label: string) =>
      runWithRateLimitBudget(budget, async () => {
        let calls = 0;
        return withRateLimitRetry(
          async () => {
            calls += 1;
            if (calls === 1) throw sdkRateLimitError();
            return label;
          },
          () => label,
          budget,
          deps,
        );
      });

    assert.equal(await oneRefusalThenOk('call-1'), 'call-1');
    assert.equal(await oneRefusalThenOk('call-2'), 'call-2');
    assert.equal(await oneRefusalThenOk('call-3'), 'call-3');
    assert.equal(await oneRefusalThenOk('call-4'), 'call-4');
    assert.equal(budget.retriesUsed, 4, 'the attempt cap is now reached');

    // A fifth rate-limited call gets no retry at all — the attempt is out.
    const error = await oneRefusalThenOk('call-5').then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(isRateLimitExhausted(error));
    assert.match((error as Error).message, /the attempt hit its retry cap/);
  });
});

// ---------------------------------------------------------------------------
// The wrapped rpc.Server
// ---------------------------------------------------------------------------

// `rateLimitedServer` is the piece that actually puts the retry in the adapters'
// path, and it works by replacing two methods on an SDK instance. A mistake
// there — a lost `this`, a signature the SDK does not accept, a wrapper the SDK
// bypasses internally — would be invisible in every other test here, because
// every other test calls the wrapper directly. So this one drives a real
// `rpc.Server` against a loopback endpoint and checks the SDK's own request
// path goes through the retry.
describe('rateLimitedServer puts the retry in the SDK path', () => {
  /** A loopback Soroban RPC answering each POST from `plan`, in order. */
  async function fakeRpc(plan: { status: number; retryAfter?: number }[]) {
    let i = 0;
    const hits: number[] = [];
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const step = plan[Math.min(i, plan.length - 1)];
        i += 1;
        hits.push(step.status);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (step.retryAfter !== undefined) headers['Retry-After'] = String(step.retryAfter);
        res.writeHead(step.status, headers);
        res.end(
          step.status === 200
            ? JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                result: { entries: [], latestLedger: 64_191_571 },
              })
            : '{}',
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return { url: `http://127.0.0.1:${port}`, hits };
  }

  const someKey = contractInstanceKey('CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD');

  it('retries a 429 the SDK threw, and returns the eventual response', async () => {
    const { deps, slept } = fakeDeps();
    const { url, hits } = await fakeRpc([{ status: 429 }, { status: 429 }, { status: 200 }]);
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);

    const server = rateLimitedServer(url, deps, { allowHttp: true });
    const response = await runWithRateLimitBudget(budget, () => server.getLedgerEntries(someKey));

    assert.deepEqual(response.entries, []);
    assert.equal(response.latestLedger, 64_191_571);
    assert.deepEqual(hits, [429, 429, 200]);
    assert.deepEqual(slept, [250, 500]);
    assert.equal(budget.retriesUsed, 2);
  });

  it('surfaces a persistent 429 as the rate-limit failure, naming the call', async () => {
    const { deps } = fakeDeps();
    const { url, hits } = await fakeRpc([{ status: 429 }]);
    const budget = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);

    const server = rateLimitedServer(url, deps, { allowHttp: true });
    const error = await runWithRateLimitBudget(budget, () => server.getLedgerEntries(someKey)).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(isRateLimitExhausted(error), 'must not reach the adapter as a bare AxiosError');
    assert.match((error as Error).message, /getLedgerEntries \(1 key\)/);
    assert.equal(hits.length, 4, '1 call + 3 retries');
  });

  it('lets a non-429 failure through on the first try', async () => {
    // A 500 from the RPC is a real failure the indexer should record as one, and
    // retrying it would spend the attempt budget to learn the same thing again.
    const { deps } = fakeDeps();
    const { url, hits } = await fakeRpc([{ status: 500 }]);

    const server = rateLimitedServer(url, deps, { allowHttp: true });
    await assert.rejects(() => server.getLedgerEntries(someKey));
    assert.equal(hits.length, 1, 'called once — no retry');
  });
});
