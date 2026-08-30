// Which read failures are a reading about the PROTOCOL, and which are a reading
// about STENION.
//
// Only one adapter needs this today, and the reason is structural rather than
// incidental. Blend and Kinetic throw on every failed read, so a failure of any
// kind becomes a failed run and nothing about our own read path can reach a
// published number. Aquarius is the first adapter that scores THROUGH a failure:
// `methodology/dex.md` requires a localized cannot-assess — one role, one issuer,
// one call that reverted — to resolve to the unsafe end (0) as a reading, because
// "we could not read who controls this pool" is a statement about the pool. That
// design is right, and it has a boundary the same document already draws:
//
//   > A whole-endpoint outage — Soroban RPC unreachable, Horizon down, nothing
//   > decodes — makes the adapter THROW [...] That is not a cannot-assess branch
//   > and must not be graded 0, or a blip in our own network path would publish
//   > "dangerous admin control" across every pool at once.
//
// This module is that boundary, made into code instead of prose. THE TEST IT
// APPLIES: did the subject answer? An answer about the subject is a reading and
// scores. Anything else — a rate limit we could not wait out, a connection that
// never landed, an endpoint reporting its own failure — is a fact about
// Stenion's infrastructure at the moment of the read, and a fact about our
// infrastructure has no place in a protocol's score.
//
// HOW "THE SUBJECT ANSWERED" IS RECOGNISED, per transport, because it is not the
// same question on both:
//
//   Horizon — every answer about the subject arrives as an HTTP STATUS. A 404 is
//     Horizon saying "that account is not here"; that is about the account. So a
//     4xx is a reading, and a THROW out of a Horizon call is never one: a
//     rejected `fetch` means no response landed, and a rejected `.json()` means
//     what landed was not Horizon's answer. A 5xx arrives as a status and is
//     still not a reading — it is Horizon reporting its own condition, and it
//     says exactly as much about an issuer's flags as a dropped connection does.
//
//   Soroban RPC — an answer about the subject arrives as a SIMULATION ERROR,
//     which is the contract itself refusing. That is minted here as
//     `SubjectAnswerError` at the point the simulation result is inspected, so
//     "the contract answered no" is carried by the error's own type rather than
//     inferred later from the shape of a message. Everything else thrown out of
//     an RPC call is transport.
//
// The narrow reading of a 429 — that a rate-limited read genuinely IS an
// unreadable read at that moment — is answered in `methodology/dex.md` under
// "A rate limit is not a reading". The short form: the budget that gives up is
// per ATTEMPT and shared by every call in it, so one exhaustion silences the
// rest of the attempt's reads too and both dex factors go to 0 together — the
// exact "across every pool at once" outcome the boundary above forbids, arriving
// one pool at a time.

import { isRateLimitExhausted } from '@stenion/core';

/**
 * A read that never produced an answer about its subject.
 *
 * Thrown out of an adapter, so the indexer records a failed run and the previous
 * score stands with its staleness advancing — which is the honest publication:
 * we did not learn anything about this protocol on this cycle.
 *
 * `name` is a string literal, never `constructor.name` — the workspace packages
 * are minified into the dashboard's serverless bundle, where a class name is
 * renamed. See `ProtocolMetadata.adapterRef` for the bug that rule comes from.
 */
export class EndpointUnavailableError extends Error {
  /** What was being read, named well enough to diagnose from the message alone. */
  readonly subject: string;
  /** The HTTP status behind it, or null when nothing ever answered. */
  readonly status: number | null;

  constructor(subject: string, detail: string, status: number | null = null) {
    super(
      `${subject} did not answer (${detail}). This is Stenion's read path failing, ` +
        'not a reading about the protocol.',
    );
    this.name = 'EndpointUnavailableError';
    this.subject = subject;
    this.status = status;
  }
}

/**
 * An error minted from the SUBJECT's own answer — a contract revert, a call that
 * returned nothing. The one class of throw an adapter may capture as a reading.
 *
 * `name` is a literal for the same reason as above; `isSubjectAnswer` checks it
 * rather than using `instanceof`, so the classification survives the bundle
 * boundary between `@stenion/adapters` and the dashboard's serverless build.
 */
export class SubjectAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubjectAnswerError';
  }
}

/** Did the contract itself answer, as opposed to the read never getting there? */
export function isSubjectAnswer(error: unknown): error is SubjectAnswerError {
  return error instanceof Error && error.name === 'SubjectAnswerError';
}

/** Is this the read-path failure this module mints? */
export function isEndpointUnavailable(error: unknown): error is EndpointUnavailableError {
  return error instanceof Error && error.name === 'EndpointUnavailableError';
}

/**
 * Is this HTTP status the endpoint reporting its own condition rather than
 * answering about the subject?
 *
 * `429` and `5xx`, and nothing else. A `429` cannot normally reach here —
 * `horizonFetch` intercepts it and either waits it out or throws
 * `RateLimitExhaustedError` — but it is classified anyway rather than left to
 * depend on that: the rule is about what a status MEANS, and it must not become
 * wrong the day a caller reads a response the retry wrapper never saw.
 *
 * Everything else non-ok is Horizon answering about the subject: a 404 is "that
 * account is not here", which is exactly the kind of localized cannot-assess
 * `methodology/dex.md` sends to the unsafe end.
 */
export function isEndpointStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Throw when a non-ok status is the endpoint's own condition; return quietly
 * when it is an answer about the subject, leaving the caller to capture it.
 *
 * Deliberately shaped as a guard the caller falls THROUGH rather than as a
 * boolean it must remember to branch on — the failure mode being prevented is a
 * call site that forgets, and a forgotten `if` publishes a 0.
 */
export function throwIfEndpointStatus(subject: string, status: number): void {
  if (isEndpointStatus(status)) {
    throw new EndpointUnavailableError(subject, `HTTP ${status}`, status);
  }
}

/**
 * Rethrow a throw that came out of a transport call, as the read-path failure it
 * is. Never returns.
 *
 * A `RateLimitExhaustedError` is rethrown UNTOUCHED and must stay that way: the
 * indexer flags a rate-limited failure by `isRateLimitExhausted` on the error it
 * catches (`cycle.ts`), so wrapping one would silently drop the `rateLimited`
 * flag off the cycle summary and cost the operator the one signal that says the
 * shared endpoint refused us. An already-classified `EndpointUnavailableError`
 * passes through for the same reason — a call site whose `throwIfEndpointStatus`
 * fires inside its own `try` must not be double-wrapped.
 */
export function rethrowAsEndpointFailure(subject: string, error: unknown): never {
  if (isRateLimitExhausted(error) || isEndpointUnavailable(error)) throw error;
  throw new EndpointUnavailableError(
    subject,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * The message of a throw the caller may capture as a reading — or a rethrow.
 *
 * For the RPC side, where a subject answer and a transport failure both arrive
 * as exceptions. Only a `SubjectAnswerError` comes back as text to record; a
 * rate limit, a dropped connection and an SDK decode failure all go up.
 */
export function readingOrRethrow(subject: string, error: unknown): string {
  if (isSubjectAnswer(error)) return error.message;
  rethrowAsEndpointFailure(subject, error);
}
