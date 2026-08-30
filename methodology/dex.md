## Dex

Everything from here to the end of this file is **the DEX rulebook and the DEX rulebook alone** —
its version changelog, its two factors, what it refuses to score, and what it defers. Nothing in [`index.md`](index.md) is lending-specific and all of it applies here; nothing
in [`lending.md`](lending.md) may be assumed to hold for this category, and nothing here may be
assumed to hold for lending.

**Which markets are scored under it: one — Aquarius's XLM/USDC constant-product pool**
(`CA6PUJLB…`, registry id `aquarius-xlm-usdc`). This section was published and reviewable _before_
any market was scored under it, which [`../TAXONOMY.md`](../TAXONOMY.md) says is the point of
writing it first. It was admitted as a gate-checked submission against Aquarius on Stellar mainnet
in two reviews — the factor set first, the weight table second — then implemented in
`adapters/aquarius/` and registered.

**One market, and the reason is the indexer rather than the rulebook.** Aquarius runs **340** pools
across 304 token sets — read from the router's own `get_pools_for_tokens_range` at ledger
64,182,824 on 2026-08-29 — and every one of them is scorable under the rules below, because neither
factor here is size-sensitive (see [Size floor: none, and none pending](#size-floor-none-and-none-pending)).
What limits the registry is that one scoring cycle runs inside a 60-second serverless ceiling and
fits five markets, of which four were already lending. The other 339 are published as assessed and
unregistered on the registry, under `coverage.ts`'s `awaiting-capacity` status — never as a score,
and never as a finding about them.

> **This rulebook is complete: two factors, each with a formula, and a reviewed weight table.** The
> table was deliberately absent when the category was admitted and landed in a review of its own —
> a weight can only ever be a type-(b) unvalidated judgment call, and arguing one alongside the
> argument for the factor set would have buried it. Both halves are here now, in
> [Factor weights](#factor-weights) and [The two dex factors](#the-two-dex-factors), and
> `CATEGORY_FACTORS.dex` in [`../core/src/weights.ts`](../core/src/weights.ts) carries
> `status: 'published'` to match. Every Stenion-chosen number in either formula is listed in
> [Unvalidated judgment calls](#unvalidated-judgment-calls).
>
> **The category ships with TWO factors, not the three the submission proposed.** `depthSafety` is
> deferred by [question A](#question-a--resolved-no-depth-factor-until-there-is-a-unit-of-value),
> which is resolved rather than open. Gate 0 is re-argued for the two that remain in
> [Gate 0, re-argued](#gate-0-re-argued-for-two-factors).
>
> **There is no size floor, and none is pending.** Neither surviving factor is size-sensitive, so
> there is nothing for a floor to protect — see
> [Size floor: none, and none pending](#size-floor-none-and-none-pending). This is a consequence of
> question A's resolution, not an open item.

**Everything below was read from mainnet, not from documentation.** That distinction is
load-bearing for this category in a way it was not for lending: `github.com/AquaToken/soroban-amm`
— the repository Aquarius's own audit scope links to — **returns 404 as of 2026-08-27**. There is
no source to read. Every interface claim here comes from the contract spec in the deployed wasm
(`getContractMethods`) and from instance storage, which is what Gate 8 asks for anyway.

**Two dated read sets appear below, and each reading says which it is from.** The census
readings — the 340-pool survey, the role structure, the issuer-flag sample, the kill-switch state —
are **mainnet ledger 64,152,946, 2026-08-27T20:00Z**, taken when the category was admitted. The
[worked example](#factor-weights) is computed from the mainnet fixtures captured on
**2026-08-29T09:35Z**, which live in `adapters/fixtures/aquarius/` and are checked into the repo, so
its arithmetic can be re-derived rather than taken on trust.

### Version changelog

Every scored run is stamped with the rulebook version that produced it
(`risk_scores.methodology_version`, from the `dex` entry in `METHODOLOGY_VERSIONS` in
[`../core/src/category.ts`](../core/src/category.ts)), and it is surfaced on the API's protocol
detail and on each history point. **Versions are per category and counters are independent, so this
changelog is `dex`'s.** `dex` v1 and `lending` v1 are not two editions of one rulebook and one is
not older than the other; they are two different rulebooks that each start counting at 1. The
category is stored beside the integer because the integer alone does not identify a rulebook.

| Version | Effective  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | 2026-08-29 | The initial two-factor model as documented here — `adminKeySafety` (role posture and the upgrade reaction window) and `assetControlSafety` (issuer freeze and clawback) — weighted 0.55 / 0.45. `depthSafety` is deferred (question A, option 4) and no size floor is needed by either factor that ships. The factor set was admitted first and the weight table reviewed second; both are version **1**, because no score was ever published under the factor set alone. Live since `aquarius-xlm-usdc` was registered on 2026-08-29; every stored `dex` row carries it. |

**Changed under v1, without a bump: `2026-08-30`, a rate limit is no longer a reading.** Aquarius
was capturing a Horizon read that never reached an answer — an exhausted `429`, a dropped
connection, a `5xx` — as a localized cannot-assess and scoring it **0**. It is now a failed run.
Recorded here rather than as a version 2 because
[What bumps the version](index.md#what-bumps-the-version-going-forward) says a fix that makes the
implementation match the documented rule does not bump: the affected scores were wrong under this
rulebook, not produced by a different one. No formula, tier or weight moved. Full reasoning in
[A rate limit is not a reading](#a-rate-limit-is-not-a-reading).

One row, and it describes the rulebook every stored `dex` score was produced under. It was published
before any of them existed, which is deliberate: Gate 7 requires a category to arrive at version 1
rather than acquire a version once it starts producing numbers, so the counter exists from the moment
the rulebook is published. **The first stored `dex` row carried version 1** — settling the weight
table did not bump it, because there was no prior published number for a weight to make incomparable:
a rulebook that could not compute a score cannot have produced one that a weight made non-comparable.
From that first stored row onward the ordinary rule in
[What bumps the version](index.md#what-bumps-the-version-going-forward) applies without exception,
and the next change to either weight is a version 2.

History is **not backfilled across a bump, and cannot be**, here as everywhere: `risk_scores`
stores only outputs, never the raw on-chain inputs a run was computed from.

### Factor weights

Dex's weights, and dex's only. This table is the published face of `CATEGORY_FACTORS.dex` in
[`../core/src/weights.ts`](../core/src/weights.ts), which is where the adapter reads them from — no
adapter contains a weight of its own, and `core/src/scoring.test.ts` parses this table and fails if
the two disagree in either direction.

| Factor               | Weight   |
| -------------------- | -------- |
| `adminKeySafety`     | 0.55     |
| `assetControlSafety` | 0.45     |
| **Total**            | **1.00** |

**Worked example** — the Aquarius XLM/AQUA constant-product pool
`CCSY43EHJAHT3NQDYKAMJXRFBEEH7OXDL3J3VNGO33UUSEXWNN27GBIZ`, from the mainnet fixture captured
**2026-08-29T09:35:43Z** (`adapters/fixtures/aquarius/constant-product-mainnet.ts`), dex methodology
v1:

`10×0.55 + 70×0.45 = 37.0 → 37`

Both terms, derived from that fixture's own fields so the arithmetic is checkable rather than
asserted:

**`adminKeySafety` = 10.** Role posture is the minimum over the seven roles
([§1](#1-adminkeysafety--seven-roles-and-how-long-you-get-to-react-to-a-code-change-weight-055)):

| Role                  | Read from the fixture               | Base | Activity penalty | Score  |
| --------------------- | ----------------------------------- | ---- | ---------------- | ------ |
| `Admin`               | `signerCount 3`, `high_threshold 2` | 90   | −30 (96 ops)     | 60     |
| `EmergencyAdmin`      | `signerCount 1`, `high_threshold 0` | 40   | −0 (0 ops)       | 40     |
| `EmergencyPauseAdmin` | `signerCount 1`, `high_threshold 0` | 40   | −0 (0 ops)       | 40     |
| `PauseAdmin`          | `signerCount 1`, `high_threshold 0` | 40   | −0 (0 ops)       | 40     |
| `OperationsAdmin`     | `signerCount 1`, `high_threshold 0` | 40   | −0 (0 ops)       | 40     |
| `RewardsAdmin`        | `signerCount 1`, `high_threshold 0` | 40   | −30 (200 ops)    | **10** |
| `SystemFeeAdmin`      | `signerCount 1`, `high_threshold 0` | 40   | −30 (200 ops)    | **10** |

`rolePosture = min(…) = 10`. The fixture's `upgrade.deadline` is `0n` on both the pool and the
router, so `upgradeCeiling = 100` and the ceiling does not bind: `min(10, 100) = 10`.

**`assetControlSafety` = 70.** The minimum over the pool's two reserve tokens
([§2](#2-assetcontrolsafety--can-a-third-party-freeze-or-seize-what-the-pool-holds-weight-045)):

| Reserve token    | Read from the fixture                                                | Score  |
| ---------------- | -------------------------------------------------------------------- | ------ |
| XLM `CAS3J7GY…`  | SAC, `issuer.status = noIssuer` — no issuer account exists           | 100    |
| AQUA `CAUIKL3I…` | SAC, issuer `GBNZILST…`, all four flags `false`, not `authImmutable` | **70** |

`min(100, 70) = 70`.

**The other three fixtures, for the spread** — same weights, same formulas, computed the same way,
from the same 2026-08-29 capture. All four pools read the same admin posture, so
`assetControlSafety` is the only term that moves:

| Fixture                    | Pool                     | `adminKeySafety` | `assetControlSafety`                       | Score |
| -------------------------- | ------------------------ | ---------------- | ------------------------------------------ | ----- |
| `constant-product-mainnet` | XLM/AQUA                 | 10               | 70                                         | 37    |
| `concentrated-mainnet`     | XLM/AQUA                 | 10               | 70                                         | 37    |
| `stable-mainnet`           | USDC/USDx/yUSDC          | 10               | 40 (Circle USDC is `auth_revocable`)       | 24    |
| `wasm-token-mainnet`       | USDC (SAC) / USDC (wasm) | 10               | 40 (the wasm token is excluded, route (a)) | 24    |

> **The weights are an unvalidated judgment call, not an external fact.** `adminKeySafety` carries
> more because its subject is the pool's **own code and role set**: a compromise there reaches every
> token the pool holds, the fee it charges, whether it trades at all, and the code path an LP's
> withdrawal runs through. `assetControlSafety` reaches only the balances of one issuer's own
> asset and cannot touch the pool's code — a pool holding one flagged token and one clean one has a
> fraction of its value exposed, and the AMM's withdraw path still works.
>
> It is **close behind rather than a minor term** because it is the one failure Aquarius cannot
> mitigate and the LP gets no warning for: a clawback is a single issuer transaction with no window
> at all, while a code change is announced by `UpgradeDeadline` before it lands. Those two arguments
> nearly cancel, which is why the gap is 0.10 rather than lending's spread — **the ordering is the
> claim, and the gap is deliberately small.**
>
> **Direction of error:** if the split is wrong it is wrong by under-weighting issuer control. A
> reader who holds that unmitigable-and-unannounced should dominate would push toward 0.45 / 0.55,
> and there is no external framework that anchors against them. Full label and the rest of the list
> in [Unvalidated judgment calls](#unvalidated-judgment-calls).
>
> **They were not chosen to make the scores spread out, and must not be.** All 340 pools shared one
> admin posture in the 2026-08-27 census, and the four pools captured on 2026-08-29 still did — so
> `adminKeySafety` discriminates between Aquarius markets not at all today and `assetControlSafety`
> carries the whole variance, as the four-fixture table above shows.
> Down-weighting the constant factor to widen the registry's range would be calibrating a **category
> rulebook** against **one protocol's current data**, which is the failure this document refuses
> everywhere else. A weight states which failure matters more, not which reading varies more.

**Both steps of the two-step admission are now done.** [`../TAXONOMY.md`](../TAXONOMY.md) admits a
category in two reviews, and this one passed through both:

|                               |                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Step 1 — the factor set**   | Which failures are scored, what each factor's on-chain anchor is, what was rejected. Reviewable on its own, and reviewed. |
| **Step 2 — the weight table** | What each factor's share is and what each formula computes, argued as judgment calls and labelled as such. **Done.**      |

Between the two, `CATEGORY_FACTORS.dex` declared `status: 'pendingWeights'` and its factor entries
carried **no `weight` property at all** — not a zero, not a placeholder — so reading a weight off one
was a compile error rather than an `undefined` that would become `NaN` inside `scoreFactors` and
publish a confident-looking `0`. It now declares `status: 'published'`, and the table above is
pinned against it by `core/src/scoring.test.ts` in both directions: a weight edited here alone, or
there alone, fails.

### The two dex factors

For each factor: the exact raw on-chain data that feeds it, what it detects, and why it is here.
Every anchor names a contract **and** a method or storage field, per Gate 8.

**Two, not five, and the missing three are not an omission.** Three of lending's five have no
referent in a spot AMM at all:

| Lending factor      | Status for a spot AMM    | Why                                                                                                                                                                                                                                 |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `utilizationSafety` | **No referent**          | It grades distance from a protocol-declared borrow cap. An AMM has no borrow ledger and no cap; nothing resembling one appears in any of the three pool wasms.                                                                      |
| `liquiditySafety`   | **No referent**          | `(supplied − borrowed) / supplied` is identically `1` for every AMM pool. The formula would publish **100** for all 340 pools, from no information.                                                                                 |
| `oracleSafety`      | **No referent**          | Aquarius reads no price feed anywhere — established exhaustively below, not by failing to find one. Price comes from reserves, or from tick state.                                                                                  |
| `collateralSafety`  | **Misleading if reused** | HHI over reserves. A two-token pool's reserve split _is its price_, so the HHI is dominated by the two assets' unit prices rather than by any concentration risk — it would grade a pool worse for pairing assets of unequal price. |
| `adminKeySafety`    | **Applies, same key**    | "Who can change the rules" is genuinely the same question. Kept under the same name, computed from different data — see below.                                                                                                      |

**Aquarius reads no oracle, and this was established rather than assumed.** The exported function
list of the router, all three pool wasms, the plane, the liquidity calculator, the config storage
**and** the reward-boost feed were each read out of the deployed wasm. None contains a price read,
and no price-feed address appears in any instance storage. The one contract whose name suggests
otherwise — `RewardBoostFeed` `CBKCROE56TU2FTT3C5CVN676PYVLTOQUQDHHH57GLWDY5VOKSCZPGOFN` — exports
exactly `total_supply()` and `set_total_supply(operations_admin, …)` and holds
`TotalSupply = 642372689091226311`. It is a locked-AQUA supply feed for reward boosting; it is not a
price oracle. So `oracleSafety` is not "ungradable" in Gate 2's sense — it has nothing to be
ungradable _about_, which is why it is absent rather than disclosed.

#### Gate 0, re-argued for two factors

The submission proposed three factors and this rulebook ships **two**: `adminKeySafety` and
`assetControlSafety`. `depthSafety` is deferred — see
[question A](#question-a--resolved-no-depth-factor-until-there-is-a-unit-of-value). Question A's
option 4 said plainly that "a two-factor category is thin enough that Gate 0 should be re-argued
before accepting it," so it is re-argued here rather than assumed to carry over.

**Gate 0 asks whether the category's factors answer a question no existing category's factors
already answer. Each of the two does, on its own:**

- **`adminKeySafety` — the two-step upgrade reaction window.** Aquarius's upgrades are
  `commit_upgrade` → wait → `apply_upgrade`, and while a deadline is pending `UpgradeDeadline − now`
  is exactly how long an LP has to withdraw before the code under their money changes. **Lending's
  `adminKeySafety` cannot see this**: it reads one admin account's signer set and threshold, which
  says who could act and says nothing about how much warning anyone gets. The factor shares
  lending's key because it is the same question — but a lending market's answer to it is computed
  from a different quantity, and the reaction window is a failure mode lending's version has no
  access to.
- **`assetControlSafety` — issuer-level freeze and clawback.** A pool can be created
  permissionlessly against any token; if that token is a SAC whose issuer has `auth_revocable` or
  `auth_clawback_enabled` set, the issuer can freeze or seize the pool's balance and an LP's exit
  stops depending on the AMM's code at all. **No lending factor detects this**, and it is not a
  rephrasing of one: `collateralSafety` measures concentration among assets, not whether a third
  party outside the protocol can take them.

**Two is enough to clear the gate, because Gate 0 is a per-factor test and not a headcount.** It
fails a factor that duplicates an existing one; it does not set a minimum. Both survivors detect
failures lending's five cannot see, from readings with real live variance — Circle's USDC issuer has
`auth_revocable: true`, a second asset also called `USDC` sits in the same registry, the owner key is
a 2-of-3 multisig while six other roles are lone keys, and none of that is visible from any lending
factor.

**What this does NOT claim, stated because the omission is the part that could mislead.** Leaving
`depthSafety` out is **not** a judgment that execution cost is unimportant to DEX risk — it is
close to the most important thing about an AMM, and the category's own Gate 0 sentence asks whether
a trader can get out at the size they are actually trading. This rulebook currently answers the
second half of that sentence (can an LP's capital leave on terms the pool's own code decides) and
**not the first**. The reason is narrow and it is about anchoring, not importance: **Aquarius
publishes no unit of value**, so any trade size we simulated at would be a number Stenion chose
rather than one the chain states, and Gate 1 exists to keep exactly that out of a published score.

The consequence is that a `dex` score is a **governance-and-asset-control** score, not a liquidity
score, and it must not be read as evidence that a pool is deep. Two things follow, and both are
obligations rather than caveats:

- Depth is still published, as a route-(a) `value: null` disclosure carrying the `estimate_swap`
  readings — so a reader gets the measurement without it being graded. A deferred factor is not a
  hidden one.
- **The scores will cluster, and that is a property of the data rather than a defect.** All seven
  roles read identically across the router and all 340 pools on 2026-08-27, so `adminKeySafety` does
  not currently discriminate between Aquarius pools at all; `assetControlSafety` is the only factor
  that varies, on the tokens a pool holds. Two pools with the same tokens will publish the same
  number. Anyone registering more than a handful of Aquarius markets should read that as the
  registry reporting the truth — these pools really do share one admin posture — and not as a
  ranking.

---

#### Deferred, and not declared: `depthSafety`

**`depthSafety` is not one of this category's factors.** It was proposed as the third and is
deferred by the resolution of
[question A](#question-a--resolved-no-depth-factor-until-there-is-a-unit-of-value). It is **not**
declared in `CATEGORY_FACTORS.dex`, is not weighted, and is not computed: a declared factor with no
formula is a promise the rulebook does not keep, and `weights.test.ts` asserts the key is absent so
it cannot be added back without also publishing the rules for it.

What follows is kept, in full, because the deferral is about **one missing input** and not about the
measurement being wrong. Everything here holds the day a unit of value exists; discarding it would
mean re-deriving it later from a repository that no longer exists.

**Anchors, when it lands:** `estimate_swap(in_idx: u32, out_idx: u32, in_amount: u128) -> u128` on
the pool contract, with `get_reserves()` and `get_fee_fraction()` on the same contract.

**The failure it would detect:** a trader cannot get out at the size they are actually trading.
Nothing in lending's five measures execution cost, because a lending market has no execution — a
withdrawal is at par or it is refused. **That failure is real and this category does not currently
measure it** — see [Gate 0, re-argued](#gate-0-re-argued-for-two-factors) for what is and is not
being claimed by leaving it out.

`estimate_swap` is a pure simulation call that runs the pool's **own** curve — constant product for
`standard`, Curve-style stableswap for `stable`, the tick walk for `concentrated`. So the slippage
figure is computed by the contract being scored rather than modelled by us, which is the strongest
form Gate 8 admits: there is no Stenion-side curve implementation to drift from the deployed one.
Both trade directions are simulated and the **worse** direction is the one that counts, on the same
convention every lending factor uses for reserves — the binding constraint is what a reader needs.

The fee is inside this number already, via `get_fee_fraction()`, because a round trip pays it. That
is the only place fee belongs — see [Fee tier as a factor](#fee-tier-as-a-factor) below.

**Live readings on the XLM/USDC pair, 2026-08-27**, showing the discrimination the factor exists to
produce — two pools on the same pair, one materially deeper, both figures produced by their own
contracts:

| Pool          | Type, fee            | 1,000 XLM in      | 1,000,000 XLM in | Impact     |
| ------------- | -------------------- | ----------------- | ---------------- | ---------- |
| `CA6PUJLBYK…` | standard, 10 bps     | 0.186277 USDC/XLM | 0.168205         | **−9.70%** |
| `CBBMQBNHB2…` | concentrated, 10 bps | 0.186265          | 0.175584         | **−5.74%** |

**Cannot-assess would resolve to 0, the unsafe end.** A pool whose `estimate_swap` reverts, or whose
reserve is zero, would score **0** — never 100, and never a skipped factor, matching
`collateralSafety`'s existing treatment of an empty set.

> **What is NOT settled, and is why this is deferred: the trade size it simulates.** Everything
> above describes _how_ the cost is measured, and all of it holds. _At what size_ has no answer in
> Aquarius's own terms — a pool-relative size makes the factor degenerate across 272 of 340 pools,
> and an absolute size needs a unit of value Aquarius does not have. See
> [question A](#question-a--resolved-no-depth-factor-until-there-is-a-unit-of-value). **No adapter
> may implement this factor** until that changes.

#### 1. `adminKeySafety` — seven roles, and how long you get to react to a code change (weight 0.55)

**Anchors:** `get_privileged_addrs() -> Map` on the router and on every pool; the `UpgradeDeadline`
and `FutureWASM` entries in contract instance storage; Horizon `/accounts/{G…}` for each role's
signer count, thresholds and recent activity.

**This is the same factor key lending uses, and that is a decision, not an oversight.** It is
recorded here so it is not re-litigated, and it was an open question when the category was
admitted:

> Gate 0 rejects a factor that is "an existing factor rephrased, rescaled, or renamed for a new
> audience." **"Who can change the rules under my money" is not a rephrasing of lending's question
> — it is the same question**, and the honest way to say so is to use the same name. The data
> underneath is entirely different: lending reads one admin account's signer set and threshold,
> while this reads seven named roles plus a two-step upgrade deadline. A separate key —
> `roleControlSafety`, say — would have published two names for one failure and started the
> taxonomy fragmenting into synonyms, which is the drift the shared `RiskFactorType` vocabulary
> exists to prevent. So: **one key, two computations, declared per category in
> `CATEGORY_FACTORS`.**
>
> **A shared key is not a comparability claim.** A `dex` `adminKeySafety` of 60 and a `lending`
> `adminKeySafety` of 60 were produced by different rules from different data and mean different
> things — exactly as the two categories' overall scores do. See
> [Comparability](#comparability-within-dex-yes-across-categories-no).

**The failure it detects that lending's version cannot: the upgrade reaction window.** Aquarius
upgrades are two-step. `commit_upgrade(admin, new_wasm_hash, …)` writes `UpgradeDeadline`;
`apply_upgrade(admin)` refuses until that deadline passes; `revert_upgrade(admin)` cancels. When a
deadline is pending, `UpgradeDeadline − now` is **exactly** how long an LP has to withdraw before
the code under their money changes. It is anchored with no Stenion constant in it at all — the
chain states the deadline and the chain states the time.

**Read on 2026-08-27: `UpgradeDeadline = 0` and `FutureWASM == running wasm` on the router and all
340 pools.** No code change is scheduled anywhere.

**The role structure, read on 2026-08-27 — identical across the router and all 340 pools:**

| Role                      | Account                                                    | Signers | `high_threshold` | ops in 30d |
| ------------------------- | ---------------------------------------------------------- | ------- | ---------------- | ---------- |
| `Admin` (owner / upgrade) | `GAV5FBMKD2ZF4X2MGWDNQYUP7KFL7MRM6HZBY7HKQLB4BRHSCCX5J6VS` | **3**   | **2**            | 96         |
| `EmergencyAdmin`          | `GCGZ6E5RBUKLNB4VZ5RC65C4QMBSBJ3COVRRJCWAMCXJC36LB7YYWEKM` | 1       | 0                | 0          |
| `EmergencyPauseAdmin`     | `GA6MVTGQDCJPP27IAMG6PSDTWOJYTD3NUTLR2W54ADBCBY7OID5YUDSI` | 1       | 0                | 0          |
| `PauseAdmin`              | `GA6MA665XVKHTQUZVSMUKUPGT7OREJNCLAZ5ZEH5CXPKYTWFJKZ3YSEK` | 1       | 0                | 0          |
| `OperationsAdmin`         | `GBVQPX2LQ55HLRMLIWBEYVVQL3SZ5RFPRKYLRSLZU4XRIWAXW2KQIMMD` | 1       | 0                | 0          |
| `RewardsAdmin`            | `GCXYKA3BM574WC6TWESEDUGUJTNQ5SVCFMHWLQ634H5FTE7FYPV3JH3X` | 1       | 0                | 200        |
| `SystemFeeAdmin`          | `GB57YDVGLL2BAVOXHPXYCZR77J4MLPLMGJKFMTUKMHFI2AEGS4SGGW7N` | 1       | 0                | 200        |

The owner key is a 2-of-3 multisig; the other six are lone keys. That is a real, checkable posture
and it is not the one Aquarius's own auditor recommended — Certora's Appendix A asks for the Pause
Admin to be "a multisig or DAO" and for the owner key to be kept offline. Both halves are readable,
and both disagree with the recommendation. Publishing that disagreement is the factor doing its job.

**Formula — a per-account tier, minimised over the roles, then capped by the upgrade state.**

Two components, each computed from the readings above, combined by taking the worse of the two.

_Component 1 — role posture,_ from `get_privileged_addrs()` and Horizon `/accounts/{G…}`:

```
base = 90   signerCount > 1 AND high_threshold > 1        # N-of-M multisig
       40   a classic account that is not a multisig      # single master key
        0   a `C…` contract address, or the lookup failed # cannot assess -> unsafe end

activityPenalty = min(30, recentOps × 3)     # recentOps = operations in the last 30 days
accountScore    = clamp(base − activityPenalty, 0, 100)

roleScore   = min(accountScore) over the addresses that role holds
rolePosture = min(roleScore) over the seven roles
```

_Component 2 — the upgrade reaction window,_ from `UpgradeDeadline` and the fetch timestamp:

```
upgradeCeiling = 100   UpgradeDeadline == 0                # no code change is scheduled
                  40   UpgradeDeadline >  fetchedAt        # scheduled; the window is still open
                   0   UpgradeDeadline <= fetchedAt, non-zero
                                                           # matured: applicable at the next
                                                           # ledger, with no warning left
```

```
adminKeySafety = min(rolePosture, upgradeCeiling)
```

**Why these numbers:**

- **The per-account tier is lending's, adopted rather than re-argued** — `90` for an N-of-M
  multisig, `40` for a single master key, `−3` per operation capped at `−30`, exactly as
  [lending §3](lending.md#3-adminkeysafety--admin-signer-structure--activity-weight-020) publishes
  them. The reading underneath is identical on both sides: Stellar's account threshold model and a
  30-day operation count, from the same two Horizon calls. Inventing a second set of integers for
  the same reading would be two rulebooks for one question — which is the drift the shared
  `adminKeySafety` key exists to prevent, applied to the numbers rather than to the name. So the
  _split_ is anchored exactly as it is there (a 1-of-1 key is a single point of unilateral
  compromise; `signerCount > 1 AND high_threshold > 1` provably is not, per Stellar's own threshold
  model), and the _exact integers_ remain a labelled judgment call exactly as they are there.
- **The contract-address branch is `0` here and `60` in lending, and that divergence is the one
  deliberate departure.** Argued in
  [Cannot-assess](#cannot-assess-stated-per-factor--and-what-is-a-failed-run-instead) below: a
  contract admin is a _known, named_ structure lending chose not to grade, while an Aquarius role
  that is not a classic account is a structure we did not expect and cannot describe.
- **The `40` in `upgradeCeiling` is not a new constant** — it is the single-master-key tier, reused.
  While a code change is scheduled, the LP's only remaining protection is a countdown whose length
  cannot be read at all, so the market is graded no better than one whose rules a lone key can
  change. The rule introduces no integer this document did not already publish.
- **The `0` once the deadline has matured is a reading, not a choice.** What this component grades is
  `UpgradeDeadline − now`, and once that is non-positive the measured warning is zero. The chain
  states the deadline and the chain states the time; there is no Stenion constant in that branch.
- **`FutureWASM` is read but does not enter the formula.** Every contract read on 2026-08-29 carried
  a `FutureWASM` equal to its own running hash, so presence is the quiescent state rather than the
  signal — `UpgradeDeadline` is what says a change is scheduled. `FutureWASM` and whether it differs
  from the running hash are published in the factor's `detail` string, because a reader wants to know
  _which_ code is staged, and they are not graded because the deadline already carries the fact.

**Two of the choices above are unvalidated judgment calls** — combining the seven roles by `min`,
and the pending-upgrade ceiling. Both are labelled, with their direction of error, in
[Unvalidated judgment calls](#unvalidated-judgment-calls).

**Two limits, stated rather than papered over:**

- **The timelock _duration_ is not readable, and that is why `upgradeCeiling` is a state rather than
  a curve.** `ADMIN_ACTIONS_DELAY` is a compile-time constant with no getter, and the source
  repository is gone. The chain states the deadline and the chain states the time, so the factor can
  say whether a window is open, say when one has matured, and publish the seconds remaining — what
  it cannot do is say what fraction of the window is left, because it never learns the whole. Any
  grading of the remaining window's _length_ would need a threshold in seconds that Aquarius does
  not state, which is an invented number and ground rule 4 forbids it. So the duration itself takes
  Gate 2 **route (a)**: a `value: null` disclosure component saying it is not readable from the
  contract, published beside the factor rather than folded into it.
- **The Emergency Admin can bypass the delay.** In Aquarius's own words, in their response to
  Certora's H-01: "In the case of system vulnerability fixes, delay may be bypassed by the
  Emergency Admin role." So the reaction window is conditional on one key choosing not to skip it —
  and that key is one of the six single-signer accounts above. Also route (a): disclosed beside the
  window, never silently folded into it, because "a window exists" and "the window is
  unconditional" are different claims and only the first is true.

**Why route (a) and not the other two, for both,** as Gate 2 requires be argued rather than
asserted. Route (b) — a precondition that leaves the protocol unscored — would refuse to score
**every** Aquarius market over two facts that are the same for all 340 of them and that neither
changes nor discriminates: nothing would ever be published, and a reader would learn less, not
more. Route (c) — live ungraded state — is for readings that **change** between cycles, and neither
does: `ADMIN_ACTIONS_DELAY` is a compile-time constant in code we cannot read, and the Emergency
Admin's bypass is a property of the deployed contract's authorisation logic. Both are fixed facts
about an unreadable quantity, which is exactly the shape route (a) exists for.

#### 2. `assetControlSafety` — can a third party freeze or seize what the pool holds (weight 0.45)

**Anchors:** each reserve token contract's instance `executable` (a Stellar Asset Contract's is
`contractExecutableStellarAsset`) and its `METADATA` instance entry, whose `name` is `CODE:ISSUER`
for a classic asset and the bare string `native` for XLM, then Horizon `/accounts/{issuer}` for that
issuer's `flags`.

> **Corrected from the submission, which named an `AssetInfo` storage key.** There is no such key;
> The issuer was found in `METADATA` by probing the deployed token contracts. The Gate 8 claim is
> unchanged — the issuer is read from the token contract's own instance storage, not from an
> aggregator — only the key name was wrong. The `native` counter-example gets sharper as a result:
> XLM's `METADATA.name` is the bare string `native`, which is why a SAC is detected from its
> `executable` and never from the shape of its name.

**The failure it detects, and it has no analogue in lending's five:** an Aquarius pool can be
created permissionlessly against any token. If that token is a Stellar Asset Contract whose issuer
has `auth_revocable` or `auth_clawback_enabled` set, **the issuer can freeze or seize the pool's own
balance** — and an LP's exit stops depending on Aquarius's code at all. No amount of depth and no
admin posture protects against it. Aquarius's auditor named this too: Certora **M-02, "Lack of scam
protection for AMM Users."**

Readable, with real variance. Of **205** distinct tokens across the 340 pools, **196 are Stellar
Asset Contracts** (`executable = contractExecutableStellarAsset`, issuer parsed out of `METADATA`)
and 9 are wasm contracts. Sampled issuer flags, 2026-08-27:

- **`USDC:GA5ZSEJY…`** (Circle, `home_domain = circle.com`) — **`auth_revocable: true`**. Same for
  **`EURC:GDHU6WRG…`**.
- **`LSP:GAB7STHV…`** — `auth_immutable: true`, the strongest reading available: the flags can never
  change.
- AQUA, yXLM, USDx, EURx, BLND, SSLX, WHLAQUA, XRF — all four flags false.
- And a **second asset also called `USDC`**, issuer `GCBYVQH3…`, `home_domain = mirrasets.com`,
  sitting in the same registry as Circle's. That is Certora M-02 in the live data, not in theory.

**Formula — a per-token tier on the issuer's flags, minimised over the pool's reserves:**

```
Per reserve token:
    100   a SAC with no issuer account at all — native XLM
    100   auth_immutable set, with auth_revocable AND auth_clawback_enabled both clear
     70   auth_revocable and auth_clawback_enabled both clear, auth_immutable not set
     40   auth_revocable set, auth_clawback_enabled clear
      0   auth_clawback_enabled set
      0   the token IS a SAC and the Horizon read for its issuer failed
      -   not a SAC: excluded from the computation, route-(a) disclosure (see below)

assetControlSafety = min(tokenScore) over the graded tokens
                     0 when no token is gradable
```

**The order the tiers are tested in is load-bearing.** Clawback is tested before revocable, and both
before immutable, because `auth_immutable` freezes whatever the flags currently _are_ — it is a
credit only when what it freezes is clean. An issuer that is both immutable and revocable has made
its freeze power permanent and scores **40**, not 100. Testing immutability first would invert that.

**`auth_required` moves no number, deliberately.** It gates who may _acquire_ the asset; it does not
let an issuer touch a balance that already exists. The power to freeze one is `auth_revocable` and
the power to take it is `auth_clawback_enabled`. `auth_required` is read and published in the
factor's `detail` string, because it describes the asset a reader is looking at, and it is not graded
because it does not answer this factor's question.

**Why these numbers.** The **ordering is anchored** to what Stellar's account flags let an issuer do,
which is a protocol-level fact and not a Stenion preference: seizure (`auth_clawback_enabled`)
strictly dominates freezing (`auth_revocable`), which strictly dominates an issuer holding neither,
which is in turn a weaker statement than an issuer that can never acquire either — and weakest of
all against an asset with no issuer account for anyone to act from. The **spacing** — the `40` and
the `70` — is an unvalidated judgment call, labelled in
[Unvalidated judgment calls](#unvalidated-judgment-calls).

**Why 70 and not 100 for an issuer whose flags are clean.** Because `auth_revocable` is one
`SET_OPTIONS` away for any issuer that has not set `auth_immutable`, so "clean today" is a strictly
weaker statement than "cannot become dirty". That distinction is the whole reason the second asset
also called `USDC` (`GCBYVQH3…`, `home_domain = mirrasets.com`) is worth publishing about: its flags
read exactly like a well-run issuer's, and in both cases the reading is one transaction from
changing. Scoring it 100 would publish the reading as a guarantee.

**The 9 wasm tokens have no issuer-flag equivalent** (SolvBTC, xSolvBTC, BnUSD, XAUM, and wasm
USDC/USDT variants). They take Gate 2 **route (a)**: a `value: null` disclosure component naming the
token and saying the read does not apply. Not a silent pass, and not a silent 0.

**Why not the other two routes,** as Gate 2 requires be argued rather than asserted: route (b) —
leaving the protocol unscored — would drop every pool containing any of nine tokens over a signal
that is **absent** rather than broken, which is far stronger than the finding warrants. Route (c) —
live ungraded state — is for state that _changes_, and "this token is not a SAC" is a fixed property
of the contract's executable, not a reading that can flip between cycles.

#### Cannot-assess, stated per factor — and what is a failed run instead

Gate 2 requires every "cannot assess" branch to resolve to the **unsafe** end of the scale. That is
one sentence in the checklist, and it needs an answer per factor rather than one example standing in
for the set — so both factors state their own below, and neither inherits the other's by implication.

**The rule, stated once and applied to both: a partial or unreadable input scores 0, never a skip
and never a pass.** Where a read leaves any part of a factor's input unavailable — a call that
reverts, a response shorter than expected, a lookup that fails for one subject — the factor resolves
to **0**, the unsafe end. It is never omitted from the factor map, never defaulted to a neutral
middle, and never allowed to score well because there was less to check. This is ground rule 4, and
lending's `2026-08-16` correction is the precedent: two factors there returned **100** from an empty
filtered set, which published "maximally safe" from no data, and both were changed to return 0.

**One boundary, and it is the difference between publishing a 0 and publishing nothing.** A
whole-endpoint outage — Soroban RPC unreachable, Horizon down, nothing decodes — makes the adapter
**throw**, and the indexer records a failed run and publishes no score for that cycle (CLAUDE.md's
error-handling rule; error handling lives in the indexer, never per adapter). That is not a
cannot-assess branch and must not be graded 0, or a blip in our own network path would publish
"dangerous admin control" across every pool at once. Everything **localized** — one call, one role,
one issuer — is a cannot-assess branch and takes the 0.

**"Localized" is not a count of failed reads; it is a claim about what the failure is a statement
about.** The two words that separate the branches are _the subject answered_. A read whose subject
answered — an issuer account Horizon says is not there, a contract that reverted — produced a fact
about the pool, and a fact about the pool is what a factor is for. A read that never reached an
answer — the endpoint refused us for rate, the connection dropped, Horizon returned a `5xx` about
itself — produced a fact about **Stenion's read path on that cycle**, and no such fact may move a
protocol's number. Both used to be called "the lookup failed"; they are opposite claims, and the one
that is not about the protocol fails the run. The argument, the options weighed against it, and what
it does and does not change are in
[A rate limit is not a reading](#a-rate-limit-is-not-a-reading) below.

| Factor               | Cannot-assess branch                                                                                                                                   | Resolves to                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `adminKeySafety`     | `get_privileged_addrs()` **reverts**; returns fewer than the seven roles; a role is ungradable; the contract carries no `UpgradeDeadline` entry at all | **0**                                                                     |
| `assetControlSafety` | Horizon **answers** about a SAC issuer and the answer is not a gradable account; no reserve token is readable at all                                   | **0**                                                                     |
| _(either factor)_    | The endpoint never answered: a rate limit we could not wait out, a dropped connection, a `5xx`                                                         | **Not a branch** — a **failed run**, and no score published for the cycle |
| _(disclosures)_      | Timelock duration; Emergency Admin bypass; the 9 non-SAC wasm tokens                                                                                   | **Not a branch** — route-(a) `value: null`, moves the number neither way  |

**`adminKeySafety`.** Three ways the input can be incomplete, all resolving to **0**:

- **`get_privileged_addrs()` reverts** on the router or on the pool. The whole role structure is the
  factor's input, so a revert leaves nothing to grade. **0**, not a skipped factor — "we could not
  read who controls this pool" is a statement about the pool, and the unsafe end is the only honest
  place for it.
- **It returns fewer than the seven expected roles.** Seven were present across the router and all
  340 pools on 2026-08-27 (`Admin`, `EmergencyAdmin`, `EmergencyPauseAdmin`, `PauseAdmin`,
  `OperationsAdmin`, `RewardsAdmin`, `SystemFeeAdmin`). A short map means either an unexpected
  contract version or a role we cannot see, and grading the roles that _did_ come back would publish
  a posture assessment of an admin set we know is incomplete. **0.**
- **A role reads but cannot be graded** — its address is not a classic `G…` account, so there is no
  signer set, threshold or activity history behind it. **0.**
- **The contract carries no `UpgradeDeadline` entry at all** — the raw shape records this as
  `deadline: null`, which is a different statement from `0n` and must not be collapsed into it: one
  says the contract answered "nothing pending", the other says this contract does not keep the field
  the upgrade component reads. Both the router and pools of all three types carried it on
  2026-08-29, so its absence would mean an unexpected contract version, and half this factor's input
  would be missing. **0**, on the same reasoning as a short role map.

> That third case argues with an existing precedent, and the resolution is recorded rather than
> assumed. Lending's `adminKeySafety` sends its equivalent to a clearly-flagged neutral **60**, on
> the reasoning that a contract-held admin is a different structure rather than evidence of danger.
> **`dex` does not inherit that baseline**: lending's 60 is anchored to a contract admin being a
> _known, named_ structure whose properties we chose not to grade, whereas an Aquarius role that is
> not a classic account is a structure we did not expect and cannot describe. A neutral score for an
> unexpected reading is an invented number, which ground rule 4 forbids. All seven roles were
> classic accounts on 2026-08-27, so this branch is unexercised today.

**`assetControlSafety`.** Two cases, and the distinction between them is the whole point:

- **Horizon answers about a SAC issuer's `/accounts/{issuer}` and the answer is not a gradable
  account** — a `404`, most plainly. The token _is_ a SAC, so its issuer flags are exactly the thing
  this factor grades, and Horizon has told us there is nothing there to grade. **0** for that token,
  which then binds the factor on the usual worst-reserve convention. This is **not** the same as the
  9 non-SAC tokens and must not be routed like them: there, the read genuinely does not apply; here,
  it applies and failed. Treating a failed read as "does not apply" would silently upgrade an
  unknown into an exemption, which is the single most dangerous confusion available in this factor.
  It is equally **not** the same as a read that never reached an answer — see
  [A rate limit is not a reading](#a-rate-limit-is-not-a-reading).
- **No reserve token is readable at all** — every reserve is a wasm contract, so every token takes
  the route-(a) disclosure and nothing is left to grade. A minimum over an empty set is **0**, not 100. Same shape as lending's `2026-08-16` correction, written down before the adapter exists
  rather than after it publishes a 100.

The 9 non-SAC wasm tokens remain what they were: a route-(a) `value: null` disclosure naming the
token and saying the read does not apply. A disclosure is not a zero and not a pass — the token is
excluded from the computation, not graded badly by it.

#### A rate limit is not a reading

**The question.** Aquarius is the first adapter that scores through a failed read instead of
throwing on it, and the 429-backoff work made the consequence concrete: when Horizon refuses us for
rate and the attempt's retry budget is spent, the refusal arrived at scoring as a **0 with a reason
string**, indistinguishable at the factor level from "this issuer's flags could not be read." Those
are different claims. One is about the pool. The other is about Stenion's infrastructure at the
moment of the read, and it was moving a published number.

**The decision: a rate-limit exhaustion, and every other failure that never reached an answer, is a
failed run — not a scored 0.** Nothing about the two formulas, the tier values, the weights or the
worst-reserve convention changes. What changes is which failures are allowed to reach them.

**The rule, in the form the code applies it.** A read is a reading **only when its subject
answered**, and each transport is asked that question in its own vocabulary:

| Transport   | An answer about the subject — **captured, scores**                   | Everything else — **fails the run**                               |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Horizon     | an HTTP status that is about the account: `404`, and any other `4xx` | a `429`, any `5xx`, a rejected `fetch`, a body that did not parse |
| Soroban RPC | a simulation error — the contract itself refusing                    | a rate limit, a dropped connection, an SDK decode failure         |

The classification lives in [`../adapters/read-failure.ts`](../adapters/read-failure.ts), not in
each call site, and it is tested there and in `adapters/aquarius/fetch.test.ts` against a loopback
Horizon answering `404`, `503`, `429` and nothing at all.

**Why, in three facts rather than a preference.**

1. **A 429 carries no information about the protocol.** Every one of Aquarius's 340 pools is
   equally rate-limitable, on a schedule set by our own request train against a free shared
   endpoint. A number that moves with it is reporting Stenion's cycle, and the registry has no
   column for that.
2. **It is not localized, which is the word the boundary above turns on.** The retry budget is
   **per attempt** and shared by every call the attempt makes ([`../core/src/rate-limit.ts`](../core/src/rate-limit.ts)):
   once it is spent, the next refused read gets no retries at all. So one exhaustion silences the
   reads after it, `adminKeySafety` and `assetControlSafety` both resolve to 0, and the pool
   publishes an overall **0** — "dangerous admin control", from an endpoint that was busy. That is
   precisely the outcome the whole-endpoint boundary exists to forbid, arriving one pool at a time
   instead of all at once.
3. **The honest publication already exists and costs nothing to reach.** A throw runs the
   indexer's own target retry with a **fresh** budget, up to `STENION_RETRY_ATTEMPTS` times; only if
   every attempt is refused does the cycle record a failed run, flagged `rateLimited` and carrying
   the 429s in `risk_scores.error`. The previous score stands with its staleness advancing, which
   says the true thing: we did not learn anything about this protocol this cycle.

**The options that were weighed, and why each was not taken.**

| Option                                                                                     | Why not                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep the scored 0.** Gate 2 resolves uncertainty to the unsafe end and does not ask why. | Gate 2 governs a cannot-assess branch, and a cannot-assess branch is a reading. The rule it appeals to is [ground rule 4](index.md) — never publish a number no data supports — and a 0 sourced from our own request rate is that number, not an application of it.                                                                          |
| **Carry the prior cycle's sub-reading forward and retry next cycle.**                      | `risk_scores` stores outputs, never the raw inputs a run was computed from, so there is nothing to carry: this needs a new persistence layer for per-sub-value state, and a score assembled from two cycles' readings is a fourth publication route nobody has argued for. Flagged as a separate design question, not forced into this pass. |
| **Keep the 0 and disclose it in `detail`, plus a dashboard treatment.**                    | It fixes the ambiguity for a reader who opens the factor and not for the ranking, which is where the damage is: the pool sits last in the `dex` block with a footnote. Disclosure is the right response to something we chose not to grade; this is something we never measured.                                                             |
| **Throw on a 429 only, leaving the other never-answered failures scoring 0.**              | A dropped connection and a Horizon `5xx` are the same claim about the same thing and were scoring 0 too — "Horizon down" was publishing a risk finding, against the boundary this document already wrote. Fixing the named case and leaving its siblings would have made the rule a special case instead of a rule.                          |

**What this deliberately does NOT do.** Aquarius still scores through every failure that is a
statement about the pool: a reverting `get_privileged_addrs()`, a short role map, an ungradable
role, an issuer account Horizon says is not there. The score-through-failure design is intact — it
was never a design to score through _our own_ failures. Soroban RPC's 429 handling is unchanged;
what changed is that Aquarius no longer swallows the `RateLimitExhaustedError` that handling
produces. Lending needed none of this and is untouched: Blend and Kinetic throw on every failed
read, so no fact about our read path could reach one of their numbers in the first place.

**No version bump, deliberately.** Per
[What bumps the version](index.md#what-bumps-the-version-going-forward), a fix that makes the
implementation match the rule already documented here does not bump — the affected stored scores
were wrong under this rulebook, not scored under a different one. No formula, threshold, weight or
tier moves, and a `dex` score computed from readings is byte-identical before and after. What
changes is that some cycles now publish no number where they previously published a wrong one, and
`risk_scores.methodology_version` was never the field that distinguished those.

**Every branch above is implemented and tested, and the adapter may not reinterpret it.**
The rules were written before the code, which is the order [`../TAXONOMY.md`](../TAXONOMY.md)
requires; `adapters/aquarius/score.test.ts` now asserts each one individually, including the four
that no live pool can reach — a reverting `get_privileged_addrs()`, a short role map, a
contract-held role, and a pool whose every reserve is a wasm contract. All of them return **0**,
each with a `detail` naming what could not be assessed.

**And so is the line above them.** `adapters/read-failure.ts` decides, once, which failures are
allowed to become one of those branches at all; `adapters/read-failure.test.ts` pins the
classification and `adapters/aquarius/fetch.test.ts` drives the two Horizon readers against a
loopback endpoint answering `404` (captured as the reading), `503`, a refused connection and a
persistent `429` (all three a failed run, the last still recognisable downstream as a rate limit).
None of the four can be produced from live data on demand, which is why they are pinned rather than
left to be discovered on the cycle they first happen.

### Size floor: none, and none pending

**There is no size floor in this rulebook, and there is no unwritten one waiting to be added.**
Gate 4 asks for a size below which a published number stops carrying information. For the two
factors that ship, no such size exists — and that is a property of what they measure, not a gap left
open:

- **[`adminKeySafety`](#1-adminkeysafety--seven-roles-and-how-long-you-get-to-react-to-a-code-change-weight-055) reads the same seven roles whatever the pool holds.** A pool with 3
  stroops in it has the same `Admin`, the same six single-signer keys, the same `UpgradeDeadline` and
  the same Horizon signer sets as one holding 10,000 XLM. Every input is a property of the contract
  and of the accounts that control it; not one of them is a quantity of anything.
- **[`assetControlSafety`](#2-assetcontrolsafety--can-a-third-party-freeze-or-seize-what-the-pool-holds-weight-045) reads the same issuers.** Whether Circle can freeze the pool's USDC
  does not depend on how much USDC is in it. A dust pool holding a clawback-enabled asset is exactly
  as exposed as a deep one.

**Nothing here degrades as a market gets smaller, so there is nothing for a floor to protect.**
Lending needs one for the opposite reason, spelled out in
[the market-size floor](lending.md#the-market-size-floor): every one of its five factors falls to a
can't-assess branch on an empty market and every one of those branches is `0`, so an empty market
would publish a danger-band number meaning the opposite of the truth. Neither dex factor has that
failure mode — an empty pool's roles and issuers still read, and the number they produce is still
true of it.

**This is a consequence of [question A](#question-a--resolved-no-depth-factor-until-there-is-a-unit-of-value)'s resolution, not an open item**, and the distinction is
the whole point. The census that would motivate a floor is real and dated — of the 148 XLM-paired
pools on 2026-08-27, **18 held zero XLM and 59 held under 1 XLM**, many of them 1–3 stroops, while
only 16 held more than 10,000 — but a floor is needed by a **size-sensitive factor**, and the one
that would have been size-sensitive (`depthSafety`) is deferred. **A floor becomes necessary again
the moment `depthSafety` lands**, which is the same moment the unit of value to express one in would
exist. Writing one before then would mean choosing a denomination for a factor that does not exist,
in a category with no unit of value — the permanent, one-protocol decision question A declined to
make.

**No number is copied from lending's market-size floor or its minimum-size filter, and none may be.**
Those are denominated in USD against a lending pool's supplied value, which is a quantity this
category cannot compute.

**What this does not claim, and where an under-sized market goes.** It does not claim a 3-stroop pool
is worth anyone's attention — it claims that the two numbers this rulebook publishes about one are
as true of it as they are of a deep pool, which is a statement about the factors and not about the
market. Nothing is excluded for size, so no pool needs a coverage entry on those grounds. Which
pools are **registered** is a separate reviewed decision about what is worth publishing, and
never a statement that an unregistered pool could not be scored.

---

### Unvalidated judgment calls

[`../TAXONOMY.md`](../TAXONOMY.md) Gate 1 requires every threshold in a rulebook to either name the
on-chain field it anchors to or be labelled an **unvalidated judgment call**, in **both** the code
and `methodology/`, with its reasoning and its direction of error stated. **This is the complete list
for `dex` v1.** Every other number in either formula names a field or is itself a reading; where one
is adopted from lending rather than chosen here, that is said below rather than left to be noticed.

| Constant                                      | What it is                                             | Direction of error, in one line                                                                            |
| --------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| the two weights, `0.55` / `0.45`              | each factor's share of the overall score               | under-weights issuer control if wrong; the gap is deliberately small because the ordering is the claim     |
| combining the seven roles by `min`            | how seven separately-read roles become one number      | understates safety, never overstates it — a weak minor role binds as hard as a weak `Admin`                |
| the pending-upgrade ceiling, `40`             | what a scheduled code change does to the number        | too harsh for a routine announced upgrade, far too lenient for a hostile one                               |
| the asset-control tier spacing, `40` and `70` | how far apart freeze-capable and clean-but-mutable sit | `40` leans lenient, `70` conservative — and `min` makes the lenient end bind, so this one reads generously |

**The two weights, `0.55` / `0.45`.** Argued at length in [Factor weights](#factor-weights) and
labelled in [`../core/src/weights.ts`](../core/src/weights.ts). No external framework anchors them.
If the split is wrong it is wrong by under-weighting issuer control, and a reader who holds that
unmitigable-and-unannounced should dominate would push toward 0.45 / 0.55. The gap is 0.10 rather
than lending's spread because the two arguments nearly cancel: `adminKeySafety` reaches more of the
pool, `assetControlSafety` reaches it with no warning and no remedy.

**Combining the seven roles by `min`.** Every one of the seven can act unilaterally within its own
scope, so an attacker takes whichever key is weakest and the weakest is what the number should
report. The cost is that `min` treats the seven as equally consequential, which they are not — a
`SystemFeeAdmin` compromise is not an `Admin` compromise — so a pool whose only weak key is a minor
one is graded as though the code-upgrade key were weak. **It therefore understates safety and never
overstates it**, which is the direction ground rule 4 requires a judgment call to lean. Two
alternatives were considered:

- **Weighting the roles by how much each can do.** It would fix the objection exactly, and it needs
  **seven** Stenion-chosen numbers where `min` needs none — turning a four-row type-(b) list into a
  ten-row one, which by TAXONOMY.md's own framing would itself be the finding.
- **Grading the owner key alone.** Rejected outright. Aquarius's `Admin` is a 2-of-3 multisig, so
  this would publish a comfortable number while ignoring six live single-signer keys that can pause
  the market, move fees and set rewards. It is the alternative that most looks like a simplification
  and is in fact a decision to stop reading six of the seven readings.

**The pending-upgrade ceiling, `40`.** It introduces no integer this document did not already
publish — it is the single-master-key tier, reused on the reasoning that a scheduled code change
leaves the LP holding a countdown of unreadable length rather than a signer structure. Direction of
error, both ways: it is **too harsh** for a routine, correctly-announced upgrade, because it lowers
the number of a protocol for using the very two-step mechanism this factor credits it for; and it is
**far too lenient** if the staged code is hostile, in which case no score would be adequate. It
leans conservative, and it is **unexercised today** — `UpgradeDeadline` read `0` on the router and on
pools of all three types on 2026-08-29. The alternative was to leave the pending state ungraded and
publish it as a disclosure; that was declined because the reaction window is the failure mode this
factor's [Gate 0 argument](#gate-0-re-argued-for-two-factors) rests on being able to see, and a
factor that discloses it is a role-posture factor with a footnote.

**The asset-control tier spacing, `40` and `70`.** Only the two interior values are chosen; the
ordering around them is anchored to what Stellar's flags let an issuer do.

**Direction of error, and it is the one entry in this list that is not symmetric.** `40` for
freeze-capable **leans lenient**: to an LP, a freeze that is never lifted is indistinguishable from
a seizure, and `40` asserts the two differ. `70` for clean-but-mutable **leans conservative**: it
refuses to call a mutable issuer as safe as an asset with no issuer, and so understates a
long-standing issuer that has never set a flag and never will. Those pull opposite ways, and **the
lenient end is the one that binds**, because the factor is a minimum over the pool's tokens: any
pool holding a freeze-capable asset is scored by the `40` and the `70` never enters the number at
all. So the net lean of this constant is toward **reading generously** — the opposite of the
role-combination rule two entries above, which understates safety and never overstates it, and the
same direction as the weights' possible under-weighting of issuer control. **Those two
compound**, and on exactly one shape of pool: one whose only weakness is a freeze-capable issuer is
graded by the lenient tier _and_ has that tier's factor weighted at the lighter of the two. That
pool is where a published `dex` number is most likely to be too high, and it is the first thing to
challenge if one looks generous.

Moving the two values together makes the factor a pass/fail on clawback alone; moving them apart
makes it nearly binary on any flag at all.

**Adopted from lending rather than chosen here, and labelled there:** the per-account tier values
(`90` for an N-of-M multisig, `40` for a single master key) and the activity penalty (`−3` per
operation, capped at `−30`), from
[lending §3](lending.md#3-adminkeysafety--admin-signer-structure--activity-weight-020). They are the
same integers applied to the same Horizon reading, and that section carries their label, their
reasoning and their direction of error. They are named here so a reviewer counting this rulebook's
constants finds them, and they are **not re-argued here**, because a second argument for the same
integers is how two rulebooks start. Changing them on one side and not the other is a decision to
fork them and needs its own argument — it is not an edit to one file.

**Four rows, where the weight-table review was expected to bring two — and the growth is stated rather than smoothed
over,** because TAXONOMY.md's rule is that a long type-(b) list is itself the finding. This one is
not long, and both additions are accounted for: that prediction was written when this rulebook had
**no formulas at all**, only anchors, and the two new rows are precisely the two places a formula had
to say something the chain does not state — how seven separately-read roles become one number, and
what a scheduled code change does to it. Neither is a preference standing in for a measurement, and
neither introduces an integer published nowhere else. On the other side the list **shrank**: that
same prediction included rows for `depthSafety`'s probe size, its impact-to-score mapping, and the size floor,
and all three are gone because the factor and the floor are gone with them.

> **Three of the four are labelled by the adapter's scoring code, not by this document.** The
> weights live in `CATEGORY_FACTORS.dex` and carry their label there. The other three are constants
> in `adapters/aquarius/score.ts`, which labels each one beside the branch that applies it — the
> per-account tiers adopted from lending by reference, the reused `40` in the open-upgrade-window
> branch, and the `40`/`70` asset-control tiers. Gate 1's "in **both** the code and `methodology/`"
> is therefore discharged for all four. Recorded here so the obligation stays attached to the
> rulebook rather than remembered.

---

### Live ungraded state — route (c), published beside the score, never in it

Aquarius's pause surface is real, changing, on-chain and ungradable: exactly the shape
`operationalState` exists for ([Operational state](publishing-rules.md#operational-state-is-published-never-scored)).
Every pool exports `get_is_killed_swap()`, `get_is_killed_deposit()`, `get_is_killed_claim()` and
`get_emergency_mode()`; the router exports `get_emergency_mode()`.

**Read on 2026-08-27:** router emergency mode `false`; **two stable pools have
`is_killed_deposit = true`** — `CDKVJYMN34ZIEXSLNFYHVAFF6M6FM5E2U6OHXOTBKH2WLBULXOE53YDP` (XLM/AQUA,
zero reserves) and `CBKENQ33KITYE4JKPAWALHU4KGWV5AXQLJFUNRNIDGCRLRDENX6PYVDE`
(AQUA/`CCKCKCPH…`) — everything else false, no pool in emergency mode. The field has live variance
on day one, which is what makes it worth publishing rather than a field that is always the same word.

**The structural finding, and the strongest single fact about an Aquarius LP's exit risk: there is
no `kill_withdraw`.** The exported function list of all three pool wasms contains `kill_swap`,
`kill_deposit`, `kill_claim`, `kill_gauges_claim` and their `unkill_` counterparts — **and no
withdraw equivalent**. Withdrawals cannot be halted by any Aquarius role. That is the same class of
fact as "Blend never blocks withdrawals at any status," established the same way: it is a property
of the deployed code, not a promise.

**Read the state through the getters, never through instance storage.** The three pool types
disagree about key names — `standard` writes `IsKilledClaim`, `concentrated` writes
`ClaimKilled`/`IsKilledSwap`/`EmergencyMode` — and a flag that has never been toggled has **no key
at all**. The getters normalise all of it; raw storage would make an untouched pool
indistinguishable from one that was read wrongly.

#### The `swapDisabled` rung, and why the shared ladder gained one

`dex` registers its own operation vocabulary — `{ swap, deposit, withdraw, claim }` — and its own
canonical ordering and classifier in
[`../core/src/operational-state.ts`](../core/src/operational-state.ts), beside lending's. **No
lending operation was renamed, added or removed**; renaming one would rewrite `blocked` in every
stored `operational_state` and every API response.

`OperationalLevel` stayed **one shared ladder**, and gained a rung rather than forking — an open
question when the category was admitted, recorded here so it is not re-litigated:

> A pool with `is_killed_swap = true` but deposits and withdrawals live would have classified as
> `active` under the ladder as it stood — true about exit, and **wrong about the market**.
> `blocked: ['swap']` carried the fact, but `level` is the field a reader scans, and a dead market
> reading "active" is the quiet misstatement the whole type exists to prevent. So the ladder gained
> **`swapDisabled`**: cannot trade; depositing and withdrawing both work.
>
> **Why not generalize `borrowingDisabled` into one shared `coreActivityDisabled` instead**, which
> would have been the more honest name for both: `borrowingDisabled` is a value stored in every
> historical `operational_state` and published on the public API, so renaming it is a breaking
> change to stored data and to the API contract, inside a change whose entire purpose was to add a
> category. Two named rungs and an accurate `level` beat one elegant rung and a migration nobody
> asked for. The two sit at **equal severity** and can never meet, since `blocked` carries one
> category's vocabulary.

`exitDisabled` is **unreachable from Aquarius** — there is no `kill_withdraw` — and the rung stays,
because it is the top of the ladder every category is measured against and a second DEX that _can_
freeze withdrawals must have somewhere to say so. `claim` gets no rung at all: an LP whose reward
claim is killed can still withdraw every unit of principal. It stays in `blocked` because it is
true, on the same reasoning lending gives for `repay` and `liquidate`.

### What was rejected, and why it must not be re-proposed

Gate 3. Every candidate that was considered and dropped, by name, with its reason — and with the
measurement where one was taken.

#### `liquidity_calculator.get_liquidity()` as a size or depth measure

Aquarius ships its own cross-pool liquidity metric (`CCUKQWLM…`, `get_liquidity(pools) -> Vec`),
used to allocate AQUA rewards. It is the obvious thing to reach for, it is on-chain, and it clears
Gate 8 — and it is **not comparable in any economic sense**. The evidence is a single pool: on
2026-08-27, `CBMSBM6EABGBNZ47WZTLX6WJOB3ETO2GNPQYC2FX6LJXUL7TRQFZ3IA3` — a standard XLM/DATAVAULT
pool holding **32,733 stroops, i.e. 0.0032733 XLM**, roughly a third of a US cent — ranked **4th of
all 340 pools** by this metric. It is dominated by raw token quantities, so a pool paired against a
huge-supply token outranks the XLM/USDC book. Fails Gate 1 (no economic anchor), and would make any
Gate 4 floor built on it meaningless.

#### LP concentration

Named in [`../ROADMAP.md`](../ROADMAP.md) as a DEX candidate. **Fails Gate 8 outright.** The LP
share token is a plain SEP-41 contract (`CAVKLYY4…` for the XLM/USDC standard pool, wasm
`07bab30e…`); its complete exported interface is
`balance / transfer / transfer_from / approve / allowance / mint / burn / burn_from / decimals / name / symbol / upgrade`
— **there is no holder enumeration and no holder count**. Recovering the distribution needs an
indexer over `transfer` events, which is the off-chain data path Gate 8 disqualifies however
well-anchored everything else is. Concentrated-liquidity positions are worse: keyed by
`(owner, tick_lower, tick_upper)` through `get_position(...)`, with no way to enumerate owners at
all.

#### Price divergence from a reference market

Also named in [`../ROADMAP.md`](../ROADMAP.md). Rejected on the reasoning `ROADMAP.md` already
records for market-depth-aware oracle scoring: an AMM's price **legitimately** differs from SDEX by
up to the fee plus whatever arbitrage has not run yet, so a divergence reading cannot separate a
real problem from a normal one. Horizon order books are also trivially spoofed with walls that are
never hit. A cross-pool reference is worse still — it is another market standing in for the one
being scored, which is the substitution Gate 8 exists to refuse.

#### `liquidity_pool_plane` as a source for any scored input

The plane (`CCABO2IQ…`, `get(pools) -> Vec`) returns type, init args and reserves for many pools in
one call, and is tempting as the bulk read. It is a **cache written by the pools**
(`update(pool, pool_type, init_args, reserves)`, with `ReservesSyncLedger` recorded on the pool), so
it can lag the pool it describes. **Acceptable for discovery; the pool contract is the source for
anything that reaches a number.**

#### Fee tier as a factor

`get_fee_fraction()` varies genuinely — `standard` pools use only 10/30/100 bps, but `stable` pools
were found at 1, 5, 10, 15, 22, 25, 30 and 50 bps. A higher fee is **worse execution, not a failure
mode**; grading it would dress a pricing preference as a risk measurement. It belongs inside
`depthSafety`'s round-trip cost, where it already is, and nowhere else.

#### Reserve imbalance against the pool's target ratio

Real for a `stable` pool, where drift from 1:1 is a genuine de-peg signal — and **meaningless for
`standard`**, where imbalance _is_ the price. A factor only 42 of 340 markets can be graded on is a
per-market rulebook, which ground rule 1 forbids.

#### Aquarius's own AMM API (`amm-api.aqua.network`)

Published in their documentation, and it would answer several of the questions above directly.
**Gate 8.** No further discussion.

#### Concentrated-liquidity-specific factors

Tick distribution and active-liquidity fraction are readable — `get_active_liquidity()`,
`get_slot0()`, `get_tick()`, `get_chunk_bitmap_batch()` — and genuinely interesting. **26 of 340
pools have them.** A factor only those pools can be graded on is a per-market rulebook, same as
reserve imbalance. Revisit only if concentrated pools become the majority of pools.

### Question A — resolved: no depth factor until there is a unit of value

**Decision: option 4.** `dex` ships with two factors, `adminKeySafety` and `assetControlSafety`.
There is **no `depthSafety`, no size floor and no denomination logic**, and none may be added
without a further published decision. The problem this resolves, and the three options declined, are
recorded below so none of it is re-proposed from scratch.

**It was decided on reversibility, which is the argument that outranked the others.** Adding a
factor to a live category later is **additive**: it lands as a labelled version bump, old scores
stay readable as what they were, and the discontinuity is published rather than hidden. Walking back
a published depth denomination is not symmetric — it would mean revising what stored scores meant,
and this project's own rule is that history is **never backfilled across a bump** and _cannot_ be,
since `risk_scores` keeps only outputs and no row can be recomputed. So the two directions carry
very different costs: shipping without depth is a gap that can be closed, while shipping the wrong
depth denomination is a mistake that cannot be undone. Under that asymmetry the thin category wins.

**Gate 4 is satisfied by not needing a floor, rather than by having one — and this is a
consequence of the decision, not a dodge.** Lending's floor exists because an empty market publishes
**0** in the danger band, meaning the opposite of the truth. Neither surviving factor is
size-sensitive: a pool holding 3 stroops has exactly the same seven admin roles and exactly the same
token issuers as one holding 10,000 XLM, and both readings are equally true of it. There is no
quantity here that stops carrying information as a pool gets smaller, so there is nothing for a
floor to protect. **A floor becomes necessary again the moment `depthSafety` lands**, which is the
same moment the unit of value to express it in would exist.

The problem itself, unchanged, because it is what any future attempt has to solve:

Aquarius reads no oracle, so **nothing in its own contracts values a pool.** Two consequences:

- **This category's size floor has no denomination.** A floor is badly needed: of the 148
  XLM-paired pools, **18 hold zero XLM and 59 hold under 1 XLM** (many hold 1–3 stroops); only 16
  hold more than 10,000 XLM. Over half the registry would otherwise publish a number computed from
  dust. But "below what?" has no answer in Aquarius's own terms.
- **`depthSafety` is degenerate for 272 of 340 pools if the trade is sized relative to the pool.**
  For a constant-product pool, the price impact of swapping a fixed _fraction_ of the input reserve
  is a closed form that **does not contain the reserves** — so every `standard` pool at the same fee
  tier scores identically and the factor collapses into the fee tier it was told not to grade. It
  would discriminate only among `stable` (amplification) and `concentrated` (tick distribution)
  pools. An **absolute** trade size fixes this, and needs the unit that does not exist.

**No number in this document is copied from lending's market-size floor or its minimum-size
filter,** and none may be: those are denominated in USD against a lending pool's supplied value,
which is a quantity this category cannot compute.

The options, with gate verdicts. **None is adopted here:**

| #   | Option                                                                                                                                                                                                                                             | Verdict                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Denominate in XLM, pool-relative.** 148 of 340 pools contain XLM directly, so no price is needed for those.                                                                                                                                      | Clears Gate 8. Leaves **192 pools unscorable** and needs a coverage status for them.                                                                                                                                                          |
| 2   | **Derive prices from Aquarius's own reserve ratios along an XLM-paired path.**                                                                                                                                                                     | Clears Gate 8 on the letter. Almost certainly **fails Gates 1 and 2**: a price computed by Stenion from a manipulable pool is a fabricated anchor — precisely what lending's rejected "Stenion-computed deviation" candidate already refused. |
| 3   | **Anchor to Aquarius's own declared cost of existence** — `get_standard_pool_payment_amount() = 300,000 AQUA`, the price the protocol itself charges to create a pool, and the closest structural analogue to Blend's `PoolConfig.min_collateral`. | Clears Gate 1 as a type-(a) anchor. Still needs option 1 or 2 to compare a pool's reserves against it.                                                                                                                                        |
| 4   | **Score no depth factor at all**; publish depth as a route-(a) disclosure and admit `dex` on `adminKeySafety` + `assetControlSafety`.                                                                                                              | Honest, but a two-factor category is thin enough that **Gate 0 should be re-argued** before accepting it.                                                                                                                                     |

#### Why option 2 was rejected, even though it is fully on-chain

Deriving prices from Aquarius's own reserve ratios along an XLM-paired path clears Gate 8 on the
letter — every read is Soroban RPC against the protocol's own contracts, with no aggregator and no
off-chain source anywhere. It is rejected anyway, and the reason is worth stating precisely because
"it's all on-chain" is exactly what makes it tempting.

**A reserve ratio is not a price. It is spot state, and it is cheap to move.** A large one-sided
swap — or a flash loan, which needs no capital at all — skews a pool's ratio for exactly as long as
it takes us to read it. So the "price" would be whatever an adversary wanted it to be at the instant
of the read, and the factor built on it would report a comfortable number precisely when someone was
active in the pool. **A score derived from the same system it is meant to be checking goes blind at
the only moment it matters.**

This is the same failure shape as the price-deviation candidate already rejected for lending's
`oracleSafety` (see [`index.md`](index.md) §2's rejected candidates) — a Stenion-computed figure
standing in for an anchor the protocol does not publish — and it fails two gates rather than one:

- **Gate 1**: the resulting number is not a protocol-declared anchor. It is Stenion-computed from
  mutable state, which is the definition of an unanchored threshold wearing an anchor's clothes.
- **Gate 2**: it does not fail to the unsafe end. It **fails by lying confidently** — publishing a
  plausible, precise, wrong number, which is worse than publishing nothing and much worse than
  publishing 0.

> **A TWAP-based approach is deferred, not dismissed.** Time-averaging would genuinely resist the
> single-block skew above, and the objection in this section does not defeat it. It is a materially
> different and harder design — it needs a window, an update cadence, a manipulation-cost model for
> that window, and a story for pools that trade rarely — and none of those has an anchor in
> Aquarius's contracts either. Designing it against exactly one protocol would bake Aquarius's shape
> into a category rulebook. **Revisit when a second dex protocol exists to calibrate against.**

#### Why options 1 + 3 were not taken either, despite being the submission's own lean

The original recommendation was XLM-relative sizing plus an absolute floor anchored to the 300,000
AQUA pool-creation cost. It is the strongest of the three declined options and it was still declined,
on three grounds:

- **It is not reversible the way option 4 is.** A published depth denomination becomes what stored
  scores mean. Changing it later requires revising history, which the no-backfill rule forbids — so
  the choice would be effectively permanent, made now, on one protocol's data.
- **It strands 192 of 340 pools on the category's flagship factor.** Only 148 pools contain XLM
  directly, so the rest would sit in coverage-only limbo — unscored on the very measurement the
  category was built to publish. A flagship factor that does not apply to 56% of the market is a
  weak flagship.
- **The floor does not answer the question it appears to answer.** "It cost 300,000 AQUA to create
  this pool" is a fact about the protocol's fee schedule, not about whether the pool is deep enough
  for a number computed from it to mean anything. It clears Gate 1's anchoring requirement — the
  figure really is protocol-declared — while leaving the actual depth-adequacy judgment unstated and
  ungraded underneath it. **An anchor that anchors the wrong quantity is a worse failure than an
  admitted judgment call**, because it looks anchored.

**Both are worth revisiting once a second dex protocol exists to calibrate against.** The objection
throughout is not that these ideas are bad; it is that every one of them has to be designed against a
single protocol today, and a category rulebook designed against one protocol is that protocol's
rulebook wearing a category's name.

**What holds until then:** no adapter may implement `depthSafety`; no size floor exists, and none is
needed by the two factors that ship; depth is published as a route-(a) disclosure rather than graded.

### Comparability: within `dex` yes, across categories no

Gate 5, stated in both directions, because only one of them is obvious.

**Within `dex`, two `safetyScore`s are comparable.** Every protocol scored under this rulebook is
graded by the factors above, with the same formulas and the same thresholds, under the same version
stamp — ground rule 1, which binds every adapter in a category with no exceptions. That is what
makes the ranked block a ranking rather than a list.

**Across categories they are not, and nothing may present them as if they were.** A `dex`
`safetyScore` of 70 and a `lending` `safetyScore` of 70 were produced by **different factor sets,
different formulas and different weights**, from data that has no quantity in common. Neither number
is evidence about the other; "the DEX is safer than the lending market" is not a statement either
score supports.

This is enforced, not merely stated:

- `buildRegistryView` (`dashboard/app/lib/registry-query.ts`) publishes `RankedCategoryGroup[]` and
  **no flat ranked array**, so each category is its own block numbered 01..n within itself and there
  is nowhere for a cross-category ranking to live. Name sort is the sole ordering allowed to merge
  categories, because alphabetical asserts no ranking.
- Every entry carries its `category` through to the board **and** to the API responses.
- `risk_scores.category` is stamped beside `risk_scores.methodology_version` on every run, because
  both counters start at 1 and the integer alone does not identify a rulebook.

**Sharing the `adminKeySafety` key between the two categories changes none of this.** The key names
the question; it does not claim the answers were computed the same way — and the formulas above are
the proof: lending grades one admin account's signer set, this grades seven roles' worst posture
under a pending-upgrade ceiling. See [factor 1](#1-adminkeysafety--seven-roles-and-how-long-you-get-to-react-to-a-code-change-weight-055).

### One adapter, many markets

The same rule lending already runs under, and Aquarius has the same shape as Blend: **exactly one
wasm per pool type**, each matching the hash the router itself declares —
`ConstantPoolHash` `ae0da5a8…de9852` (272/272 pools), `StableSwapPoolHash` `f1077e0b…e747cd` (42/42),
`ConcentratedPoolHash` `12fca5a7…d37ee6` (26/26). Verified against the router's own declared hashes
rather than assumed.

So a second Aquarius market is a **config entry and no new scoring code**. CLAUDE.md's "one adapter
may serve several markets; a market never gets its own adapter" applies here unchanged, and nothing
on a per-pool config may be a threshold, weight or formula — that would be a per-pool rulebook.
