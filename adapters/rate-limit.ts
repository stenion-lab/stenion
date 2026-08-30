// Rate-limit retry at the transport boundary: the two Soroban RPC methods the
// adapters call, and the Horizon `fetch`.
//
// The accounting — how much waiting one attempt may do, and why the numbers are
// what they are — lives in `@stenion/core`'s rate-limit module. This file is
// only the part that needs to know what a 429 LOOKS LIKE coming back from each
// transport, which is different for each and was confirmed empirically rather
// than assumed:
//
//   Soroban RPC (@stellar/stellar-sdk 16.2, fetch adapter under the hood)
//     THROWS an AxiosError. Probed on 2026-08-30 against a local server
//     answering 429:
//       message           "Request failed with status code 429"
//       error.response.status  429
//       error.code        "ERR_BAD_REQUEST"   <- shared by every 4xx, useless here
//       error.response.headers  a WHATWG `Headers` — `.get('retry-after')` works,
//                               bracket access returns undefined
//     The same message string appears verbatim in the deployed cron summary for
//     the three targets that failed on 2026-08-30, so this is the live shape and
//     not a local artefact.
//
//   Horizon (global `fetch`, no SDK)
//     Does NOT throw. It resolves with a `Response` carrying `status: 429` and a
//     `Retry-After` header, which the adapters then turn into their own error or
//     into a captured reading. Retrying has to happen BEFORE that conversion,
//     which is why `horizonFetch` exists rather than a wrapper around the
//     adapters' own error handling.
//
// DETECTION IS ON THE STATUS CODE, never on the message text and never on the
// error's class. `error.response.status === 429` is data the server sent;
// `instanceof AxiosError` compares against whichever copy of axios this bundle
// got, and a class name is renamed by the minifier in the dashboard's
// serverless build (see ProtocolMetadata.adapterRef). The message is checked
// only as a fallback, for a transport that reports the code nowhere else.

import { rpc } from '@stellar/stellar-sdk';
import {
  DEFAULT_RATE_LIMIT_POLICY,
  RateLimitBudget,
  RateLimitExhaustedError,
  currentRateLimitBudget,
} from '@stenion/core';

/** The one status this module retries. Nothing else is a rate limit. */
export const RATE_LIMIT_STATUS = 429;

/**
 * The HTTP status behind a thrown transport error, or null when it carries none.
 *
 * Reads `response.status` (what the SDK's axios error exposes) and then a bare
 * `status`. Deliberately NOT a message-substring search as the primary test: a
 * decoded contract error that happened to contain "429" would otherwise be
 * retried as a rate limit, and a genuine break would be reported as endpoint
 * pressure.
 */
export function httpStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const err = error as { response?: { status?: unknown }; status?: unknown };
  const fromResponse = err.response?.status;
  if (typeof fromResponse === 'number') return fromResponse;
  if (typeof err.status === 'number') return err.status;
  return null;
}

/**
 * Is this error the endpoint refusing us for rate, as opposed to anything else?
 *
 * The message fallback is narrow on purpose — it matches axios's exact sentence
 * with the code in it, not a loose "429 appears somewhere". It exists because
 * that sentence is what reached the deployed run summary, and a future SDK that
 * stops populating `response` should not silently stop retrying.
 */
export function isRateLimited(error: unknown): boolean {
  if (httpStatusOf(error) === RATE_LIMIT_STATUS) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes(`Request failed with status code ${RATE_LIMIT_STATUS}`);
}

/**
 * The server's requested wait in ms, or null when it named none.
 *
 * `Retry-After` is seconds (the HTTP-date form is legal but neither Horizon nor
 * the Soroban RPC uses it, and a date we could not parse is better read as
 * "unspecified" than as an epoch). Handles both header shapes: a WHATWG
 * `Headers` (what the SDK's fetch-based axios adapter produces, where bracket
 * access silently returns undefined) and a plain object.
 */
export function retryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const headers = (error as { response?: { headers?: unknown } }).response?.headers;
  return retryAfterFromHeaders(headers);
}

