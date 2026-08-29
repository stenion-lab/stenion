# Stenion Scoring Methodology

This document is the **source of truth for how every safety factor is calculated.**
It exists so that anyone — including the protocols being scored — can see, verify, and
challenge the actual rules, not just the output numbers. Every formula below is extracted
directly from the shipped code (currently [`adapters/blend/`](../adapters/blend) and
[`adapters/kinetic/`](../adapters/kinetic)); this file is not a summary of intent, it is
the rulebook the adapters must implement.

**One formula per category, per-protocol data sources.** Every factor's formula, scale, and
thresholds are fixed here and identical across every protocol in a category — and across
_markets_: the three Blend pools Stenion scores run one adapter and one rulebook, differing only
in the pool each reads. Each category owns a section below, holding its own factor list, weight
table, worked example and version changelog. There are two — **lending**, which every scored market
runs under, and **dex**, published but not yet scoring anything. What legitimately
differs per adapter is only _where the raw inputs are read on-chain_ — e.g. Blend reads a per-reserve `max_util` cap,
while Kinetic (K2), being Aave-V3-style, has no such cap and instead anchors the same
utilization formula to its own `OPTIMAL_UTILIZATION_RATE` (see §5). The _anchoring pattern_
("grade against the protocol's own on-chain parameter") is the invariant; the specific
parameter that pattern resolves to is a documented per-protocol fact, not a new threshold.

