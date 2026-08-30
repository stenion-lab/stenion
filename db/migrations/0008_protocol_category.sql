-- Protocol category: which rulebook scores a protocol, and which rulebook a
-- stored score was produced under.
--
-- WHY THIS EXISTS. Stenion scored lending protocols and nothing in the schema
-- said so — "lending" was the unstated default everywhere. That was correct
-- while one category existed and stops being correct the moment a second one
-- does, silently: a DEX score would land in these same tables, be selected by
-- the same leaderboard query, and be ranked against a lending score by an
-- `ORDER BY safety_score DESC` that has no way to know the two numbers were
-- computed from different factors under different weights.
--
-- WHY IT IS ON **BOTH** TABLES, which looks like duplication and is not.
--
--   protocols.category    — current identity. What this protocol IS, today.
--                           Overwritten every cycle by upsertProtocol, exactly
--                           like name/chain/logo/contract_id.
--   risk_scores.category  — a stamp on one run, frozen with it forever.
--
-- The second is there for the reason 0007 gives for putting operational_state on
-- risk_scores rather than protocols. `methodology_version` is a per-category
-- counter now (METHODOLOGY_VERSIONS in core/src/types.ts), and two categories'
-- counters both start at 1 — so the integer alone no longer identifies a
-- rulebook. `(category, methodology_version)` does. Reading the category by
-- joining to `protocols` would answer with what the protocol is NOW: if an entry
-- were ever recategorized, every historical row would silently reinterpret under
-- a rulebook that never produced it, which is precisely the unrepairable
-- mis-attribution 0004 refused to allow. One denormalized text column is the
-- cheap half of that trade.
--
-- risk_scores.category is WRITTEN BUT NOT YET READ by any query, and that is
-- deliberate rather than an oversight. It has to be stamped from the first run
-- under this schema or the history it exists to disambiguate has a hole in it;
-- the read arrives with the first category that makes the version ambiguous.
--
-- NO BACKFILL IS A LIE HERE, unlike across a methodology bump. Every row in both
-- tables was produced by a lending adapter under lending's rulebook — that is
-- what the code did — so stamping them 'lending' records what actually happened
-- rather than assuming it. This is a backfill of fact, not of convenience, and
-- it is the one kind 0002's "history is never backfilled" rule does not forbid:
-- nothing is being recomputed and no score is being reinterpreted.

-- ---------------------------------------------------------------------------
-- protocols.category
-- ---------------------------------------------------------------------------
-- NOT NULL immediately, which is safe here and was not safe for 0002's column,
-- because of the DEFAULT. Postgres backfills existing rows with it in place, and
-- `main` may still be serving the previous indexer, whose upsertProtocol INSERT
-- does not name this column — without a default those writes would violate the
-- constraint and every production cycle would fail until main was promoted (the
-- live-writer hazard 0002/0003/0006/0007 all document).
--
-- The default is also CORRECT rather than merely convenient, on the same
-- reasoning 0002 used for `DEFAULT 1`: a writer that does not know about this
-- column is, by definition, one from before categories existed, which is to say
-- a lending-only writer.
--
-- FOLLOW-UP, and it is the one 0004 closed for methodology_version: once main
-- carries an indexer that passes `category` explicitly, DROP the default in a
-- later migration. Leaving it forever is the footgun 0004 describes — the first
-- DEX adapter that missed this column on some new write path would be silently
-- filed as lending instead of failing loudly, and a mis-filed row is
-- indistinguishable from a correct one. Do not close that follow-up in this
-- file: it must not run until the new indexer is actually deployed.
ALTER TABLE protocols
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'lending';

-- ---------------------------------------------------------------------------
-- risk_scores.category
-- ---------------------------------------------------------------------------
-- NULLABLE, unlike the column above, because it follows methodology_version's
-- discriminated union rather than protocols' identity columns: an `ok` row
-- carries the rulebook it was scored under, a `failed` row scored nothing and so
-- has no rulebook to attribute. Same DEFAULT reasoning as above for the live
-- writer.
ALTER TABLE risk_scores
  ADD COLUMN IF NOT EXISTS category text DEFAULT 'lending';

-- Every stored ok row was produced by BlendAdapter or KineticAdapter, both
-- lending. This UPDATE is a belt-and-braces no-op in the normal case — see the
-- next statement for why — and is kept so the intent is stated rather than
-- implied by a side effect.
UPDATE risk_scores
   SET category = 'lending'
 WHERE status = 'ok' AND category IS NULL;

-- CLEAR THE COLUMN ON FAILED ROWS, and do not remove this.
--
-- `ADD COLUMN ... DEFAULT` backfills EVERY existing row, not just the ones the
-- default is meant for. Without this statement every stored `failed` row would
-- come out of this migration stamped 'lending' — asserting that a run which
-- scored nothing was produced by lending's rulebook, which is false, and which
-- would then block the follow-up migration from tightening the CHECK to the full
-- union (the failed half would already be violated on arrival).
--
-- This is NOT the "silently rewrite stored history" that 0004 forbids, and the
-- distinction matters. 0004's warning is about a LATER migration papering over a
-- constraint failure by nulling rows that carry a real stamp. Here the value
-- being cleared was never a reading: it was written by this same migration
-- moments ago as an artifact of how ADD COLUMN applies a default. Nothing
-- observed is being erased.
--
-- In practice this touches zero rows today — `risk_scores` has never held a
-- failed run (ARCHITECTURE.md records the same fact for the alerting path). It
-- is here so the invariant is true because it is enforced, not because the table
-- happens to be lucky.
UPDATE risk_scores
   SET category = NULL
 WHERE status <> 'ok' AND category IS NOT NULL;

-- Only the `ok` half is enforced here, for the reason 0002 spells out and 0004
-- later resolved: the mirror clause (`status <> 'ok' AND category IS NULL`)
-- cannot be added while the DEFAULT exists, because the still-deployed previous
-- indexer inserts failed rows without naming this column and they would pick up
-- 'lending' and violate it — the exact production breakage the default prevents.
--
-- The new store writes an explicit NULL on the failed arm, so once main carries
-- it the failed side becomes true in practice, and the same follow-up migration
-- that drops the two defaults can tighten this to the full union.
ALTER TABLE risk_scores
  DROP CONSTRAINT IF EXISTS risk_scores_category_shape;

ALTER TABLE risk_scores
  ADD CONSTRAINT risk_scores_category_shape CHECK (
    status <> 'ok' OR category IS NOT NULL
  );
