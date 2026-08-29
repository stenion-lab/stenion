/**
 * The protocol-category registry: which rulebooks exist, and what version each
 * one is at.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `types.ts`. `types.ts` contains
 * `export enum RiskFactorType`, and Node's type-stripping loader rejects `enum`
 * outright (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) because it emits code rather
 * than being an erasable annotation. So nothing in `types.ts` can be
 * VALUE-imported by a `node --test` file — `core/src/scoring.test.ts` has to
 * regex the enum out of that file's source to assert anything about it, which is
 * a workaround, not a pattern to copy.
 *
 * The category list has to be assertable directly: a test that iterates the real
 * categories and checks each one has a version is the thing that stops a new
 * category being added in one place and forgotten in the other. So it lives here,
 * in a leaf with NO imports at all, which type stripping can load as-is. Same
 * reasoning `operational-state.ts` gives for using `as const` objects instead of
 * enums — "reach for this shape in anything a test will load."
 */

/**
 * The protocol categories Stenion publishes a rulebook for.
 *
 * TWO MEMBERS: `lending`, the rulebook every scored market runs under today, and
 * `dex`, admitted by the gate-checked submission in #100 as the first use of the
 * machinery #76–#79 built. `lending` was always the unstated default, and naming
 * it is what made a second category expressible rather than assumed.
 *
 * A CLOSED UNION, NOT AN OPEN STRING. Adding a category is never a data-only
 * change: it needs a taxonomy, a weight table, a `methodology/<category>.md`
 * file and adapter code, to TAXONOMY.md's bar. So the compile error from a
 * `Record<ProtocolCategory, …>` that has gained a key is the feature — it is how
 * every place a category must be registered gets found, rather than discovered
 * in production by a lookup that returned undefined. Adding `dex` here is what
 * surfaced `METHODOLOGY_VERSIONS`, `CATEGORY_FACTORS` and `CATEGORY_OPERATIONS`
 * as the three places it had to be declared, which is the design working.
 *
 * `dex` IS REGISTERED BUT NOT YET SCORABLE, and the type system says so rather
 * than a comment: its factor set is declared `status: 'pendingWeights'` in
 * `weights.ts`, which is a different type from a published one and carries no
 * `weight` on any factor. No adapter claims the category, nothing is registered
 * to a target list, and no `dex` row can reach `risk_scores`. See #102 for the
 * weight table that closes it.
 */
export const PROTOCOL_CATEGORIES = ['lending', 'dex'] as const;
export type ProtocolCategory = (typeof PROTOCOL_CATEGORIES)[number];

/**
 * Version of the scoring rulebook in METHODOLOGY.md that produced a score,
 * **per category**. Independent counters, each starting at 1.
 *
 * Bumped whenever a change makes scores non-comparable with earlier stored
 * rows — a new/changed formula, threshold, or weight. It is *not* an adapter
 * version and not an API version: every adapter in a category implements one
 * shared rulebook (METHODOLOGY.md ground rule 1), so a category's version is a
 * property of that rulebook, stamped onto each run by the indexer, and never
 * something an individual adapter chooses.
 *
 * WHY PER CATEGORY, AND WHY THE CATEGORY IS STORED BESIDE IT. Two categories'
 * counters both start at 1, so the number alone stops identifying a rulebook —
 * "v1" is ambiguous the moment a second category exists. `risk_scores.category`
 * is stamped alongside `risk_scores.methodology_version` for exactly that
 * reason: the pair is the identifier, not the integer. See migration 0008.
 *
 * Stored rows can't be recomputed — `risk_scores` keeps only outputs, never the
 * raw on-chain inputs — so history is not backfilled across a bump. The point of
 * this field is to make the discontinuity legible rather than silent.
 *
 * `lending: 1` — the five-factor rulebook, including `oracleSafety` scoring
 *     price age *and* manipulation resistance. This is the first version anyone
 *     can be downstream of: the development-era history that ran under earlier,
 *     unpublished iterations was discarded rather than migrated, and so is the
 *     history stamped 2 while a briefly-live v2 was in this constant before the
 *     rulebook was flattened back. See METHODOLOGY.md, "Current version".
 *
 * `dex: 1` — the two-factor AMM rulebook admitted in #100
 *     (`methodology/dex.md`). **Its own counter, with no relation to lending's.**
 *     Both read 1 today and that is a coincidence of both being new, not a
 *     statement that they are the same rulebook or that a `dex` v1 score is
 *     comparable to a `lending` v1 score — it is exactly the ambiguity
 *     `risk_scores.category` is stamped beside this number to remove. It starts
 *     at 1 rather than continuing lending's count for the same reason: a
 *     category's first published rulebook is its version 1, always.
 *
 *     It is a version for a rulebook nothing has yet been scored under. `dex`'s
 *     weight table is deliberately absent until #102, so no run can be stamped
 *     with this number yet; it is declared now because TAXONOMY.md Gate 7
 *     requires a category to arrive at 1 rather than acquire a version later.
 *
 * SPLITTING THE SCALAR INTO THIS MAP BUMPED NOTHING. No formula, threshold or
 * weight changed, so lending's stored history stays comparable straight across
 * the change — which is why `lending` is 1 here and not 2. The next change that
 * alters what a number means makes lending version 2, properly this time, as a
 * published boundary rather than a value that came and went. The machinery (the
 * stamp, the DB columns, the chart's break rendering) exists and is tested
 * precisely so that bump is legible on the day it happens, not built in a hurry
 * then.
 */
export const METHODOLOGY_VERSIONS = {
  lending: 1,
  dex: 1,
} as const satisfies Record<ProtocolCategory, number>;