If the code and this document ever disagree, that is a bug — open an issue (see
[Disputing or changing a threshold](publishing-rules.md#disputing-or-changing-a-threshold)).

---

## Current version

Versions are **per category**, on independent counters that each start at 1, so a version number
alone does not identify a rulebook — the category and the number together do. One row per
category, and the changelog behind each lives in that category's own section:

| Category  | Current version | Scored today | Rulebook and changelog        |
| --------- | --------------- | ------------ | ----------------------------- |
| `lending` | 1               | yes          | [Lending](lending.md#lending) |
| `dex`     | 1               | **no**       | [Dex](dex.md#dex)             |

**The two `1`s are not the same 1.** Counters are independent and each starts at 1, so `dex` v1 and
`lending` v1 are two different rulebooks rather than two editions of one, and neither is older than
the other. The category and the number together identify a rulebook; the number alone does not.

**Dex, methodology v1 — published, not yet in use.** The two-factor AMM rulebook in
[Dex](dex.md#dex) — `adminKeySafety` and `assetControlSafety`. **Nothing is scored under it and no
run has been stamped with it:** its weight table is deliberately deferred to a separate review,
recorded in that section rather than filled in with plausible numbers. A third factor,
`depthSafety`, was proposed and **deferred**: Aquarius publishes no unit of value to denominate a
trade size in, and every way of inventing one is either a fabricated anchor or a permanent choice
made on one protocol's data. It is published now because
[`../TAXONOMY.md`](../TAXONOMY.md) requires a category's rulebook to be reviewable _before_ an
adapter is written against it.

**Lending, methodology v1** — the rulebook described in the [Lending](lending.md#lending) section, in full,
including `oracleSafety` scoring both price freshness and manipulation resistance (§2), the
minimum-size filter §4 and §5 select reserves through
([The minimum-size filter](lending.md#the-minimum-size-filter)), and the
[market-size floor](lending.md#the-market-size-floor) that decides whether a market is scorable at all.
The floor is a precondition rather than a formula — it moves no number and did not bump this
version.

The rest of this section — what bumps a version, and what a boundary means for a stored score —
is policy that applies to **every** category, not just lending.

**Versioning begins here.** `methodology_version = 1` is the only version lending's rulebook
defines, and the only one any stored row will carry. A version 2 was briefly live in the code
— stamped onto runs between 2026-08-14 11:25 and 2026-08-18 11:30 UTC, before the rulebook was
flattened back to v1 — and that history is discarded rather than migrated, for the same reason
the development-era history was: it was computed under a rulebook that no longer exists, and
nobody was downstream of it. After that discard there is no v1-versus-v2 boundary in
`risk_scores`, and none to look for.

### Earlier development history was discarded, not migrated

Before this point Stenion accumulated a few weeks of scored runs during development, under
earlier iterations of these rules. **That history was deleted rather than carried forward, and
this is a deliberate, recorded choice rather than a silent one.** Three reasons, stated plainly:

- **It contained scores computed under two known bugs**, since fixed. Those numbers were wrong
  under their own rulebook, not merely scored under a different one.
- **It predates the oracle robustness work** (§2), so its `oracleSafety` values measured price
  age alone — a signal we now consider misleading rather than merely incomplete.
- **Nobody was downstream of it.** Every row came from our own cron during development; no
  external consumer had been built against the API, and the only reader of the history was our
  own score chart. Marking a discontinuity in a dataset nobody had read would have been
  bookkeeping, not disclosure.

A clean history starting from a rulebook we actually stand behind is more honest than a
marked-up one carrying forward numbers we know were wrong. **This is the last time that
reasoning applies.** From here on, history is never deleted and never backfilled — the version
stamp exists so a change is labeled instead.

### What bumps the version, going forward

**Bump when a change alters what a number means** — a factor starting or stopping measuring
something, a threshold's anchor changing, a re-weighting, or any formula change that moves
scores for unchanged on-chain state. **Don't bump** for a fix that makes the implementation
match the rule already documented here (the stored scores were wrong, not scored under a
different rulebook — say so in the changelog instead), for adding a protocol or an adapter, or
for wording, disclosure, and presentation changes. The test is simple: if comparing an old score
to a new one would mislead, bump; if the old score was just incorrect under this same rulebook,
don't.

### Scores across a boundary are not comparable

No boundary survives in the stored data — the v2 rows above were discarded — but the machinery
that marks one is live and tested, because the first real bump must be legible on the day it
happens rather than built in a hurry then:

- The indexer stamps `risk_scores.methodology_version` from this category's entry in
  `METHODOLOGY_VERSIONS` ([`core/src/category.ts`](../core/src/category.ts)) at write time, resolved
  from the target's own category. An adapter has no say in the version; it only declares which
  category it belongs to. `risk_scores.category` is stamped beside it, because every category's
  counter starts at 1 and the pair — not the integer — identifies a rulebook.
- The score-history chart on each protocol page **breaks the line** at a version change rather
  than drawing through it, and the run list labels the break. Both paths are covered by fixture
  tests, since live data cannot exercise them.
- The version is returned on every history point and on the protocol detail from
  `GET /api/v1/protocol/:id`. To check which rulebook produced a stored score, read that column
  — don't infer it from the date.

History is **not backfilled across a bump, and cannot be** — `risk_scores` stores only outputs
(the score and the factor map), never the raw on-chain inputs a run was computed from, so no
one, including us, can recompute an old row under new rules.

---

## Ground rules (non-negotiable)

1. **The same formula applies to every protocol in a category, with no exceptions.** A
   factor's formula, its weight, and its thresholds are fixed in that category's section
   below, in one shared place. They do not vary per protocol, per adapter, or per anything
   else _within_ the category. **A category boundary is the one and only place a rule may
   differ** — and it differs because the factor sets differ, not because a protocol asked:
   `utilizationSafety` weighted 0.20 says nothing about an AMM with no borrow cap. That is a
   different rulebook, published in full under its own heading and versioned on its own
   counter, never lending's rules bent to fit. Two protocols in the same category are always
   graded by the same rules.
2. **Payment never changes a threshold or a formula.** Protocols can pay for visibility,
   speed, or private tooling — never for a better number. A paid tier cannot move a
   threshold, reweight a factor, or alter a curve. The _only_ thing that changes a
   protocol's output is its own real, on-chain data.
3. **Different protocols can and should score differently.** That is the point. What must
   never differ is the _rule_ being applied. Blend scoring 54 and a hypothetical protocol
   scoring 80 is a result of their data, not of two different rulebooks.
4. **No fabricated numbers.** Where real data genuinely isn't available for a factor, the
   score uses a clearly-flagged neutral baseline (called out explicitly below) — never an
   invented, plausible-looking value.
5. **AI never sets a score.** Any AI feature only explains or summarizes the numbers these
   formulas produce. It never generates an independent risk assessment.

---

## Score model

- **Overall score: 0–100, higher = safer.** API/field name `safetyScore`.
- **Every factor is on the same scale: 0–100, higher = safer.** Factor names end in
  `*Safety` so a name never disagrees with its number — a `collateralSafety` of 70 means
  well-diversified (safe), not "70% concentrated."
- The overall score is a **weighted mean of the category's factors**, renormalized over
  whichever factors are non-null (so a genuinely inapplicable factor doesn't drag the score
  toward zero rather than being excluded):

  ```
  safetyScore = round( Σ(factor.value × factor.weight) / Σ(factor.weight) )
  ```

**This arithmetic is shared; the factors it averages are not.** The formula above is
category-agnostic — it reads a value and a weight and nothing else — and it is implemented once,
in `scoreFactors` ([`core/src/scoring.ts`](../core/src/scoring.ts)), which every adapter of every
category calls. **Which** factors exist and **what each is weighted** is per category: declared
once in `CATEGORY_FACTORS` ([`core/src/weights.ts`](../core/src/weights.ts)) and published in that
category's own section below. So the weight table and the factor list live under
[Lending](lending.md#lending), not here — a second category would bring its own, not edit lending's.

A factor may publish a **`components`** breakdown — the sub-signals behind its value.
Components with a numeric `value` are what the factor was computed from; components with
a `null` value are **disclosures**: real, readable on-chain quantities we publish but
deliberately do not grade, because scoring them would invent comparability the data does
not support (see §2c and §2d). A null component is never missing data.

One published field sits **outside** this formula entirely: `operationalState`, which reports
which user operations a market's own contracts are currently refusing. It is not a factor, not a
multiplier, and not an input to `safetyScore` — see
[Operational state is published, never scored](publishing-rules.md#operational-state-is-published-never-scored) for
why, and for why that is a decision rather than an omission.

---