/** The `Retry-After` in ms from any of the header shapes we can be handed. */
export function retryAfterFromHeaders(headers: unknown): number | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const getter = (headers as { get?: unknown }).get;
  const raw =
    typeof getter === 'function'
      ? (getter.call(headers, 'retry-after') as unknown)
      : (headers as Record<string, unknown>)['retry-after'];
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/** Injectable clock/sleep, so tests can prove the schedule without waiting on it. */
export interface RateLimitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one transport call, retrying it — and only it — while the endpoint is
 * rate-limiting us and the attempt can still afford to wait.
 *
 * `describe` names the call in the failure message, lazily: it is only rendered
 * on the path that gives up, so the happy path pays nothing for it.
 *
 * ANYTHING THAT IS NOT A 429 IS RETHROWN ON THE FIRST THROW. That is the whole
 * scoping rule and the reason this is not a general retry helper — the oracle
 * precondition's `isMissingContractFunction`, a decode failure and a simulation
 * error all have to reach the adapter unchanged and on the first try.
 */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  describe: () => string,
  budget: RateLimitBudget,
  deps: RateLimitDeps = {},
): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  for (let callRetries = 0; ; callRetries++) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimited(error)) throw error;

      const what = describe();
      const plan = budget.planRetry(callRetries, retryAfterMs(error), now());
      if (!plan.retry) {
        budget.recordRefusal(what);
        throw new RateLimitExhaustedError(what, budget, plan.stop);
      }

      budget.recordRetry(plan.delayMs, what);
      // Logged per retry, at warn: a target that succeeds after two retries
      // leaves a trail explaining why it was slow, and does so WITHOUT becoming
      // a failed run. The run summary carries the count; this carries the detail.
      console.warn(
        `[rate-limit] 429 on ${what} — retrying in ${plan.delayMs}ms ` +
          `(retry ${budget.retriesUsed}, ${budget.backoffUsedMs}ms of backoff used)`,
      );
      await sleep(plan.delayMs);
    }
  }
}

/**
 * The budget this call should draw on: the ambient one the indexer established,
 * or a fresh private one when there is none.
 *
 * The fallback is what makes a direct `fetchRawData()` — a script, a fixture
 * capture, a REPL — still retry rather than fail on the first 429. It gets the
 * policy caps and no attempt deadline, which is correct: nothing outside a cycle
 * is racing a timeout.
 */
function budgetForCall(): RateLimitBudget {
  return currentRateLimitBudget() ?? new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
}

/**
 * An `rpc.Server` whose two read methods retry a 429 in place.
 *
 * WRAPPED PER SERVER INSTANCE, and that is what scopes the fallback budget
 * correctly with no plumbing: every adapter builds exactly one `rpc.Server` at
 * the top of its `fetch*RawData`, so one server object is one attempt. Under the
 * indexer the ambient budget wins anyway; standalone, the per-server fallback
 * gives the same shape.
 *
 * Only `getLedgerEntries` and `simulateTransaction` are wrapped, because those
 * are the only two methods the adapters call. Wrapping the whole class would
 * claim coverage of methods nothing here uses.
 */
export function rateLimitedServer(
  rpcUrl: string,
  deps: RateLimitDeps = {},
  options?: rpc.Server.Options,
): rpc.Server {
  const server = new rpc.Server(rpcUrl, options);
  const fallback = new RateLimitBudget(DEFAULT_RATE_LIMIT_POLICY);
  const budget = (): RateLimitBudget => currentRateLimitBudget() ?? fallback;

  const getLedgerEntries = server.getLedgerEntries.bind(server);
  const simulateTransaction = server.simulateTransaction.bind(server);

  server.getLedgerEntries = (...keys) =>
    withRateLimitRetry(
      () => getLedgerEntries(...keys),
      () => `getLedgerEntries (${keys.length} key${keys.length === 1 ? '' : 's'})`,
      budget(),
      deps,
    );
  server.simulateTransaction = ((tx: Parameters<typeof simulateTransaction>[0]) =>
    withRateLimitRetry(
      () => simulateTransaction(tx),
      () => 'simulateTransaction',
      budget(),
      deps,
    )) as typeof server.simulateTransaction;

  return server;
}

/**
 * `fetch` for Horizon, retrying a 429 response in place.
 *
 * A 429 from Horizon is a resolved `Response`, not a throw, so this inspects the
 * status and converts it into the retry loop's currency — and hands the
 * *response* back untouched for every other status, including the 4xx/5xx the
 * adapters already have their own handling for. Only the rate-limited case is
 * intercepted; a 404 on an admin account still reaches the caller as a 404.
 */
export async function horizonFetch(url: string, deps: RateLimitDeps = {}): Promise<Response> {
  return withRateLimitRetry(
    async () => {
      const response = await fetch(url);
      if (response.status === RATE_LIMIT_STATUS) {
        // Rethrown in the shape `isRateLimited` recognises, carrying the
        // server's own Retry-After so the schedule can honour it.
        throw new HorizonRateLimitResponse(url, response);
      }
      return response;
    },
    () => `Horizon ${redactPath(url)}`,
    budgetForCall(),
    deps,
  );
}

/**
 * A Horizon 429, in the shape the retry loop reads.
 *
 * Carries a `response` with `status` and `headers` so `httpStatusOf` and
 * `retryAfterMs` need no Horizon-specific branch — one detection path covers
 * both transports.
 */
class HorizonRateLimitResponse extends Error {
  readonly response: { status: number; headers: Headers };

  constructor(url: string, response: Response) {
    super(`Request failed with status code ${RATE_LIMIT_STATUS}`);
    this.name = 'HorizonRateLimitResponse';
    this.response = { status: response.status, headers: response.headers };
    void url;
  }
}

/** The path part of a Horizon URL — enough to name the call, without the host. */
function redactPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
