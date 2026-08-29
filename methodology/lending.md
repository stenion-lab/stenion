## Lending

Everything from here to the [Dex](dex.md#dex) heading is **lending's rulebook and lending's alone**
— its version changelog, its factor weights, its worked example, and the five factors themselves.
It is one of two categories Stenion publishes a rulebook for (`PROTOCOL_CATEGORIES` in
[`core/src/category.ts`](../core/src/category.ts)), and it is the only one anything is scored under
today. This section was written as the shape a second one would take — its own heading, its own
changelog, its own weight table, its own factor list — and [Dex](dex.md#dex) is that second one,
taking exactly that shape. Nothing above this line is lending-specific; **nothing below it may be
assumed to hold for a category that isn't lending**, and in particular a `dex` score is not
comparable with a `lending` one.

**Which protocols are scored under it:** every market on the registry today — the three Blend
pools ([`adapters/blend/`](../adapters/blend)) and Kinetic/K2
([`adapters/kinetic/`](../adapters/kinetic)). Ground rule 1 binds all of them to what follows.

### Version changelog

Every scored run is stamped with the rulebook version that produced it
(`risk_scores.methodology_version`, from the `lending` entry in `METHODOLOGY_VERSIONS` in
[`core/src/category.ts`](../core/src/category.ts)), and it is surfaced on the API's protocol detail
and on each history point. Versions are per category and counters are independent, so this
changelog is **lending's**; another category's v1 is a different rulebook, not an earlier one.
Each category gets exactly one such table, in its own section. The changelog:

| Version | Effective | Change                                                                                                                                                                                                                 |
| ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | initial   | The five-factor model as documented here. `oracleSafety` scores price freshness **and** manipulation resistance (§2); `liquiditySafety`/`utilizationSafety` score only reserves clearing the minimum-size filter (§4). |

One row, and that is the point: v1 is where versioning starts, not where it started counting
again. Development-era history under earlier iterations of these rules was discarded rather
than migrated — what that was and why it was deleted is at the top of this document, along with
what does and doesn't warrant a bump. See [Current version](index.md#current-version).

#### Corrections that did not bump the version

Fixes where the **implementation disagreed with this document** and the document was right. The
rulebook did not change, so these are not version boundaries and stored scores remain comparable
across them — but they are recorded here rather than left silent, because a score did change shape
even if no published number moved.

> The entry below was verified against the development-era history that has since been
> discarded (see [Current version](index.md#current-version)), so its row counts are no longer
> re-checkable. It is kept as the record of a correction, not as a live claim about stored
> data. The fix itself is in the shipped v1 rulebook.

| Date (UTC)   | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-08-16` | `liquiditySafety` (§4) and `utilizationSafety` (§5) returned **100** when no reserve qualified for their minimum, in both adapters. Both are a minimum over a filtered set of reserves; over an empty set that is undefined, not the top of the scale — so an unassessable pool published "maximally safe" from no data, contrary to ground rule 4. Both now return **0**, matching `collateralSafety`'s existing treatment of the same case. **No published score was affected:** the path had never executed — verified by scanning the entire stored history of both protocols for the signature the defect leaves in a factor's `detail` (a `worst reserve (…)` naming no asset, since `worstAsset` stayed empty when nothing was measured), with zero matches. Re-checked on `2026-08-16` against 1,923 rows; `liquiditySafety` has ranged 20–34 and `utilizationSafety` 10–18 across that history, never approaching the 100 the empty path would have published. |

#### Amendments folded into v1

Changes to the rulebook made **while v1 was still being finalized as the comparability
baseline** — before any surviving stored history existed. These are not version boundaries: v1
is defined as the rulebook this document describes, and these are part of that definition
rather than a departure from it. None of them left a step in a published history, because the
history they predate was discarded rather than carried forward. Each gets a row anyway, so that
what v1 means is traceable rather than assumed: "no bump required" does not mean "no record
required".

**This section closes when the next change lands.** From that point the rule in
[What bumps the version](index.md#what-bumps-the-version-going-forward) applies without exception, and
a change that alters what a number means bumps to v2.

| Date (UTC)   | Amendment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2026-08-18` | §4 and §5 gained the [minimum-size filter](#the-minimum-size-filter): both now select the worst reserve only among reserves clearing the protocol's own declared minimum exposure **or** 0.5% of the pool's supplied USD. This changes what the two factors measure, which is why it is recorded rather than treated as a correction. **No live score moved when it landed** — verified against both protocols on the day: Blend excludes nothing (its smallest reserve is ~$3.4M against a $5.00 `min_collateral`), and K2's dust reserve had already stopped being its worst reserve. **What it changes, measured on the frozen 2026-08-16 snapshot:** `liquiditySafety` 34 → 44 and `utilizationSafety` 18 → 30 (score 24 → 28), by excluding a $3.00 reserve holding 0.19% of a $1,571 pool. |

**History is not backfilled across a version bump, and cannot be.** `risk_scores` stores
only outputs — the score and the factor map — never the raw on-chain inputs a run was
computed from, so an old row cannot be recomputed under new rules by us or by anyone. The
discontinuity is real and permanent; the version stamp exists so it is legible rather than
appearing as an unexplained step in a chart.

### Factor weights

Lending's weights, and lending's only. This table is the published face of
`CATEGORY_FACTORS.lending` in [`core/src/weights.ts`](../core/src/weights.ts), which is where the
adapters read them from — neither adapter contains a weight of its own, and
`core/src/scoring.test.ts` parses this table and fails if the two disagree in either direction.

| Factor              | Weight   |
| ------------------- | -------- |
| `oracleSafety`      | 0.25     |
| `collateralSafety`  | 0.20     |
| `adminKeySafety`    | 0.20     |
| `utilizationSafety` | 0.20     |
| `liquiditySafety`   | 0.15     |
| **Total**           | **1.00** |

**Worked example (live Blend Fixed V2 pool, 2026-08-14, lending methodology v1):**
`70×0.20 + 100×0.25 + 40×0.20 + 22×0.15 + 14×0.20 = 53.1 → 53`.

> **Weights are an unvalidated judgment call, not an external fact.** `oracleSafety` carries the most
> weight because an untrustworthy price silently poisons every other measurement —
> collateral value, utilization and liquidity are all priced off it. Liquidity carries the
> least because it partly overlaps utilization. There is no external framework these exact
> weights are anchored to yet — they are open to challenge like any threshold below.
>
> **Oracle robustness was folded into `oracleSafety` rather than given its own factor**,
> partly for this reason: a sixth member would have forced a redistribution across all five,
> layering a second unanchored judgment call on top of one already flagged as unanchored. The
> taxonomy in [`core/src/types.ts`](../core/src/types.ts) stays at five factors.

---

### The five lending factors

For each factor: the exact raw on-chain data that feeds it, the exact formula, and why the
thresholds are what they are (anchored to an external/on-chain value where one exists,
labeled an unvalidated judgment call where none does).

Two fixed-point scalars appear throughout, taken from
`blend-contracts-v2/pool/src/constants.rs`:

- `SCALAR_7 = 10^7` — decimals for `c_factor`, `l_factor`, `util`, `max_util`.
- `SCALAR_12 = 10^12` — decimals for `d_rate`, `b_rate`.

A reserve's human-unit totals (used by several factors) are:

```
supplied = b_supply × b_rate / (SCALAR_12 × 10^assetDecimals)
borrowed = d_supply × d_rate / (SCALAR_12 × 10^assetDecimals)
```

---

#### 1. `collateralSafety` — collateral concentration (weight 0.20)

**What it measures:** how spread out the pool's supplied value is across its reserves. A
pool whose value sits in one asset is far more exposed to a single de-peg or liquidation
cascade than a balanced one.

**Raw on-chain data (Soroban RPC, no third party):**

- Per reserve, from the pool contract's persistent storage:
  - `ResData` entry → `b_supply`, `b_rate`
  - `ResConfig` entry → `decimals`
- Oracle price per asset: `lastprice(Asset::Stellar(address))` on the pool's configured
  oracle contract → `price`, and the oracle's `decimals()`.
- USD value per reserve: `suppliedUsd = supplied × (price / 10^oracleDecimals)`.

**Formula** — a normalized Herfindahl–Hirschman Index (HHI) over each reserve's share of
total supplied USD:

```
Let vᵢ = supplied USD of reserve i (only priced reserves with vᵢ > 0)
    n  = number of such reserves
    sᵢ = vᵢ / Σv                 (each reserve's share)
    HHI = Σ sᵢ²                   (ranges from 1/n for a perfectly even split, to 1)

collateralSafety = clamp( (1 − HHI) / (1 − 1/n) × 100 , 0, 100 )
```

Edge cases: **0 priced reserves → 0** (can't assess, treated as unsafe rather than
guessed); **exactly 1 priced reserve → 0** (fully concentrated by definition).

**Why HHI / why these anchors:** HHI is the standard, widely-published concentration
measure (used by competition regulators and in portfolio analysis) — an _external_
framework rather than a Stenion invention. The anchoring points are not arbitrary either:
`1/n` (a perfectly even split) is the mathematically safest achievable state for `n`
reserves and maps to 100; `1` (everything in one asset) is the worst and maps to 0.
Normalizing by `1/n` means the score grades a pool against the best _it_ could do given how
many reserves it has, not against an arbitrary constant.

---

#### 2. `oracleSafety` — price trustworthiness: freshness _and_ manipulation resistance (weight 0.25)

> **Why this factor is not just price age.** An age-only oracle factor scores a fresh but
> manipulated price 100 — which is precisely the configuration behind the February 2026
> YieldBlox/Blend incident. Freshness alone is not a weak signal on that axis, it is a
> misleading one, so this factor takes the binding constraint of freshness and manipulation
> resistance. Earlier development-era scores did measure age alone; that history was
> discarded rather than carried forward, and no stored row was computed that way — see
> [Current version](index.md#current-version).

**What it measures:** whether the prices this pool actually runs on can be trusted. Two
things must both hold, and the factor takes **the binding constraint of the two** — a
bounded stale price and a fresh unbounded price are both untrustworthy, for different
reasons:

```
oracleSafety = min( priceFreshness , deviationBound )
```

Both sub-signals take the **worst reserve**, the same convention as every other factor:
the binding constraint is the single weakest reserve, and averaging would hide it. Both
are published in the factor's `components` array so the composite is never an opaque
number.

Both are also anchored to parameters the pool's own price path has to **publish**, which
makes this the one factor with a precondition attached: a market whose oracle publishes
neither a staleness tolerance nor a deviation bound is not scored at all, rather than scored
with a guessed anchor or with this factor dropped. See
[2e, the oracle-legibility precondition](#2e-the-oracle-legibility-precondition).

**Every reserve at the binding value is named, not one of them.** When several reserves tie
on a sub-signal the `detail` lists all of them; when _all_ of them tie it says so rather than
singling one out. This is reporting only — the published value is the same minimum either way
— but it is load-bearing for reading a score honestly. Blend prices its whole pool from one
aggregator publish round, so its reserves carry identical ages and **always** tie on freshness.
Naming one of them would make an iteration-order artifact read as a diagnosis, and a reserve
name that is really a tie-break is worse than no name at all.

##### 2a. `priceFreshness` — how stale the worst price is

**Raw on-chain data (Soroban RPC):** per reserve, the price's publish `timestamp` from
the method the protocol's own pool calls; `fetchedAt` is the adapter's read time;
`age = fetchedAt − timestamp`.

```
fresh = the protocol's own publish/refresh interval        → 100
dead  = min( protocol's own max acceptable price age, 3600s ) → 0

priceFreshness = clamp( (age − dead) / (fresh − dead) × 100 , 0, 100 )
```

No usable price for a reserve → **0** (a missing feed is maximally unsafe, not skipped).

**Both anchors are the protocol's own on-chain parameters**, the same anchoring pattern
`utilizationSafety` uses. Which parameter each resolves to is a documented per-protocol
fact, not a per-protocol rule:

| Protocol         | `fresh` source                                                                                                                                     | `dead` source                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Blend**        | `oracles()[i].resolution` on the pool's oracle aggregator (**300s**)                                                                               | `max_age()` on the same aggregator (**900s**)                                                          |
| **Kinetic (K2)** | `PriceCacheTtl` on the price oracle (**30s**) — the window inside which K2 itself treats a price as current; K2 exposes no publish-interval getter | the **tighter** of the per-asset `max_age` (43200s) and the global `price_staleness_threshold` (3600s) |

Taking the tighter of two limits a protocol declared is not a Stenion threshold — both
numbers are K2's, and the binding one is the one that governs.

> **⚠️ The 3600s cap on `dead` is the one Stenion constant left in this factor, and it is
> an unvalidated judgment call.** Anchoring purely to a protocol's own max age would
> mean a protocol scores _better_ for tolerating staler prices — K2's per-asset `max_age`
> is 12 hours, which would make a six-hour-old price score ~50. That is the wrong
> incentive for a platform protocols are ranked by, so the anchor is capped. There is no
> external framework fixing the cap at one hour; it is open to challenge like any
> threshold here. It lives in one place, `STALE_CEILING_SECONDS` in
> [`core/src/scoring.ts`](../core/src/scoring.ts).

##### 2b. `deviationBound` — can a single update move the price arbitrarily far?

**Binary, not a curve:**

```
deviationBound = 100  if the pool's price path bounds a single-step move, and that bound is armed
                 0    otherwise
```

| Protocol         | Bounded when                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Blend**        | the aggregator's per-asset `max_dev` satisfies `0 < max_dev < 100` — the contract's own condition in `oracle-aggregator/src/price_data.rs` |
| **Kinetic (K2)** | `max_price_change_bps > 0` **and** `get_last_price(asset)` returns a present, non-zero baseline                                            |

**Why the extra clause for K2.** The two contracts fail in opposite directions when there
is no prior price to compare against. Blend's aggregator fails **closed**: with no older
record it returns `None` and the reserve simply cannot be priced. K2's
`validate_price_change` fails **open**: with no stored baseline it returns `Ok` and lets
any price through, so a configured bound with no baseline is inert. Checking the baseline
is what distinguishes a breaker that is configured from one that is actually armed — and
the no-baseline case is exactly the newly-listed-thin-asset scenario that the YieldBlox
incident ran through.

**Why this is anchored, and what it isn't.** The scored quantity is the presence and
arming of a bound, and it is read from the protocol's own on-chain configuration — the
same pattern as `utilizationSafety`'s `max_util`. `max_dev = 0` does not mean "a tight
bound of zero"; the aggregator's own type documentation says _"If this is 0, the oracle
will just fetch the last price within the resolution time"_ — the check is skipped
entirely. That is provably the condition that permits an unbounded single-step move.

**Base assets are excluded, not scored 0.** The Blend aggregator's `lastprice`
short-circuits its `Base` and `BaseAssets` to exactly `1.0` at the current ledger time
without consulting any upstream feed. Those reserves have no oracle-derived price to
grade, so they are dropped from both sub-signals and the count of excluded assets is
disclosed. (Whether such a peg _holds_ is a real risk — but it is a collateral/peg
question, not an oracle-robustness one, and inventing a number for it here would be the
kind of fabrication ground rule 4 forbids.)

##### 2c. Per-feed price ages are disclosed, never scored

`priceFreshness` grades the **worst** reserve, which is the right thing to score but hides the
**spread** — and on real data the spread is the informative part. A factor value of 0 reads as
a general condition of the oracle. "Two feeds have not updated in hours while two others update
every few seconds, through one contract and one source" is a specific, checkable statement
about which feeds are being maintained, and it is the one a depositor can act on.

So every reserve's price age is published as a **disclosure-only component** (`priceAges`,
`value: null`), ordered oldest-first, alongside a count of how many exceed **the protocol's own
declared staleness limit** — Blend's aggregator `max_age`, K2's `price_staleness_threshold`.
The count is therefore a statement about the protocol's own rules, not about a Stenion line. A
reserve with no usable price at all sorts as the oldest rather than the freshest.

It is not scored, because it would double-count: these are the same ages `priceFreshness` was
computed from, republished so that the grading can be checked rather than taken on faith. It is
published on healthy pools as well as unhealthy ones — a disclosure that appears only where
trouble is expected gives a reader no baseline to compare against.

##### 2d. Bound tightness is disclosed, never scored

The raw bound is published as a **disclosure-only component** (`value: null`) — visible,
never graded. Grading it would invent comparability the underlying data does not support:

|                     | Blend `max_dev`                                              | K2 `max_price_change_bps`                                 |
| ------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Scope               | per asset                                                    | global                                                    |
| Units               | whole percent (`60` = 60%)                                   | basis points (`2000` = 20%)                               |
| **Baseline**        | the previous **upstream record**, one `resolution` step back | `get_last_price` — the last price the contract **served** |
| **Bounds move per** | **publish interval (300s)**                                  | **query** — no fixed time spacing                         |

Both compute `|new − old| / old`, and the unit difference normalizes trivially. The
baseline difference does not: "20% per arbitrary interval" and "60% per five minutes" are
different quantities, so the intuitive reading that K2's bound is three times tighter than
Blend's is unsound. Publishing the numbers side by side without a score is the honest
treatment.

##### 2e. The oracle-legibility precondition

Both halves of this factor are anchored to parameters **the pool's own price path
publishes**: §2a's window comes from `resolution` and `max_age`, §2b's bound from per-asset
`max_dev`. That is the whole design — the numbers are the protocol's, not Stenion's. It has
a precondition hiding inside it, which this section makes explicit:

> **A market is scorable only if its price path publishes the parameters §2 grades against.
> Where it does not, the market is not scored at all — it is not scored with a guessed
> anchor, and it is not scored with `oracleSafety` omitted.**

This is the [market-size floor](#the-market-size-floor) one factor down, and it has the same
shape: a precondition on what gets scored at all, rather than a rule about how to score it.
Markets excluded by it are published in
[`dashboard/app/lib/coverage.ts`](../dashboard/app/lib/coverage.ts) as `oracle-not-gradable`,
with a per-market reason and a date — never as a `protocols` row, and never with a numeral.

**Where the line falls today.** Blend's oracle-aggregator publishes all three reads
(`max_age()`, `oracles()`, `asset_configs()`); those are Blend's interface, not SEP-40's.
Every Blend V2 pool Stenion scores sits on one. Four live pools do not, and the interfaces
below were read on **2026-08-26** out of each oracle's own wasm (`contractspecv0` via Soroban
RPC `getContractMethods`) rather than probed by calling a list of guessed names — a guess-list
cannot distinguish "this contract lacks the method" from "this is a different contract":

| Pool            | Oracle wasm | What the contract actually is                                       | `max_age` | `oracles` | `asset_configs` |
| --------------- | ----------- | ------------------------------------------------------------------- | --------- | --------- | --------------- |
| Blend Fixed     | `41df0489…` | Blend oracle-aggregator                                             | ✅        | ✅        | ✅              |
| YieldBlox       | `8cf43882…` | oracle-aggregator, different build                                  | ✅        | ✅        | ✅              |
| Etherfuse       | `65300c00…` | oracle-aggregator                                                   | ✅        | ✅        | ✅              |
| **Orbit**       | `a71a844e…` | **bridge** oracle — ctor `(admin, stellar_oracle, other_oracle)`    | ~         | ~         | ~               |
| **Forex**       | `1d1c90d3…` | **proxy** — `CONFIG.base_oracle` points one hop up at a SEP-40 feed | ~         | ~         | ~               |
| **Spectra PTs** | `4a444181…` | **deterministic zero-coupon-bond pricer** — not a feed at all       | ~         | ~         | ~               |
| **Solv**        | `5700be21…` | **SEP-40 feed registry** — the only SEP-40 implementer of the four  | ~         | ~         | ~               |

**Those four are not one shape.** They are four different contracts with four different wasm
hashes doing four different things, and the only thing they agree on is the column that
decides this: none answers any of the three. Worth stating because the obvious fix — "handle
the other oracle shape too" — is really "handle four more shapes", and each would be a
separate reading of a separate contract's semantics. All four answer `decimals()` and
`lastprice()`, so §1, §3, §4 and §5 compute normally for them; what is missing is only the
metadata §2 grades against.

###### Why there is no fallback anchor: SEP-40 does not define one

Stated plainly rather than worked around. [SEP-40](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md)
defines `base, assets, decimals, resolution, price, prices, lastprice` — **no maximum
acceptable price age and no deviation bound anywhere in the interface**. The spec puts
staleness checking on the _consumer_ ("Always check retrieved price data for staleness by
comparing the quoted timestamp with current date"), which is precisely the judgment §2 exists
to make and precisely what it refuses to make from an invented number.

So the only candidate is `resolution()` — a publish interval, not a staleness tolerance —
and **using it fabricates a 100 on a demonstrably stale price**:

> Solv publishes `resolution() = 43200` (12 hours, and mutable after deployment via its own
> `set_resolution`, which its source documents as a deliberate deviation from SEP-40). Fed to
> `freshnessWindow` with no `max_age` to pair it with, that yields `{fresh: 43200, dead:
86400}` — because `STALE_CEILING_SECONDS` clamps `dead` and not `fresh`, so a feed that
> declares a slow tick gets a slow dead line rather than a capped one. Solv's genuinely stale
> feeds, read at **10,285s and 21,739s old on 2026-08-26**, would both publish
> `priceFreshness` **100**.

And `resolution()` is only present on one of the four at all. Orbit and Forex expose it one
hop upstream through their bridge/proxy, which would make the anchor a property of a contract
the pool does not itself publish; Spectra has no upstream feed to chase.

###### Two of the four price off the ledger clock, so freshness is 100 by construction

The sharper problem, and the reason this is a precondition rather than a "weak signal":

- **Spectra PTs** runs "Spectra Deterministic Oracle — Zero Coupon Bond Model". Its price is a
  function of `start_t`, `maturity` and `initial_implied_apy` evaluated at the current ledger
  time, its `lastprice` **ignores the asset argument entirely** (its own doc comment says so),
  and its owner can move the target with `set_future_pt_value`. There is no publish event, so
  there is no such thing as a stale price: `age` is always ~0 and any freshness formula
  returns 100 permanently, whatever happens to the asset.
- **Orbit's** dominant reserve — **99.5% of that pool's $190,863** on 2026-08-26 — returns
  exactly `1.0` at current ledger time while touching no upstream contract. §2b already
  handles that case on an aggregator: base assets are excluded rather than scored, because
  there is no oracle-derived price to grade. Orbit's bridge **publishes no `base()`**, so
  there is nothing to detect them with, and the reserve would be graded as a fresh feed.

A fabricated **100** is worse than a fabricated 0, because 0 at least renders in the danger
band where a reader discounts it. Ground rule 4 forbids both.

###### What was rejected, and why it must not be re-proposed

- **Make the three calls optional and score `oracleSafety` on what remains.** Rejected: there
  is nothing to score on. Both anchors are gone, `deviationBound` collapses to a constant 0
  for all four pools — a constant is not a measurement — and `priceFreshness` collapses to a
  constant 100 for two of them. It also reads as a diagnosis it did not make: a `max_dev` of 0
  means a protocol **disabled** its bound, which is the YieldBlox finding; publishing the same
  0 for a protocol whose oracle never had the mechanism asserts a choice nobody made.

- **A `null` `oracleSafety`, scored on the remaining four factors.** Rejected, and this is the
  one that looks reasonable until it is measured. `scoreFactors` renormalizes over non-null
  weights, so dropping `oracleSafety` divides by 0.75 instead of 1.00. Run against live chain
  data on 2026-08-26, that is not neutral — it is a **large upward** revision, because
  `oracleSafety` is the heaviest factor (0.25) and the one a badly-configured pool scores
  worst on:

  | Pool        | Score with `oracleSafety: null` | For comparison, live registry |
  | ----------- | ------------------------------- | ----------------------------- |
  | **Orbit**   | **71**                          | Blend `51`                    |
  | Spectra PTs | 49                              | Kinetic `27`                  |
  | Solv        | 15                              | YieldBlox `25`                |
  | Forex       | 11                              |                               |

  Orbit would publish **71 — the highest number in the registry, twenty points above Blend
  Fixed** — while Admin-Frozen, 99.5% concentrated in a synthetic priced at a hardcoded 1.0,
  through an oracle publishing neither a staleness tolerance nor a deviation bound. That is an
  incentive inversion: YieldBlox scores `oracleSafety` **0** for having a deviation bound and
  disabling it, so _not publishing the mechanism at all_ would pay better than publishing it
  switched off. Ship an opaque oracle, get a better number — which is ground rule 2's concern
  arriving through the back door.

  It is **not** the same failure as the rejected sixth factor under
  [Factor weights](#factor-weights): that one moved _every_ protocol's score by changing the
  denominator for everyone. This moves only the affected pool's. The failure here is
  different and, in a ranked list, worse — two entries in the same ranked column would be
  graded on **different rulebooks**, four factors against five, which ground rule 1 does not
  permit. A `null` factor is defined as "genuinely doesn't apply to this protocol" (the
  dashboard renders it "Not applicable to this protocol"). A pool that runs on prices, whose
  price configuration we could not read, is not a pool to which price trustworthiness does not
  apply.

- **Reading the anchor from the upstream oracle** a bridge or proxy forwards to. Rejected:
  it answers for a contract the pool does not publish and does not itself constrain, it exists
  for only two of the four, and following it is a bespoke traversal per oracle implementation —
  a per-market rulebook in all but name. It also would not have helped: the upstream feeds
  behind Orbit and Forex publish `resolution()` and no `max_age`, so the traversal lands back
  on the fabricated anchor above.

**This does not bump lending's methodology version.** It moves no published number and changes no
formula. Every market Stenion scores runs on an aggregator, so `oracleSafety` is computed
byte-identically before and after; what changed is that a precondition already implicit in §2
is now written down and enforced in code
([`ORACLE_GRADING_READS`](../adapters/blend/fetch.ts) and `oracleNotGradable`), instead of surfacing as
an unexplained `HostError` from whichever read happened to run first. Same reasoning, and the
same conclusion, as the market-size floor.

> **⚠️ What this costs, stated rather than glossed.** Four live markets stay unranked, one of
> them holding real money — Orbit's $190,863 on 2026-08-26. The market-size floor's warning
> applies here in full: an excluded market has no entry at all, which is a stronger action
> than excluding a reserve. `coverage.ts` is the answer to that and not a formality — each of
> the four gets a page, a per-market reason, the contract addresses, and a `verify` sentence,
> so a reader can disagree with the decision from the same data it was made on. What they do
> not get is a number, because there is no number to give them.
>
> **The precondition is a property of the oracle, not a verdict on the protocol.** Nothing
> here says these markets are unsafe, or that their oracles are bad ones. A deterministic bond
> pricer is a perfectly coherent way to price a principal token; it is simply not a thing this
> factor knows how to grade. If such an oracle later publishes a staleness tolerance and a
> deviation bound, the pool becomes scorable with **no rule change** — it is a `BLEND_POOLS`
> entry and a deleted coverage entry, in one PR.

##### What was considered and deliberately rejected

Recorded so these are not re-proposed as improvements later. Each was investigated against
the February 2026 YieldBlox incident — the test being whether it would have distinguished
the manipulated price from a legitimate one **at the time**, since a signal that looks
sophisticated but would not have caught the actual attack is worse than none: it
manufactures confidence.

- **Filtering `oracleSafety` by reserve size, the way §4/§5 are filtered.**
  **Rejected on principle, not on impact** — and the distinction it turns on is the reason
  §4/§5 may be size-filtered while this factor may not:

  > **§4 and §5 measure current state. §2 measures a vulnerability.** How drained a reserve is
  > right now means little when the reserve holds $4, because the exposure is capped by what is
  > actually in there. Whether a price can be trusted is not capped that way, because the
  > attacker's move is to _grow_ a position against the mispriced asset. **A dust reserve with a
  > stale price is an open door, not a small room.** Its balance today says nothing about what
  > can be borrowed against it tomorrow.

  And it would blind the factor to the exact scenario it exists for: a newly-listed thin asset
  with a bad price is the shape the February 2026 YieldBlox incident ran through, which §2b
  already names. A filter that removes thin assets from an oracle-trust factor removes the
  attack it was built to catch.

- **A Stenion-computed deviation from the oracle's price history** (calling Reflector's
  `prices(asset, N)` ourselves and comparing the latest price to a trailing mean).
  **Rejected — this would have made the platform actively worse.** It is a _coincident_
  indicator, not a leading one: it can only fire while an attack is in progress, and only
  if the indexer happens to sample inside the manipulation window. The indexer runs every
  five minutes, so the overwhelmingly likely outcome is that it reads clean and Stenion
  publishes a confident `oracleSafety` of 100 _during_ an active exploit. It also measures
  a code path the pools never consult: neither Blend's aggregator nor K2's oracle exposes
  price history to the pool at all. A signal that is usually silent during the event it
  claims to detect, computed over data the protocol does not use, is not a weak signal —
  it is a misleading one.
- **TWAP.** Not available: the deployed Reflector contracts (`version() == 6`) expose no
  `twap` method — the exported interface is `base, assets, decimals, resolution, price,
prices, lastprice, last_timestamp, history_retention_period, …`. Earlier Reflector
  versions had one; the live contracts do not. Neither protocol's oracle passes history
  through either. And on the merits it would not have helped: the attacker held the only
  trades in the window, so a short TWAP over a dead order book _is_ the manipulated price.
- **Oracle type / provider identity** ("is it Reflector?"). Zero discriminating power: the
  exploited pool and the healthy Blend pool both price through Reflector-family feeds via
  the same `oracle-aggregator` contract family. What differed was configuration, not
  provider.
- **Number of upstream sources.** Both pools had exactly one upstream oracle, so it would
  not have separated them. It is also not comparable across protocols: a count is only
  readable where a contract happens to publish one (K2's upstream RedStone adapter exposes
  `unique_signer_threshold() == 3`; Reflector's node consensus is not exposed on-chain at
  all), so counting would systematically understate feeds that keep their aggregation
  internal.
- **SDEX order-book depth via Horizon.** Conceptually the right quantity — thin market
  depth is what made the manipulation cheap — and mechanically readable. Rejected for now
  on three grounds: order books are trivially spoofable with walls that are never hit; it
  only applies to assets priced off the Stellar DEX; and it cannot be validated
  retroactively, because the exploited market has since been rebuilt. Tracked as a
  candidate in [`ROADMAP.md`](../ROADMAP.md) rather than shipped on intuition.

##### What this factor would have said on 2026-02-22

Running the shipped adapter against the exploited pool and the healthy one today, same
rulebook, no special-casing:

| Pool                                        | `priceFreshness` | `deviationBound`                                    | `oracleSafety` |
| ------------------------------------------- | ---------------- | --------------------------------------------------- | -------------- |
| Blend Fixed V2 (`CAJJZSGM…`)                | 100              | 100 — all reserves bounded (`max_dev` 60/20/20)     | **100**        |
| YieldBlox (`CCCCIQSD…`, the exploited pool) | 84               | 0 — XLM and AQUA carry `max_dev: 0`, check disabled | **0**          |

Both pools' prices are fresh, so an age-only factor scores both high — 100 and 84, the
latter being an ordinary mid-window price age, not a warning. This factor separates them
anyway, and on the axis that actually failed.

> **This is no longer a demonstration run.** As of the multi-pool change, the YieldBlox pool
> is a **registered, continuously scored entry** in the public registry, and the row above is
> its live `oracleSafety`, published every five minutes like any other. Two consequences worth
> stating: the claim in this section is now checkable by anyone against
> `GET /api/v1/protocol/yieldblox` rather than reproducible only by running the adapter by
> hand; and the number will move, because it is live. The pairing that matters — a fresh price
> and a disabled bound — is a property of the pool's configuration, not of the moment it was
> sampled.
>
> The entry is labelled a **Blend V2 pool** wherever it appears (`deployedOn` on both API
> responses). It is not a third protocol, and the registry must not be read as saying so.

> **⚠️ Two honest limits on that claim, stated rather than glossed:**
>
> 1. **The historical `max_dev` is a deduction, not a reading.** Soroban RPC serves no
>    historical contract state, so the exact value USTRY carried on 2026-02-22 cannot be
>    read back. What is verifiable: the deployed aggregator skips the deviation check
>    entirely when `max_dev` is `0` or `≥ 100`, and rejects the price outright otherwise —
>    so a ~100× single-step move is arithmetically incapable of passing any bound between
>    1 and 99. USTRY's bound must therefore have been disabled. USTRY today carries
>    `max_dev: 10`; XLM and AQUA in that same live contract still carry `0`.
> 2. **Semantics were verified against the public repo, not that binary.** The exploited
>    pool's aggregator (wasm `8cf43882…`) and Blend Fixed V2's (`41df0489…`) are different
>    builds. Both export the same eleven functions, and the `max_dev` logic above is read
>    from [blend-capital/oracle-aggregator](https://github.com/blend-capital/oracle-aggregator);
>    it has not been decompiled from the exploited pool's specific binary.

> **⚠️ K2's enforcement is an inference, held to the same standard.** `max_price_change_bps`
> is enforced on every return path of `get_asset_price_data` in K2's audited source
> (`code-423n4/2026-04-k2`), and the deployed wasm contains both the `max_price_change_bps`
> and `PriceChangeTooLarge` symbols. But the live `kinetic_router` does not call that
> method — it calls `get_asset_prices_vec_fresh`, one of nine functions present in the
> deployed oracle and absent from the audited source, whose source is not public. The
> audited sibling `get_asset_prices_vec` does enforce the breaker, and all three methods
> return identical data today. We score it as enforced on that basis. **That is an
> inference, not a verification**, and it is written up as a finding in its own right —
> see the Kinetic entry in the registry.

---

#### 3. `adminKeySafety` — admin signer structure + activity (weight 0.20)

**What it measures:** how much unilateral, live control a single party has over the pool. A
lone hot key that can reconfigure the pool is the sharpest centralization risk; multisig
and inactivity are safer.

**Raw on-chain data:**

- The admin **address** comes from the pool contract's instance storage (`Admin`, or
  `Config.admin`) via Soroban RPC.
- If the admin is a **keypair account** (`G…`), signer structure and activity come from
  **Horizon** (official Stellar infra, not a third party):
  - `GET /accounts/{address}` → `thresholds.high_threshold`, `signers[]` (→ `signerCount`)
  - `GET /accounts/{address}/operations?order=desc&limit=200` → `created_at` of each op;
    `recentOps` = count within the last **30 days**.
- If the admin is a **contract** (`C…`), Horizon has no account entry to introspect —
  there is genuinely nothing to measure.

**Formula — a tiered base (categorical, NOT a curve) minus a continuous activity penalty:**

This factor is deliberately **tiered**, not a continuous function, because signer structure
is categorical. The base value is chosen by tier:

| Tier                    | Base    | Detected by                                                           |
| ----------------------- | ------- | --------------------------------------------------------------------- |
| Contract-governed admin | **60**  | admin address starts with `C…` (flagged neutral baseline — see below) |
| Single master key       | **40**  | keypair account, not multisig                                         |
| N-of-M multisig (N ≥ 2) | **90**  | `signerCount > 1` **AND** `high_threshold > 1`                        |
| Multisig + timelock     | **100** | _RESERVED — see note_                                                 |

Then a continuous activity penalty is subtracted:

```
activityPenalty = min(30, recentOps × 3)          # capped so structure still dominates
adminKeySafety  = clamp( base − activityPenalty , 0, 100 )
```

**⚠️ The "Multisig + timelock" (100) tier is reserved and not yet reachable.** No
on-chain timelock signal is exposed to the adapter through Horizon today, so nothing is ever
scored 100 by this factor at present. It is documented as the intended top tier so that when
a timelock signal becomes detectable, the tier already exists rather than being invented ad
hoc. This is an **aspirational placeholder, explicitly flagged, not a live rule.**

**⚠️ The contract-governed baseline (60) is a flagged neutral value, not a measurement.**
When the admin is a contract, we cannot introspect its governance via Horizon. Rather than
fabricate a plausible signer/activity number, we assign a fixed, clearly-labeled neutral
baseline of 60 and say so in the factor's `detail` string. This is honest ignorance, not a
score.

**Why these numbers (unvalidated judgment calls, partially anchored):**

- The single-key (40) vs multisig (90) _split_ is anchored to a real, hard security fact: a
  1-of-1 key is a single point of unilateral compromise; an N-of-M multisig with
  `high_threshold > 1` provably requires more than one party to reconfigure the pool. The
  detection condition (`signerCount > 1 AND high_threshold > 1`) reads Stellar's actual
  account threshold model, not a proxy.
- The **exact** base values (40, 90, 60) and the activity penalty shape (`−3` per op, capped
  at `−30`) are **unvalidated judgment calls.** The cap deliberately keeps structure
  dominant over activity (a busy multisig should still beat an idle single key). There is no
  external framework these specific integers are anchored to — they are open to challenge.

---

#### 4. `liquiditySafety` — free-liquidity depth (weight 0.15)

**What it measures:** the absolute withdrawal/liquidation cushion — how much value could
leave before the pool is drained. Distinct from `utilizationSafety`, which measures
proximity to the _configured cap_ rather than absolute headroom.

**Raw on-chain data (Soroban RPC):** per reserve, `ResData` (`b_supply`, `b_rate`,
`d_supply`, `d_rate`) and `ResConfig` (`decimals`), used to compute `supplied` and
`borrowed` per the totals formula above.

**Formula** — free-liquidity share of the **worst** reserve, over reserves large enough to be
scored (see [The minimum-size filter](#the-minimum-size-filter) below):

```
For each reserve with supplied > 0 that passes the minimum-size filter:
    free = clamp( (supplied − borrowed) / supplied × 100 , 0, 100 )

liquiditySafety = min(free) across all such reserves     # worst reserve wins
```

Edge cases, both → **0**: **no reserve with `supplied > 0`**, and **every reserve excluded by
the minimum-size filter**. A minimum over an empty set is undefined, not the top of the scale
— an unassessable pool is reported as unassessable, the same way §1 treats having nothing to
price. Returning 100 here would publish "maximally safe" derived from no data, which ground
rule 4 forbids. The two are reported with different `detail` strings: "the pool is empty" and
"everything in it is too small to grade" are different findings.

---

#### The minimum-size filter

Applies to **`liquiditySafety` (§4) and `utilizationSafety` (§5) only**, identically for every
protocol.

**The problem it solves.** Both factors select the _worst_ reserve, so a reserve holding
effectively nothing can set a protocol's published number. On the 2026-08-16 Kinetic snapshot a
**$3.00** PYUSD reserve — 0.19% of a $1,571 pool — was the worst reserve on both factors and
set `liquiditySafety` to 34 and `utilizationSafety` to 18. Nobody's capital was meaningfully
exposed to it. That is a misleading number, not a conservative one.

**The rule.** A reserve is scored if **either** test passes, and excluded only when **both**
fail:

| Leg   | Test                                                                | Anchor                                                       |
| ----- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| **A** | `suppliedUsd ≥` the protocol's own declared minimum viable exposure | the protocol's own on-chain parameter, where it declares one |
| **B** | `suppliedUsd ≥` **0.5% of the pool's own total supplied USD**       | none — an unvalidated judgment call (see below)              |

Leg A is per-protocol in exactly the sense §5's `cap` is: the _pattern_ ("grade against a
parameter the protocol set itself") is the invariant, and which parameter it resolves to is a
documented per-protocol fact.

| Protocol / market        | Leg A source                                                                                                                        | Value                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Blend — Fixed V2**     | `PoolConfig.min_collateral`, read live from pool instance storage, denominated in the oracle's base asset (`Other:USD`, 7 decimals) | `50000000` = **$5.00** |
| **Blend — YieldBlox V2** | the same field, read live from **this pool's own** instance storage — read per pool, never inherited from the flagship              | `50000000` = **$5.00** |
| **Kinetic (K2)**         | **none — K2 declares no minimum-exposure parameter on chain.** Leg B alone applies.                                                 | n/a                    |

Both live Blend pools happen to declare the same floor. That is a coincidence of their
configuration, not a property of the adapter: leg A is resolved from whichever pool an
adapter instance was pointed at, and a Blend pool declaring a different `min_collateral`
would be graded against its own.

`min_collateral` is Blend's _own_ dust guard: the smallest collateral a position may hold and
still borrow, set where liquidating a position stops being economically worthwhile. A reserve
whose entire supplied value sits below it cannot host even one position the protocol itself
considers viable. That is the same question this filter asks, which is why it is borrowed
rather than invented.

**K2's absence is verified, not assumed.** The router's instance storage and every reserve's
`ReserveConfiguration` bitmap were read looking for an equivalent. What K2 exposes is `MINSWAP`
(a slippage bound), `FLPREMMAX`, `HFLIQTH`/`PLIQHF` (health-factor lines) and a supply/borrow
cap pair in `data_high` — all maxima or unrelated. If K2 ever ships a minimum, leg A turns on
for it with no rule change.

**Why both legs, and not one.** Each covers a failure the other has, both demonstrated on live
data:

- **Absolute-only breaks a small pool.** Any floor sized for a real market ($1k, $10k) excludes
  _all four_ of K2's reserves — its entire pool is ~$1,500. Both factors would go to
  cannot-assess and K2's score would **drop**, from 28 to 15. Worse than the problem.
- **Relative-only breaks a large pool.** 0.5% of Blend's $186M is ~$928,000, so a reserve
  holding half a million dollars of real capital would be silently dropped. Leg A keeps it at
  $5.

> **The 0.5% in leg B is an unvalidated judgment call.** There is no external or on-chain
> framework fixing it; with `STALE_CEILING_SECONDS` (§2) it is one of only two Stenion-chosen
> constants left in the continuous factors, and it is open to challenge like any threshold here.
>
> It is deliberately set at the **low** end of the band that works, because the two directions
> of error are not symmetric. Too low leaves a dust reserve in, which reports a misleading
> number. Too high excludes a small but genuinely-used reserve, which **hides real risk** —
> strictly worse. 0.25% would have flipped on the live K2 reserve between two consecutive days
> ($3.00, then $4.00, against a $3.85 line); 0.5% clears it both times with margin.

**Excluded reserves are disclosed, never silently dropped.** Each affected factor publishes an
`excludedReserves` component with a `null` value — the same "measured, shown, deliberately not
graded" form as §2c/§2d — naming each excluded reserve, its supplied USD, its share of the pool,
and **the score it would have contributed**. A reader can therefore see the number the filter
suppressed and disagree with the exclusion, instead of never learning of it.

> **⚠️ This filter gives §4 and §5 an oracle dependency they did not previously have.** Both are
> otherwise pure balance ratios that need no price at all; the filter is USD-denominated.
> **When no reserve can be priced, the filter does not run and every reserve is scored** — the
> two factors degrade to exactly their pre-filter behaviour rather than refusing to score. That
> is the right fallback, but it means a pool's liquidity and utilization numbers mean something
> slightly different during an oracle outage: they are unfiltered, and a dust reserve can bind
> them again. An individual unpriced reserve is likewise kept, never read as worthless —
> "could not measure" is not "empty".

**The filter cannot empty the scored set on a real pool.** Shares sum to 1, so the largest
reserve always holds at least `1/n`, which clears 0.5% for any `n ≤ 200`. The all-excluded
branch above is therefore unreachable in practice — it is implemented and tested synthetically
anyway, because that is precisely where a "cannot assess" could quietly become a 100 again.

> **⚠️ OPEN QUESTION, raised by the YieldBlox pool and deliberately not resolved here.** The two
> legs are OR'd, so leg A can override leg B — and on a small Blend pool it overrides it almost
> entirely. YieldBlox holds ~$1.28M, putting leg B's 0.5% line at ~$6,396; **six of its eight
> reserves fall below that line** ($39.47 to $4,243.73) and every one is scored anyway, because
> Blend's $5 `min_collateral` passes for all of them. The result is that `liquiditySafety` (10)
> and `utilizationSafety` (0) are both set by a reserve holding **$1,096.85 — 0.086% of the
> pool**.
>
> That is the shape of the problem this filter was added for. On Blend's Fixed pool it is
> invisible: leg A is a documented no-op there, because the smallest reserve holds $3.4M. On a
> pool three orders of magnitude smaller, the same $5 floor is doing all the work and leg B's
> guard never engages.
>
> **It is recorded, not fixed.** Changing it — sizing leg A relative to the pool, capping it,
> or making the legs AND rather than OR below some pool size — moves published numbers on a
> live entry, and is a threshold change under the same review bar as any other (see
> [Disputing or changing a threshold](publishing-rules.md#disputing-or-changing-a-threshold)). It is equally
> arguable that the current behaviour is correct: `min_collateral` is the pool's own statement
> of the smallest position worth liquidating, and a $1,097 reserve at 90% utilization is a real
> reserve with real depositors, not the $3.00 dust the filter was built to exclude. What is not
> defensible is leaving the tension undocumented, which is why it is written down here.

**Why this shape / this anchor:** `(supplied − borrowed) / supplied` is `1 − utilization`,
i.e. the fraction of supplied value that is actually withdrawable _right now_. That is a
direct on-chain quantity, not a modeled one — the anchor is the pool's own balances. Taking
the **worst reserve** rather than a pool-wide average is deliberate: liquidity crises happen
in the single most-drained reserve, and averaging would hide it. The mapping (free % → score
%) is 1:1 and intentionally has no free parameters to tune, so there is nothing arbitrary to
anchor.

---

#### The market-size floor

The [minimum-size filter](#the-minimum-size-filter) one level up. That filter asks whether a
_reserve_ is big enough for its number to mean anything; this asks the same of a whole
**market**. They are two halves of one idea — a size below which a published number stops
carrying information — and they are written together so neither looks like an afterthought.

**The problem it solves.** K2 deploys its markets as separate router contracts running
identical code, the same way Blend's factory deploys pools. Three are live on mainnet as of
2026-08-20, and two of them are empty:

| Market                                | Reserves                  | Total priced supplied value |
| ------------------------------------- | ------------------------- | --------------------------- |
| K2 primary (`CCTUJZLY…`)              | USDC, XLM, PYUSD, SolvBTC | **$1,781**                  |
| K2 SolvBTC/xSolvBTC iso (`CCGXGXIL…`) | SolvBTC, xSolvBTC         | **$3.62**                   |
| K2 Earn / earnUSDC (`CDWPVHKB…`)      | USDC, earnUSDC            | **$0.00**                   |

Point the shipped rulebook at either of the bottom two and it does not fail — it returns a
**score**. Every factor falls to its can't-assess branch, and every one of those branches is
**0**. So a market holding nothing publishes 0, in the danger band, reading "this is
dangerous" to anyone scanning the registry when what is true is "there is nothing in here."
That is the same misleading-number failure §4 and §5 were filtered for, one level up, and it
is worse at this level: a filtered reserve still leaves a scored market with a disclosure
beside it, whereas this is the market's entire published number.

**The rule.** A market is scorable only if it can hold **at least one position the protocol
itself considers viable**:

| Leg   | Test                                                                                            | Anchor                                                       |
| ----- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **A** | total priced supplied USD `≥` the protocol's own declared minimum viable position               | the protocol's own on-chain parameter, where it declares one |
| **B** | **none — no relative leg exists at this scale.** See below; this is a real gap, not an omission | —                                                            |

| Protocol / market      | Leg A source                                                                                                                  | Value                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Blend** (both pools) | `PoolConfig.min_collateral`, read per pool                                                                                    | `50000000` = **$5.00** |
| **Kinetic (K2)**       | **none declared on chain** — the $5.00 above is borrowed as an analogue, and is a flagged judgment call for K2, not an anchor | **$5.00**              |

This is the same parameter, and the same reasoning, that §4/§5's leg A already uses:
`min_collateral` is the protocol's own statement of the smallest collateral a position may
hold and still borrow. A market whose **entire** supplied value sits below it cannot host even
one position the protocol itself would let borrow. There is nothing there to assess, and the
number is not a measurement of risk — it is a measurement of absence.

Against the table above: K2 Earn fails on total supplied value of exactly zero. The
SolvBTC/xSolvBTC market fails at $3.62. K2's primary market clears by three orders of
magnitude, as do both Blend pools.

**Why there is no relative leg, unlike §4/§5.** The reserve filter has two legs because each
covers a failure the other has. No such second leg exists here. Relative to the market's own
reserves is what §4 and §5 already do. Relative to the other markets in the registry would
make one market's listing depend on **another market's** size — a market could become
unlistable because a different one grew, while nothing about its own on-chain state changed.
A rule about a market's own data must not have that property. So this floor is absolute-only,
which is precisely the shape §4/§5 rejected as insufficient on its own, and that limitation is
the reason it is set low rather than at a number that sounds meaningful.

> **The direction of error is deliberately toward keeping markets in.** Two reasons, and the
> asymmetry is not the same one §4/§5 reasoned about:
>
> - **Raising it buys nothing against the failure it exists for.** A score computed from no
>   data is fully prevented at $5. Every dollar above that excludes markets that genuinely
>   _can_ be assessed, in exchange for nothing.
> - **Excluding a market is a much stronger action than excluding a reserve.** A filtered
>   reserve leaves a scored market and a published disclosure naming what was suppressed. An
>   excluded market has no entry at all — no score, no factors, no disclosure, nothing for a
>   reader to disagree with. §4/§5 already call hiding a small-but-real reserve "strictly
>   worse" than leaving a dust one in; at market scale that error hides everything at once.

**What this floor guarantees — and what it does not.** It guarantees only that a published
number was computed from **something rather than nothing**. It is emphatically **not** a
quality bar: a market holding $50 clears it, and its score would still be close to
meaningless. Saying so plainly matters more than the threshold does, because a floor that
sounds like a meaningfulness test while being a scorability test is worse than no floor.

> **⚠️ A separate question this deliberately does NOT answer: is a scorable market worth
> listing?** K2's primary market is a registered, ranked entry holding **$1,781**. It clears
> this floor by three orders of magnitude and is still small enough that a reasonable person
> could ask whether ranking it beside a $185M pool conveys what the ranking appears to convey.
>
> That is a **curation** question — what belongs in the registry — not a question about whether
> a number can be computed, and answering it with a threshold in this document would dress an
> editorial judgment as a measurement. It also has a consequence a scoring threshold does not:
> any such bar set above $1,781 would **delist a live entry**, breaking a public URL
> (`/protocol/kinetic`) and orphaning a published history. Flagged here, resolved nowhere yet.

> **⚠️ An excluded market has NO score. It does not have a score of zero.** This is the
> market-level form of the warning under §4/§5 about "cannot assess" quietly becoming a number
> again, and it is the whole reason the floor is written down.
>
> - **It must mean:** the market is not registered. If a registered market later falls below
>   the floor, its published `safetyScore` must become **`null`** — the never-scored
>   representation the API already defines and the dashboard already renders as an em dash.
> - **It must never mean:** a score of **0** (which renders in the danger band and says the
>   opposite of what is true), a score of **100**, or — the live hazard — **registering the
>   market and letting the five factors fall to their can't-assess branches**, which is exactly
>   what the shipped code does today and exactly how an empty market publishes a 0.
>
> **Enforcement, stated honestly: this floor is currently enforced only by the decision not to
> register such a market.** No code path implements it. Nothing in an adapter, the indexer or
> the store can express "this market is not scorable" as distinct from "this market scored 0",
> so a registered market that drained below the floor would keep publishing a number today.
> Closing that needs a distinct not-scorable outcome through `Adapter` and `RunRecord`; it is
> filed in [`ROADMAP.md`](../ROADMAP.md) rather than implied to exist here.

**This does not bump lending's methodology version.** It moves no published number: every market
Stenion currently scores — both Blend pools and K2's primary market — clears the floor, so no
stored score is computed differently and none becomes non-comparable. It documents a
precondition on what gets scored at all, which is additive.

---

#### 5. `utilizationSafety` — headroom below the configured cap (weight 0.20)

**What it measures:** how close live utilization is to the protocol's own on-chain
utilization stress line — the point the protocol itself defines as "borrowing should stop
growing here." Approaching it is a concrete, protocol-defined stress signal.

**Formula** — headroom below the protocol's utilization line, worst reserve:

```
For each reserve with supplied > 0 and cap > 0 that passes the minimum-size filter:
    util = borrowed / supplied            # computed LIVE from balances, not a config field
    headroom = clamp( (cap − util) / cap × 100 , 0, 100 )

utilizationSafety = min(headroom) across all such reserves    # worst reserve wins
```

The [minimum-size filter](#the-minimum-size-filter) is §4's, unchanged and applied identically
here — one rule, both factors.

Edge cases, all → **0**, for the same reason as §4: **no reserve with `supplied > 0`**, **every
reserve excluded by the minimum-size filter**, and **no reserve with `cap > 0`**. The second is the sharper one — reserves can hold real debt while
declaring no utilization ceiling at all, and grading that as full headroom would measure distance
to a line nobody set. The two are reported with different `detail` strings, since "the pool is
empty" and "the pool declares no ceiling" are different findings.

**`cap` is per-protocol — it is always the protocol's own on-chain utilization parameter,
never a Stenion constant.** Which parameter that resolves to:

| Protocol         | `cap` source                                                                              | Meaning of the line                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Blend**        | per-reserve `max_util` (`ResData`/`ResConfig`, 7-dec fixed point → `max_util / SCALAR_7`) | a **hard throttle** — Blend throttles and eventually pauses borrowing as utilization nears `max_util`                |
| **Kinetic (K2)** | `OPTIMAL_UTILIZATION_RATE` = **0.80** (`contracts/shared/src/constants.rs`)               | the interest-rate **kink** — past 80% util, K2's Aave-V3 rate curve steepens sharply to discourage further borrowing |

**Why this anchor (the strongest in the set):** the threshold is **not a Stenion constant at
all — it is the protocol's own on-chain parameter.** The formula grades each reserve against
the exact line the protocol configured, so the "danger line" is set by the protocol, not by
us. This is the pattern every continuous factor should aspire to. Worst-reserve selection is
deliberate for the same reason as liquidity — the binding constraint is the single reserve
closest to its line.

> **⚠️ Two honest caveats on the K2 anchor (flagged, not hidden):**
>
> 1. K2's kink is a **rate inflection, not a hard pause** — past 80% util K2 keeps lending
>    (just expensively), whereas Blend's `max_util` is an actual throttle. The two lines mean
>    slightly different things; the formula treats "distance to the protocol's declared
>    utilization ceiling" uniformly, which is the intended abstraction.
> 2. `OPTIMAL_UTILIZATION_RATE` is read as K2's **global default (0.80)**. Per-reserve kink
>    overrides, if any, live in K2's `interest_rate` strategy contract, which is **out of
>    scope in the audited source** (`code-423n4/2026-04-k2`) and so not independently
>    verifiable — if a reserve overrides the default this factor uses the documented 80%, not
>    that reserve's exact kink. Revisit if K2 exposes a readable per-reserve optimal-util.

---
