## Operational state is published, never scored

**The decision, up front: pause/frozen state is a published field beside the score, and it is
deliberately not a factor, not a multiplier, and not any input to a number.** It was decided
this way on 2026-08-25 (issue #15) after reading both protocols' contracts, and this section
exists so it is not re-litigated by the next person who notices a paused pool with an unchanged
score.

Both adapters had always read a pause signal — Blend's `PoolConfig.status`, K2's
`router.is_paused()` — and neither had ever used it. That could not stay true indefinitely:
every adapter written while it stayed unresolved would have to be retrofitted later.

### What each protocol actually means by "paused"

Read from the contracts, not from the documentation — the published docs name Blend's states but
publish no numeric mapping, and the mapping circulating in search results is partial and partly
wrong.

**Blend V2** gates in `require_action_allowed` (`pool/src/pool/pool.rs`), which is the entire
rule:

```rust
if (status > 1 && (action == 4 || action == 9))     // Borrow, DeleteLiquidationAuction
|| (status > 3 && (action == 2 || action == 0))     // SupplyCollateral, Supply
{ panic!(InvalidPoolStatus) }
```

`RequestType` numbering is from `pool/src/pool/actions.rs`; the setter paths are
`execute_set_pool_status` (admin) and `execute_update_pool_status` (permissionless) in
`pool/src/pool/status.rs`.

| `status` | Blend's name | Borrow | Supply | Withdraw / Repay / liquidation fills | Who can set it                                                                   |
| -------- | ------------ | ------ | ------ | ------------------------------------ | -------------------------------------------------------------------------------- |
| 0        | Admin Active | yes    | yes    | yes                                  | admin only (needs the backstop threshold met and Q4W < 50%)                      |
| 1        | Active       | yes    | yes    | yes                                  | permissionless only (backstop healthy)                                           |
| 2        | Admin On-Ice | **no** | yes    | yes                                  | admin only                                                                       |
| 3        | On-Ice       | **no** | yes    | yes                                  | **either** — admin, or automatically at Q4W ≥ 30% / below the backstop threshold |
| 4        | Admin Frozen | **no** | **no** | yes                                  | admin only; supersedes the backstop, which cannot move it                        |
| 5        | Frozen       | **no** | **no** | yes                                  | permissionless only — automatically at Q4W ≥ 60% (≥ 75% from status 2)           |
| 6        | Setup        | **no** | **no** | yes                                  | initialization only; supersedes everything                                       |

**Blend never blocks a withdrawal or a repayment at any status.** The only user-facing action
blocked below the supply threshold is _cancelling_ an in-flight liquidation auction, which is a
wind-down-safely posture rather than a restriction on depositors.

**K2 (Kinetic)** has two layers. `storage::is_paused` is checked at the top of `validate_supply`,
`validate_withdraw`, `validate_borrow`, `validate_repay` and `validate_liquidation`, and again in
the flash-loan and two-step liquidation entry points — so **a paused K2 halts everything,
withdrawals included, and deposited capital cannot leave.** Separately, each reserve carries its
own gating flags in the `ReserveConfiguration` bitmap it already publishes its decimals in
(`contracts/shared/src/utils.rs`, bits 50–53): `active`, `frozen`, `borrowing_enabled`, `paused`.
A cleared `active` or a set `paused` blocks every operation on that reserve; `frozen` blocks
supplying and borrowing while leaving withdrawals open; a cleared `borrowing_enabled` blocks only
borrowing.

### The shared representation

Because those two vocabularies do not map onto each other, the published state is named by **what
is blocked**, which is the one axis on which the protocols are genuinely comparable:

| Level               | Meaning                                                        | Blend         | K2                                                  |
| ------------------- | -------------------------------------------------------------- | ------------- | --------------------------------------------------- |
| `active`            | nothing restricted                                             | status 0, 1   | not paused, every reserve open                      |
| `borrowingDisabled` | cannot borrow; supply and exit both work                       | status 2, 3   | reserve `borrowing_enabled = false`                 |
| `entryDisabled`     | cannot borrow or supply; **existing positions can still exit** | status 4, 5   | reserve `frozen`                                    |
| `exitDisabled`      | **cannot withdraw** — capital cannot leave                     | _unreachable_ | `router.is_paused()`, or reserve `paused`/`!active` |
| `notOperational`    | the market was never opened                                    | status 6      | _no analogue_                                       |

Where a protocol gates per reserve, the **most restricted** reading is published — the same
worst-reserve convention §2, §4 and §5 use, for the same reason. Alongside the level: the
protocol's own reading verbatim (`PoolConfig.status = 4`), the exact operations blocked, when it
was read, and whether the value is one only an admin could have set. That last field is
`indeterminate` for Blend's status 3, because `execute_set_pool_status` accepts it too — reading
even/odd as "who did this" would be right six times in seven and wrong on the one value where it
matters.

`notOperational` is reachable in principle and not in practice: every Setup pool in the
2026-08-22 factory survey held exactly $0.00 and is already excluded by
[the market-size floor](lending.md#the-market-size-floor).

### Why it is not scored

Three options were weighed — a sixth factor, a multiplier on the overall score, and a published
flag. The flag was chosen, on four grounds:

1. **No on-chain datum resolves the ambiguity.** A pause can be an admin containing a threat or an
   admin abandoning a market, and neither protocol's state carries a reason. Distinguishing them
   needs off-chain announcements, which adapters may not read. A "context-dependent" factor with
   nothing to condition on is a flat penalty in costume, and any magnitude for it would be
   invented — this document's standard is that a threshold is anchored to a protocol's own
   parameter or labelled an unvalidated judgment call, and there is no anchor here at all.
2. **The one axis clean enough to score does not exist on both protocols.** The strongest scored
   variant was not a sixth factor but folding `exitDisabled` into
   [`liquiditySafety`](lending.md#4-liquiditysafety--free-liquidity-depth-weight-015): that factor is
   _defined_ as the withdrawal cushion, and a cushion you are contractually barred from drawing on
   is zero by definition rather than by judgment — no invented magnitude required. It was rejected
   anyway, because `exitDisabled` is structurally unreachable on Blend. A rule that is live code on
   one adapter and dead code on the other satisfies ground rule 1 in form only. **Recorded here so
   it is not re-proposed as the obvious fix.**
3. **A scored rule would have shipped untested.** Every registered market was fully operational
   when this landed — Blend status 1, YieldBlox status 0, K2 unpaused with all four reserves open
   — so the before/after comparison a scored change requires would have compared each number
   against itself. What a factor _would_ have done is worse than nothing: "not paused" scores 100,
   so a sixth factor at weight `w` raises every active protocol's score by `(100 − score) × w`,
   handing Blend, K2 and YieldBlox 5–11 free points for the ordinary state. That is the
   five-way redistribution [the weights note](lending.md#factor-weights) already declined once.
4. **A multiplier would break the score model.** `safetyScore` is one published line, and this
   document's worked example spells the arithmetic out. A client that fetches `factors` and
   reproduces the score would stop getting the same number — a verifiability platform whose
   published factors no longer reconstruct its published score has traded away more than the
   change buys.

There is also no decay problem, which both scored options have and neither answers: snapping back
on unpause puts a step in the history chart that is not a change in risk, and a cooldown invents a
time constant from nothing. A published state is a live reading — correct at every instant, with
nothing to recover from.

**What this costs, stated plainly.** A reader who looks only at the number is not protected by the
flag. That is why the flag is a first-class field on both the leaderboard and the detail response
rather than a footnote, and is rendered beside the name and score everywhere either appears — the
same treatment, for the same reason, as `deployedOn`. If it ever stops being rendered there, the
decision not to score has quietly become a decision to hide.

**No version bump.** Nothing here changes a formula, a threshold or a weight, and no stored score
moves, so lending's methodology version stays at 1. That the state cannot reach a factor is enforced
rather than intended: `adapters/blend/score.test.ts` and `adapters/kinetic/score.test.ts` each
assert a
byte-identical factor map across every restricted state their protocol can be in. If pause state
ever moves a number, those tests fail before the change ships.

---

## Findings are published, not scored — and how they must be written

Verifiable observations we can't or won't grade go in the protocol page's Findings section
(`dashboard/app/lib/protocol-notes.ts`), never into a factor. **Nothing there is read by any
scoring path**, and a note — favourable or not — can never move a number.

**Findings are the STATIC half of ungraded publication.** They are hand-written and reviewed in a
PR, which is right for an observation someone had to go and establish, and wrong for a reading
that changes every five minutes. The live half is
[operational state](#operational-state-is-published-never-scored): measured every cycle, published
as a typed field, and equally never graded. A new ungraded observation belongs in whichever of the
two matches how it is obtained — never in a factor, and never invented as a third mechanism.

**A note must survive the history it was drawn from.** Twice now a Findings note has outlived
the stored runs behind it: once when the development-era history was discarded, and again when
the briefly-live v2 rows were. Score history is not an archive — it is discarded across a
rulebook change and cannot be recomputed, because `risk_scores` keeps only outputs. A note
written as "our history shows X" therefore decays into an unverifiable claim on a page whose
entire pitch is that you don't have to trust us.

So every note citing our own observations follows the same form:

1. **Cite a closed window, with both ends stated.** "Between 2026-08-11 18:16 and 2026-08-18
   15:55 UTC, 1,469 runs" — not "93% of runs", which silently means something different every
   time the cron fires. A reader re-running the query later must be able to tell that a
   different number is a later window, not a contradiction.
2. **Say the counts are a snapshot of that window** and do not update.
3. **Phrase the underlying claim so it stays checkable from chain after the history is gone.**
   Our runs are evidence that a condition _persisted_; the condition itself must be one anyone
   can observe today, directly from the contracts. If the only support for a claim is rows in
   our database, it is not a finding — it is an assertion.
4. **Give the exact verification steps** — contract, method, field, and what to compare against.
   If we can't say how a reader would check it themselves, it doesn't go in.
5. **Claim only what was measured.** Where a sub-signal wasn't recorded separately, say so and
   scope the claim to the runs that carry it, rather than generalising across all of them.

---

## Disputing or changing a threshold

Every number in this document is meant to be challengeable — especially the ones labeled
"unvalidated judgment call." If you believe a threshold, weight, or formula is wrong (including if
you are a protocol being scored):

1. **Open a GitHub issue** against this repository describing the specific threshold/formula
   and why you think it's wrong. Anchor your argument to something external where possible (a
   protocol's own on-chain parameter, a published risk framework, observed data) rather than
   preference.
2. **Or open a pull request** editing this file directly with the proposed change and its
   justification. A change to `methodology/` **must** be accompanied by the matching change
   to the adapter code (and vice versa) — the two are not allowed to drift.
3. **Maintainer review is required, at the same bar as adapter code changes.** A methodology
   change affects every protocol's number, so it is reviewed at least as carefully as a code
   change — not merged on preference, and never merged because a scored party requested it.
   Per the ground rules above, **no change is ever accepted in exchange for payment.**

Changes that alter what a factor _means_ (e.g. adding or removing a factor) are breaking
changes to the shared taxonomy in `core/src/types.ts` and are held to a higher bar again —
they affect every adapter at once.
