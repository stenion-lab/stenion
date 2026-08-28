# What a new scoring category must clear before it exists

Stenion scores one category today: **lending**. This document is the bar a second one has to clear
before any adapter is written for it — gates **0 through 8**, each stated as a condition a reviewer
can answer **yes** or **no** against a submission. A "no" on any one of them blocks the category.
They carry equal weight; there is no gate here that a strong showing elsewhere buys off.

**This document designs no category.** It does not name a factor, a threshold, a weight, or an
operation for any category that does not exist yet — doing so would pre-empt the design work these
gates exist to discipline, and would smuggle in exactly the unanchored numbers Gate 1 is about.
Every gate below is illustrated from **lending's own rulebook**, because lending is the only rulebook
that has actually cleared this bar, and a gate shown against real published rules is checkable in a
way an abstract one is not.

**Where each thing lives.** The rules themselves are published in
[`methodology/index.md`](methodology/index.md), one `##` section per category; the code that implements them is
in [`core/`](core) and the adapters; how to write the adapter is in
[`CONTRIBUTING.md`](CONTRIBUTING.md); what is planned is in [`ROADMAP.md`](ROADMAP.md). This document
owns only the admission standard.

**When to use it.** Before the design work, as the specification for what the submission must
contain. Again at review, as the [checklist](#pre-flight-checklist) at the end. A category arrives as
**a rulebook plus an adapter**, in that order — the rulebook is what is being reviewed here, and it
is reviewable before a line of adapter code exists.

---

## Gate 0 — The category exists because its protocols fail differently

**Condition.** The submission names, in one sentence, **the question this category's factors answer
that no existing category's factors already answer** — and, for each proposed factor, the failure it
detects that lending's five cannot.

**Fails if:** any proposed factor is an existing factor rephrased, rescaled, or renamed for a new
audience. A category is a distinct set of failure modes, not a distinct set of nouns. "Described
differently" is not "fails differently."

**Lending as the worked example.** Lending's five factors answer one question: _can this market keep
paying depositors out, and is the collateral behind its loans worth what the pool thinks it is?_
Every factor is a different way for that to go wrong — concentration (§1), a price you cannot trust
(§2), who can change the rules (§3), a cushion that has been drawn down (§4), and headroom below the
protocol's own stress line (§5). Two of those presuppose a borrow/supply ledger outright:
`liquiditySafety` is `(supplied − borrowed) / supplied`, and `utilizationSafety` grades distance from
a cap the protocol itself declared. A category whose protocols have neither cannot be graded on
either, and `methodology/`'s ground rule 1 says so directly: a category boundary "differs because
the factor sets differ, not because a protocol asked."

**The test has already been applied twice, in both directions:**

- **Outward** — `out-of-category` in [`dashboard/app/lib/coverage.ts`](dashboard/app/lib/coverage.ts)
  exists precisely to say "the rules this protocol's number would be computed under have not been
  written," rather than stretching lending's five over it.
- **Inward** — oracle _manipulation_ resistance was folded into the existing `oracleSafety` rather
  than given a sixth factor ([`methodology/lending.md`](methodology/lending.md#factor-weights), "Factor weights"),
  because it answers the same question §2 already asks. That is Gate 0 applied to a factor instead of
  a category, and it is the reason the taxonomy in [`core/src/types.ts`](core/src/types.ts) is still
  five.

**Note on cost.** Adding factor keys is a breaking change to the shared taxonomy in
`core/src/types.ts` and is held to a higher bar again (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).
Gate 0 is what justifies paying that cost.

---

## Gate 1 — Every threshold either anchors to an on-chain parameter or is labelled

**Condition.** The submission lists **every** threshold in its rulebook, and each one is either:

- **(a) Anchored** — it cites the protocol's own on-chain parameter, **naming the specific contract
  field read**, not merely "the protocol's configuration"; or
- **(b) Labelled** — it is marked **"unvalidated judgment call"** in **both** the code and
  `methodology/`, with the reasoning stated and **the direction of error** stated.

**Fails if:** a number appears in a formula with no anchor and no label. A reviewer should be able to
point at any constant in the submission and get one of those two answers immediately.

**Lending as the worked example.** The anchoring pattern is the invariant — "grade against the
protocol's own on-chain parameter" — while the specific field that pattern resolves to is a
documented per-protocol fact, not a new threshold. Type (a) constants name their field: Blend's
`PoolConfig.min_collateral` read per pool from instance storage, its per-reserve `max_util`,
`oracles()[i].resolution` and `max_age()` on the pool's oracle aggregator, per-asset `max_dev`; K2's
`PriceCacheTtl`, its per-asset `max_age` and global `price_staleness_threshold` (the **tighter** of
the two, which is still K2's number and not ours), and `OPTIMAL_UTILIZATION_RATE`.

Exactly **two** Stenion-chosen constants survive in lending's continuous factors, and both carry the
label in both places — that count is the point of the gate:

| Constant                 | Value   | Code                                         | Doc                                                                       | Direction of error, as stated                                                                                                                          |
| ------------------------ | ------- | -------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STALE_CEILING_SECONDS`  | `3600`  | [`core/src/scoring.ts`](core/src/scoring.ts) | [`methodology/index.md`](methodology/index.md) §2a                        | Uncapped, a protocol would score _better_ for tolerating staler prices — K2's 12-hour per-asset `max_age` would rate a six-hour-old price ~50.         |
| `MIN_RESERVE_POOL_SHARE` | `0.005` | [`core/src/scoring.ts`](core/src/scoring.ts) | [the minimum-size filter](methodology/lending.md#the-minimum-size-filter) | Set at the **low** end deliberately: too low leaves a dust reserve in (a misleading number); too high hides a small-but-real reserve (strictly worse). |

**Weights are type (b) and carry the same label.** They are not an external fact. Lending's five are
declared once in `CATEGORY_FACTORS` ([`core/src/weights.ts`](core/src/weights.ts)) — whose comment
says outright that the module "is where they live, not an argument that they are right" — and
`methodology/`'s "Factor weights" table carries the matching note: `oracleSafety` is heaviest
because an untrustworthy price poisons every other measurement, liquidity lightest because it partly
overlaps utilization, and there is no external framework the exact numbers are anchored to. A
category's weight table is therefore part of what Gate 1 reviews, not a presentation detail.

**A long type-(b) list is itself the finding.** A rulebook whose numbers are mostly labelled has
designed a set of preferences, not a set of measurements.

---

## Gate 2 — Anything ungradable is disclosed, never faked

**Condition.** For every quantity the category can read but cannot legitimately grade, the submission
picks **exactly one** of three routes, **states which**, and **states why not the other two**:

- **(a) A disclosure component** — published with `value: null` on the factor it belongs to:
  measured, shown, deliberately not graded.
- **(b) A documented precondition** — the protocol is **not scored at all**, and is published as a
  coverage entry with a reason and a date rather than as a number.
- **(c) Live ungraded state** — measured every cycle, published as a typed field **beside the score
  wherever the score appears**, never an input to it.

**Fails if:** the quantity resolves to a silent `0`, an invented value, a "neutral" placeholder that
is not flagged as one, or a fourth mechanism invented for the occasion.

**Corollary, and it is not optional: "unassessable" resolves to the unsafe end of the scale, never
the top.** A minimum over an empty set is `0`, not `100`.

**Lending as the worked example — all three routes are live:**

- **(a)** §2c publishes every reserve's price age as `priceAges` (`value: null`), ordered
  oldest-first, with a count of how many exceed **the protocol's own** declared staleness limit. §2d
  publishes the raw deviation bound the same way, because Blend's per-asset whole-percent `max_dev`
  and K2's global basis-point `max_price_change_bps` measure against different baselines over
  different intervals — grading the pair would invent comparability the data does not support. §4/§5
  publish `excludedReserves`, naming each filtered reserve, its supplied USD, its share, and **the
  score it would have contributed**, so a reader can disagree with the exclusion instead of never
  learning of it.
- **(b)** [§2e, the oracle-legibility precondition](methodology/lending.md#2e-the-oracle-legibility-precondition):
  a market whose price path publishes neither a staleness tolerance nor a deviation bound is not
  scored — not with a guessed anchor, and not with the factor dropped. Those markets are published in
  `coverage.ts` as `oracle-not-gradable`. So is the
  [market-size floor](methodology/lending.md#the-market-size-floor), as `below-size-floor`. Neither renders a
  numeral.
- **(c)** `operationalState` ([`core/src/operational-state.ts`](core/src/operational-state.ts),
  decided in #15): which user operations a market's contracts are currently refusing, published
  beside the name and score everywhere either appears. Both adapter suites assert a **byte-identical
  factor map** across every restricted state their protocol can be in, so route (c) cannot leak into
  a score.

**The "why not the other two" requirement is where the real work is, and lending shows why.** §2e
does not merely assert route (b) — it measures the alternatives and publishes the result. Scoring
`oracleSafety` on what remains collapses `deviationBound` to a constant `0` (which asserts a
deliberate disabling nobody chose) and `priceFreshness` to a constant `100` for two markets that
price off the ledger clock. Dropping the factor to `null` renormalizes over `0.75` instead of `1.00`,
and on live 2026-08-26 data that made Orbit publish **71 — the highest number in the registry** —
while frozen and 99.5% concentrated in a synthetic priced at a hardcoded `1.0`. Not publishing the
mechanism at all would have paid better than publishing it switched off.

**The corollary has a dated precedent.** On 2026-08-16, `liquiditySafety` and `utilizationSafety`
returned **100** when no reserve cleared their minimum — a minimum over an empty set, published as
maximally safe from no data. Both now return **0**. The correction is recorded in lending's changelog
under "Corrections that did not bump the version", including the evidence that the path had never
executed. A fabricated `100` is worse than a fabricated `0`, because `0` at least renders in the
danger band where a reader discounts it. Ground rule 4 forbids both.

---

## Gate 3 — Every rejected alternative is recorded by name

**Condition.** Each candidate factor, sub-signal, or scoring approach that was considered and dropped
has a **named entry in the category's `methodology/<category>.md` file** giving what it was and
why it was
rejected. A reviewer can find any of them by name.

**Fails if:** the submission presents only what it kept. **An unrecorded rejection gets
re-litigated** — by a contributor, by a scored protocol, or by us in six months — and the second time
around the reasoning has to be rebuilt from memory, if it survives at all.

**Lending as the worked example.** §2's
[**"What was rejected, and why it must not be re-proposed"**](methodology/lending.md#what-was-rejected-and-why-it-must-not-be-re-proposed)
is the model: three named alternatives (making the oracle metadata reads optional, a `null`
`oracleSafety`, reading the anchor from an upstream oracle), each with the reason and, where it
exists, the measured consequence. §2's **"What was considered and deliberately rejected"** does the
same for candidate manipulation signals, each tested against a single question — would it have
distinguished the February 2026 YieldBlox manipulation from a legitimate price **at the time**? —
because a signal that looks sophisticated but would not have caught the actual attack manufactures
confidence.

Two more instances worth copying:

- [Operational state is published, never scored](methodology/publishing-rules.md#operational-state-is-published-never-scored)
  records all three options weighed (a sixth factor, a multiplier, a published flag) **and** the
  strongest scored variant — folding `exitDisabled` into `liquiditySafety` — explicitly marked
  "recorded here so it is not re-proposed as the obvious fix."
- [`ROADMAP.md`](ROADMAP.md) points back at §2 for the rejected oracle candidates rather than
  restating them, so there is one copy of the reasoning and one place it can be argued with.

---

## Gate 4 — A size floor derived from this category's own economics

**Condition.** The submission defines a size below which a published number stops carrying
information, and shows:

1. **The derivation** — what specifically makes _this category's_ numbers meaningless below that
   line, in terms of what its factors measure;
2. **The motivating observation** — a real market, a real reading, with a date, whose published
   number would have been misleading;
3. **The direction of error**, argued rather than asserted;
4. **What the floor does not claim**, and where an excluded market goes instead.

**Fails if:** lending's numbers are reused. Copying `$5.00` or `0.5%` is an **automatic fail** —
`$5.00` is `PoolConfig.min_collateral`, Blend's own statement of the smallest collateral a position
may hold and still borrow, and it is meaningless outside a market that has collateral and borrowing.
A floor is derived, never inherited.

**Lending as the worked example.** Two levels, written together so neither reads as an afterthought:

- **[The minimum-size filter](methodology/lending.md#the-minimum-size-filter)** asks whether a _reserve_ is
  big enough for its number to mean anything. Motivating observation: on the 2026-08-16 Kinetic
  snapshot a **$3.00** PYUSD reserve — **0.19% of a $1,571 pool** — was the worst reserve on both §4
  and §5, setting `liquiditySafety` to 34 and `utilizationSafety` to 18. Nobody's capital was
  meaningfully exposed to it.
- **[The market-size floor](methodology/lending.md#the-market-size-floor)** asks the same of a whole
  **market**, and derives from what the category's factors do when there is nothing to read: every
  factor falls to its can't-assess branch, and every one of those branches is `0`. Motivating
  observation, dated 2026-08-20: K2 Earn held **$0.00** and the K2 SolvBTC/xSolvBTC market **$3.62**.
  Scored, each would have published `0` — in the danger band, reading "this is dangerous" when the
  truth is "there is nothing in here."

Both state their direction of error explicitly, and they do not reach the same answer — which is why
the gate asks for the argument rather than the number. The market floor leans toward **keeping
markets in**, on the ground that raising it buys nothing against the failure it exists for (a score
computed from no data is fully prevented at `$5.00`) and that excluding a market is a far stronger
action than excluding a reserve: a filtered reserve leaves a scored market and a published
disclosure, while an excluded market leaves nothing at all for a reader to disagree with.

And both say what they are not: the market floor "guarantees only that a published number was
computed from **something rather than nothing**. It is emphatically **not** a quality bar." Whether a
scorable market is worth _listing_ is a curation question, flagged there and deliberately left
unanswered, because answering it with a threshold would dress an editorial judgment as a measurement.
Excluded markets go to `coverage.ts` with a per-market reason, a date and a `verify` sentence — never
a numeral.

**One more thing to copy:** the market-size floor documents, honestly, that it is currently enforced
only by the decision not to register such a market, and files the missing code path in
[`ROADMAP.md`](ROADMAP.md) rather than implying it exists. A submission may have a gap; it may not
have an undisclosed one.

---

## Gate 5 — Comparability declared in both directions, and enforced in the surfaces

**Condition.** The category's `methodology/<category>.md` file states explicitly that its scores
are
**comparable within the category** and **not comparable across categories**, and the submission names
the specific surfaces that enforce it.

**Fails if:** the category ships without its own ranked block and its own `#` scope. A `safetyScore`
is comparable only with one produced by the same rulebook — each category is scored on its own
factors under its own weights, so the same numeral in two categories is two different measurements
wearing the same digits.

**Lending as the worked example — the enforcement is structural, not a rendering habit** (#78):

- [`dashboard/app/lib/registry-query.ts`](dashboard/app/lib/registry-query.ts)'s `buildRegistryView`
  publishes **`RankedCategoryGroup[]` and no flat ranked array**. There is nowhere for a
  cross-category ranking to live, so no ordering — present or future — can produce one.
- The `#` numeral counts **from 1 inside one group and nowhere else**, and renders **only** under
  score-descending; under any other sort the column is removed rather than blanked.
- **Name sort is the sole ordering allowed to merge** categories (and scored with unscored), because
  alphabetical asserts no ranking.
- Group order is alphabetical by category and deliberately says nothing — it may not be derived from
  the scores inside, since that would read as a ranking of categories.
- `risk_scores.category` is stamped beside `risk_scores.methodology_version`, and `category` is
  published on the API responses, so a stored score carries the rulebook it belongs to rather than
  leaving a reader to infer it.
- All of this is asserted in `registry-query.test.ts`, which also pins that a **single-category board
  renders exactly what it did before this rule existed** — so the second category lands as a rulebook
  plus an adapter, not as a ranking bug.

**What the submission must do here is small, because the machinery already exists:** state the claim
in both directions in its own section, and confirm its entries carry their category through to the
board and the API.

---

## Gate 6 — No drift, held to the same bar as lending

**Condition.** Code and document change **in the same PR**, at the same review bar. The category's
**weight table**, **worked example** and **factor keys** are asserted against the code by a test that
**reads the document** — extending the existing pattern in
[`core/src/scoring.test.ts`](core/src/scoring.test.ts), never a second hand-maintained copy of the
numbers.

**Fails if:** the numbers are restated anywhere a human has to keep in sync — in a test file, a
second table, or a dashboard constant.

**Lending as the worked example.** The chain runs adapter → `CATEGORY_FACTORS` → the published
rulebook, with no hand-written copy in it. Adapters read `LENDING_FACTORS.<factor>.weight` and never
a literal (#77). `scoring.test.ts` then parses `methodology/<category>.md` rather than restating
it: it locates
a category's section by `## ${CATEGORY_FACTORS[category].label}` — the heading text comes from the
code, so the document and the code cannot disagree about what the section is called — and pulls the
weight table and the worked example out of that slice. Its assertions are **already per category**
and already iterate `PROTOCOL_CATEGORIES`, so a category registered in code with no
`methodology/<category>.md`
section fails with the message that "a category with no published rulebook is a score nobody outside
can check."

**What that means mechanically for a submission.** The section must be parseable by the readers that
already exist, which is a low bar deliberately:

- An `##` heading whose text matches the category's `label` in `CATEGORY_FACTORS` (lending's is
  `Lending`).
- A weight table of rows shaped ``| `someSafety` | 0.NN |``, summing to `1.00` — `weights.test.ts`
  asserts the sum, because `scoreFactors` divides by the _observed_ total and would happily produce a
  confident-looking number from a set summing to 0.9.
- A worked example line in the published form — `v×w + v×w + … = x.y → z` — computed from a real
  reading, with the market and date named, exactly as lending's is.
- Its own factor list, worked through in the same detail: the raw on-chain data, the formula, and why
  each threshold is what it is.

`scoreFactors` itself is generic over the factor map and must stay that way: the weighted mean is
category-agnostic, so there is never a per-category variant of it.

---

## Gate 7 — Versioning independent, stamped per run, never backfilled

**Condition.** The category's methodology version **starts at 1** on its **own counter**, is
**stamped onto every run alongside the category**, and has **its own changelog table** in its own
section. History is **never backfilled** across a bump.

**Fails if:** the category shares lending's counter, shares its changelog, or proposes to recompute
stored rows under new rules.

**Lending as the worked example.** `METHODOLOGY_VERSIONS` in
[`core/src/category.ts`](core/src/category.ts) is a `Record<ProtocolCategory, number>` — a category
added to `PROTOCOL_CATEGORIES` is a compile error until it has an entry (#76), the same shape
`CATEGORY_FACTORS` and `CATEGORY_OPERATIONS` use. Counters are independent and each starts at 1, so
**the integer alone does not identify a rulebook**: the indexer stamps `risk_scores.category` beside
`risk_scores.methodology_version`, resolved from the target's own category, and an adapter has no say
in the version — it only declares which category it belongs to.
[`methodology/index.md`'s "Current version"](methodology/index.md#current-version) table carries one row per
category, pointing at that category's own section for the changelog behind it.

**Backfilling is not a policy but an impossibility, and say so:** `risk_scores` stores only outputs —
the score and the factor map — never the raw on-chain inputs a run was computed from, so no one,
including us, can recompute an old row under new rules. The discontinuity is labelled, not hidden:
the score-history chart **breaks the line** at a version change rather than drawing through it.

**What a new category does not inherit:** lending's v1 discarded a few weeks of development-era
history rather than migrating it, on reasoning `methodology/` explicitly closes — "this is the last
time that reasoning applies." A new category starts with no history at all, so it never needs that
argument. What it does inherit is the rule from that day forward: bump when a change alters what a
number means; don't bump for a fix that makes the implementation match the rule already documented
(record it as a correction instead).

---

## Gate 8 — The adapter reads only the protocol's own on-chain contract state

**Condition.** Every raw input to every factor traces to a **named contract, and a named method or
storage field**, read over **Soroban RPC or Horizon**. Nothing else.

**Disqualifying, regardless of how well-anchored the rest of the rulebook is:** a third-party
aggregator or data API, an indexer's or subgraph's API, the protocol's own self-reported or
dashboard-published figures, another protocol's contracts standing in for this one's, or another
chain's RPC.

**This gate carries the same weight as every other gate here, and it is non-negotiable.** It is not
an implementation preference — **it is the product's core trust claim.** The pitch is that a reader
does not have to trust us: every number is recomputable by anyone from the same trustless
infrastructure we read. A single off-chain input quietly changes what _every_ score on the registry
means, because the claim is made platform-wide and cannot be made per-protocol.

**Precedent — a real lending protocol was already declined on exactly this ground.** Templar is
published in [`dashboard/app/lib/coverage.ts`](dashboard/app/lib/coverage.ts) under
`off-chain-state`: a NEAR-based chain-abstraction protocol whose reserves, supply and borrow
balances, utilization and collateral positions are all read through NEAR RPC. The only
native-Soroban contract it ships is a price oracle — one of lending's five factors, with the other
four on another chain. The entry states the reasoning in the terms this gate uses: adapters "read
trustless Stellar infrastructure and nothing else — that rule is the pitch rather than an
implementation detail, so bending it for one protocol would quietly change what every other score
means." [`ROADMAP.md`](ROADMAP.md) keeps multi-chain explicitly out of scope for the same reason.

**Two practical requirements that follow:**

- **Confirm the reads against the contract, not against an assumption.** Read the exported interface
  out of the wasm (Soroban RPC's `getContractMethods`, or the `contractspecv0` custom section) rather
  than calling a list of method names you expect to exist — a guess-list cannot distinguish "this
  contract lacks the method" from "this is a different contract than you think," which is precisely
  how four Blend V2 markets were mistaken for one interface when they are four
  ([`CONTRIBUTING.md`](CONTRIBUTING.md), "Is this protocol even in scope?").
- **An investigation that ends in "we can't read this on Stellar" is a result.** It is published as a
  `CoverageEntry` with a protocol-specific reason, a one-sentence `summary`, a `verify` sentence, and
  an `asOf` for any claim resting on a reading — enforced by `coverage.test.ts` — not left in a
  terminal history.

---

## Pre-flight checklist

Check this off against a category submission **before any adapter is written for it**. Every box is a
yes/no, and every box must be **yes**.

**Gate 0 — the category is a failure mode**

- [ ] One sentence naming the question this category's factors answer that no existing category's
      factors already answer.
- [ ] Per proposed factor: the failure it detects that lending's five cannot.
- [ ] No proposed factor is an existing factor rephrased, rescaled, or renamed.

**Gate 1 — thresholds anchor or are labelled**

- [ ] A complete list of every threshold in the rulebook — none omitted.
- [ ] Each anchored threshold names the **specific contract field** it reads.
- [ ] Each unanchored threshold is marked "unvalidated judgment call" in **the code**.
- [ ] …and in **`methodology/`**, with the reasoning **and the direction of error**.
- [ ] The weight table is present and carries the same label — weights are a judgment call.

**Gate 2 — ungradable is disclosed**

- [ ] Every ungradable quantity is assigned to route (a) a `value: null` disclosure component,
      (b) a documented precondition that leaves the protocol unscored, or (c) live ungraded state
      published beside the score.
- [ ] For each: **why not the other two**, measured where the alternatives can be measured.
- [ ] No silent `0`, no invented value, no unflagged placeholder, no fourth mechanism.
- [ ] Every "cannot assess" branch resolves to the **unsafe** end of the scale — a minimum over an
      empty set is `0`, not `100`.
- [ ] Anything on route (b) has a coverage entry with a reason, a `verify` sentence and a date.
- [ ] Anything on route (c) is published everywhere the score is published, and is provably
      unreachable from the factor map.

**Gate 3 — rejections are recorded**

- [ ] Every considered-and-dropped candidate has a named entry in the category's section, with its
      reason.
- [ ] Where a candidate was rejected on measured grounds, the measurement is published with it.

**Gate 4 — the size floor is this category's own**

- [ ] A floor exists, derived from what makes **this** category's numbers meaningless.
- [ ] The derivation is shown, in terms of what the factors measure.
- [ ] A dated, real motivating observation is given.
- [ ] The direction of error is argued.
- [ ] What the floor does **not** claim is stated, and where an excluded market goes instead.
- [ ] No number is copied from lending's market-size floor or minimum-size filter.

**Gate 5 — comparability declared both ways**

- [ ] The section states scores are comparable **within** the category.
- [ ] …and **not** comparable **across** categories.
- [ ] The category has its own ranked block and its own `#` scope; no ordering places two categories'
      scores in one ranked sequence.
- [ ] Entries carry their category through to the board and the API.

**Gate 6 — no drift**

- [ ] Document and code land in the **same PR**.
- [ ] The `##` heading text matches the category's `label` in `CATEGORY_FACTORS`.
- [ ] The weight table parses, and sums to `1.00`.
- [ ] The worked example parses, and is computed from a real, dated reading.
- [ ] `scoring.test.ts`'s per-category assertions pass for the new category, with **no new
      hand-maintained copy** of any number.
- [ ] The adapter reads its weights from `CATEGORY_FACTORS` — no literal weights anywhere.

**Gate 7 — versioning**

- [ ] `METHODOLOGY_VERSIONS` gains the category at **1**.
- [ ] The category's section has its **own** changelog table.
- [ ] Runs are stamped with the version **and** the category.
- [ ] No proposal to backfill history across a bump.

**Gate 8 — on-chain only**

- [ ] Every raw input names a contract and a method or storage field.
- [ ] Every read is Soroban RPC or Horizon — nothing else.
- [ ] No aggregator, indexer API, self-reported figure, or other chain anywhere in the data path.
- [ ] Interfaces were confirmed out of the wasm, not from a guessed method list.

---

**A submission that clears every gate is a rulebook.** It is then reviewed at the same bar as any
methodology change — see
[Disputing or changing a threshold](methodology/publishing-rules.md#disputing-or-changing-a-threshold) — and only then
does an adapter get written against it.
