## Dex

Everything from here to the end of this file is **the DEX rulebook and the DEX rulebook alone** —
its version changelog, its three factors, what it refuses to score, and the open item that still
gates it. Nothing in [`index.md`](index.md) is lending-specific and all of it applies here; nothing
in [`lending.md`](lending.md) may be assumed to hold for this category, and nothing here may be
assumed to hold for lending.

**Which protocols are scored under it: none, yet.** This section is the rulebook, published and
reviewable _before_ an adapter exists — which [`../TAXONOMY.md`](../TAXONOMY.md) says is the point
of writing it first. It was admitted as a gate-checked submission against Aquarius on Stellar
mainnet (issue #100); the adapter that will read it is #101/#103, and no market is registered to it.

> **This rulebook is incomplete in one declared place, and cannot score anything until that is
> closed.** Its **weight table is deliberately absent** — see [Factor weights](#factor-weights) —
> and `depthSafety`'s absolute-size behaviour, together with this category's size floor, is an
> **[open item](#open-item-a--there-is-no-unit-of-value-inside-an-aquarius-pool)**. Both are
> recorded here rather than filled with plausible numbers. `CATEGORY_FACTORS.dex` in
> [`../core/src/weights.ts`](../core/src/weights.ts) carries `status: 'pendingWeights'` for exactly
> this reason, and the type system — not a comment — is what stops a score being computed from it.

**Everything below was read from mainnet, not from documentation.** That distinction is
load-bearing for this category in a way it was not for lending: `github.com/AquaToken/soroban-amm`
— the repository Aquarius's own audit scope links to — **returns 404 as of 2026-08-27**. There is
no source to read. Every interface claim here comes from the contract spec in the deployed wasm
(`getContractMethods`) and from instance storage, which is what Gate 8 asks for anyway.

**All readings in this section: mainnet ledger 64,152,946, 2026-08-27T20:00Z.**

### Version changelog

Every scored run is stamped with the rulebook version that produced it
(`risk_scores.methodology_version`, from the `dex` entry in `METHODOLOGY_VERSIONS` in
[`../core/src/category.ts`](../core/src/category.ts)), and it is surfaced on the API's protocol
detail and on each history point. **Versions are per category and counters are independent, so this
changelog is `dex`'s.** `dex` v1 and `lending` v1 are not two editions of one rulebook and one is
not older than the other; they are two different rulebooks that each start counting at 1. The
category is stored beside the integer because the integer alone does not identify a rulebook.

| Version | Effective    | Change                                                                                                                                                                                                                         |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1**   | not yet live | The initial three-factor model as documented here — `depthSafety`, `adminKeySafety`, `assetControlSafety` — with no weight table and with the size floor left open. No run has been stamped with it; no score exists under it. |

One row, and it describes a rulebook nothing has been scored under yet. That is deliberate: Gate 7
requires a category to arrive at version 1 rather than acquire a version once it starts producing
numbers, so the counter exists from the moment the rulebook is published. **The first stored `dex`
row will carry version 1** — settling the weight table (#102) does not bump it, because there is no
prior published number for a weight to make incomparable. From the first stored row onward the
ordinary rule in [What bumps the version](index.md#what-bumps-the-version-going-forward) applies
without exception.

History is **not backfilled across a bump, and cannot be**, here as everywhere: `risk_scores`
stores only outputs, never the raw on-chain inputs a run was computed from.

### Factor weights

**There is deliberately no weight table in this section yet.**

Weights are a judgment call, not a reading. [`../TAXONOMY.md`](../TAXONOMY.md) Gate 1 requires every
threshold to either name the on-chain field it anchors to or be labelled an unvalidated judgment
call with its reasoning and its direction of error; a weight can only ever be the second kind.
Publishing three numbers here to make the section look complete would put unanchored values into
the one document that is supposed to be the source of truth for them — and it would do it in the
same change that argued the factor set, which is precisely the review the two-step admission exists
to separate.

So this category is admitted in two steps, and it is currently between them:

|                                                  |                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Step 1 — the factor set (this section, #100)** | Which failures are scored, what each factor's on-chain anchor is, what was rejected. Reviewable on its own, and reviewed. |
| **Step 2 — the weight table (#102)**             | What each factor's share of the overall score is, argued as a judgment call and labelled as one. **Not done.**            |

Until step 2 lands, `CATEGORY_FACTORS.dex` declares `status: 'pendingWeights'` and its factor
entries carry **no `weight` property at all** — not a zero, not a placeholder. An unweighted
declaration is a different TypeScript type from a weighted one, so reading a weight off it is a
compile error rather than an `undefined` that would become `NaN` inside `scoreFactors` and publish
a confident-looking `0`. `core/src/weights.test.ts` asserts the property is absent at runtime too,
and `core/src/scoring.test.ts` asserts this section publishes no weight table while the status says
pending — so the document and the code cannot drift apart in either direction, including into
agreement on a number nobody reviewed.

### The three dex factors

For each factor: the exact raw on-chain data that feeds it, what it detects, and why it is here.
Every anchor names a contract **and** a method or storage field, per Gate 8.

**Three, not five, and the missing two are not an omission.** Three of lending's five have no
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

---

#### 1. `depthSafety` — what a trade of real size actually costs, computed by the pool's own math

**Anchors:** `estimate_swap(in_idx: u32, out_idx: u32, in_amount: u128) -> u128` on the pool
contract, with `get_reserves()` and `get_fee_fraction()` on the same contract.

**The failure it detects:** a trader cannot get out at the size they are actually trading. Nothing
in lending's five measures execution cost, because a lending market has no execution — a withdrawal
is at par or it is refused.

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

**Cannot-assess resolves to 0, the unsafe end.** A pool whose `estimate_swap` reverts, or whose
reserve is zero, scores **0** — never 100, and never a skipped factor. This is ground rule 4 and it
matches `collateralSafety`'s existing treatment of an empty set.

> **What is NOT settled about this factor: the trade size it simulates.** Everything above
> describes _how_ the cost is measured, and all of it holds. _At what size_ is open, and it is open
> for a structural reason rather than an unfinished one — see
> [open item A](#open-item-a--there-is-no-unit-of-value-inside-an-aquarius-pool). **No adapter may
> implement this factor until A is resolved**, because a pool-relative size makes the factor
> degenerate across 272 of 340 pools and an absolute size needs a unit of value Aquarius does not
> have.

#### 2. `adminKeySafety` — seven roles, and how long you get to react to a code change

**Anchors:** `get_privileged_addrs() -> Map` on the router and on every pool; the `UpgradeDeadline`
and `FutureWASM` entries in contract instance storage; Horizon `/accounts/{G…}` for each role's
signer count, thresholds and recent activity.

**This is the same factor key lending uses, and that is a decision, not an oversight.** It is
recorded here so it is not re-litigated (open question B on #100):

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

**Two limits, stated rather than papered over:**

- **The timelock _duration_ is not readable.** `ADMIN_ACTIONS_DELAY` is a compile-time constant with
  no getter, and the source repository is gone. So the factor can grade the **remaining** window
  when an upgrade is pending, and can state that none is pending — it cannot state how long the
  window would be. Anything else would be an invented number, which ground rule 4 forbids. This
  takes Gate 2 **route (a)**: a `value: null` disclosure component saying the duration is not
  readable from the contract.
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

#### 3. `assetControlSafety` — can a third party freeze or seize what the pool holds

**Anchors:** each reserve token contract's instance `executable` and its `AssetInfo` storage entry
(which identifies a Stellar Asset Contract and names its classic issuer), then Horizon
`/accounts/{issuer}` for that issuer's `flags`.

**The failure it detects, and it has no analogue in lending's five:** an Aquarius pool can be
created permissionlessly against any token. If that token is a Stellar Asset Contract whose issuer
has `auth_revocable` or `auth_clawback_enabled` set, **the issuer can freeze or seize the pool's own
balance** — and an LP's exit stops depending on Aquarius's code at all. No amount of depth and no
admin posture protects against it. Aquarius's auditor named this too: Certora **M-02, "Lack of scam
protection for AMM Users."**

Readable, with real variance. Of **205** distinct tokens across the 340 pools, **196 are Stellar
Asset Contracts** (`executable = contractExecutableStellarAsset`, issuer in `AssetInfo`) and 9 are
wasm contracts. Sampled issuer flags, 2026-08-27:

- **`USDC:GA5ZSEJY…`** (Circle, `home_domain = circle.com`) — **`auth_revocable: true`**. Same for
  **`EURC:GDHU6WRG…`**.
- **`LSP:GAB7STHV…`** — `auth_immutable: true`, the strongest reading available: the flags can never
  change.
- AQUA, yXLM, USDx, EURx, BLND, SSLX, WHLAQUA, XRF — all four flags false.
- And a **second asset also called `USDC`**, issuer `GCBYVQH3…`, `home_domain = mirrasets.com`,
  sitting in the same registry as Circle's. That is Certora M-02 in the live data, not in theory.

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
one sentence in the checklist and three different answers here, so each factor states its own rather
than inheriting `depthSafety`'s by example.

**First, the distinction that removes most of the question. A read that FAILS is not a cannot-assess
branch at all.** If Soroban RPC is unreachable, Horizon errors, or a response does not decode, the
adapter **throws** — and the indexer records a failed run and publishes no score for that cycle
(CLAUDE.md's error-handling rule; error handling lives in the indexer, never per adapter). It does
not publish a factor of 0. This matters because the obvious candidates — "what if
`get_privileged_addrs()` reverts", "what if the Horizon account lookup 500s" — are all this case,
and grading them 0 would publish "this pool has dangerous admin control" every time our own network
path hiccuped. A cannot-assess branch is something narrower: **a read that succeeded and still left
the quantity ungradable.**

| Factor               | Has a cannot-assess branch?                     | What it resolves to                                                                |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `depthSafety`        | **Yes**                                         | **0.** `estimate_swap` reverts, or a reserve is zero.                              |
| `adminKeySafety`     | **Yes, and one of them is not settled** — below | **0** for an ungradable role; the non-classic-account case is deferred, see below. |
| `assetControlSafety` | **Yes, but only over an empty set** — below     | **0** when no reserve token can be read at all; otherwise disclosure, not a zero.  |

**`adminKeySafety`.** The two limits already stated — the unreadable timelock _duration_ and the
Emergency Admin's bypass — are route-(a) **disclosures**, not cannot-assess branches: they are
published as `value: null` components and they do not move the factor's number in either direction.
The genuine branch is a role whose posture cannot be graded from a successful read — for example a
role present in `get_privileged_addrs()` whose address is not a classic `G…` account, so there is no
signer set, no threshold and no activity history to read. All seven roles were classic accounts on
2026-08-27, so this branch is unexercised today.

> **It collides with an existing precedent, and this rulebook does not resolve the collision.**
> Lending's `adminKeySafety` does **not** send its equivalent case to 0 — it uses a clearly-flagged
> neutral baseline of **60** for a contract-held admin, on the reasoning that a contract admin is
> not evidence of danger, merely evidence of a different structure. Whether `dex` inherits that
> baseline or sends the case to the unsafe end is a rulebook decision with an argument on both
> sides, and it is **not made here**: the branch cannot be reached by any current reading, and
> deciding it in the same change that argued the factor set would be exactly the unreviewed
> smuggling this section refuses elsewhere. **It must be settled before an adapter implements this
> factor (#103), and the adapter may not pick a number on its own.**

**`assetControlSafety`.** Per token there is no cannot-assess branch: a token either is a SAC, in
which case its issuer's `flags` are readable and gradable, or it is a wasm contract, in which case
the read **does not apply** and the token takes a route-(a) `value: null` disclosure. A disclosure
is not a zero and not a pass — the token is excluded from the computation, not graded badly by it.

The branch exists one level up, **over the set**: a pool every one of whose reserve tokens is a wasm
contract has nothing left to grade, and a minimum over an empty set is **0**, not 100. That is not a
new rule — it is the correction already recorded in lending's changelog for `2026-08-16`, where
`liquiditySafety` and `utilizationSafety` returned 100 from an empty filtered set and were changed
to return 0. The same defect would be available here for free, so it is written down before the
adapter exists rather than after.

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

`OperationalLevel` stayed **one shared ladder**, and gained a rung rather than forking (open
question C on #100, recorded here so it is not re-litigated):

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

### Open item A — there is no unit of value inside an Aquarius pool

**This is the one thing in this rulebook that is not resolved, and it gates both the size floor
(Gate 4) and `depthSafety`'s trade size.** It is recorded as an open item rather than closed with a
plausible choice, because the choice determines what the category's numbers mean.

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

**The submission's recommendation is 1 + 3**, with the 192 non-XLM pools taking a coverage status —
on the ground that it is the only combination where every number traces to something the chain
states rather than something we computed. **It is a recommendation and not a decision**, and it is
a maintainer's call because it determines whether the category is admissible at all.

**Until it is decided:** no adapter may implement `depthSafety`, no size floor exists for this
category, and no protocol may be registered under `dex`. Gate 4 is **not** cleared, and this
document does not claim it is.

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
the question; it does not claim the answers were computed the same way. See
[factor 2](#2-adminkeysafety--seven-roles-and-how-long-you-get-to-react-to-a-code-change).

### One adapter, many markets

The same rule lending already runs under, and Aquarius has the same shape as Blend: **exactly one
wasm per pool type**, each matching the hash the router itself declares —
`ConstantPoolHash` `ae0da5a8…de9852` (272/272 pools), `StableSwapPoolHash` `f1077e0b…e747cd` (42/42),
`ConcentratedPoolHash` `12fca5a7…d37ee6` (26/26). Verified against the router's own declared hashes
rather than assumed.

So a second Aquarius market is a **config entry and no new scoring code**. CLAUDE.md's "one adapter
may serve several markets; a market never gets its own adapter" applies here unchanged, and nothing
on a per-pool config may be a threshold, weight or formula — that would be a per-pool rulebook.
