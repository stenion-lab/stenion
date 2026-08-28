> ## ⚠️ Target the `dev` branch — not `main`
>
> `main` is what Vercel auto-deploys, so a PR merged there goes straight to production.
> All contributions land on `dev` first. If the base branch above says `main`, change it
> to `dev` before you submit — use **Edit** next to the PR title.

## What this changes

<!-- One or two sentences. Link the issue it closes, if there is one. -->

## Verification

<!--
For an adapter or any scoring change: what you ran against live mainnet, what the output was,
and why those numbers are plausible (a stablecoin ~$1.00, XLM its real price, a sensible
utilization percentage). Paste the output.
-->

## Checklist

- [ ] **Base branch is `dev`**, not `main`.
- [ ] `pnpm format`, `pnpm build`, `pnpm lint`, `pnpm typecheck` all pass from the repo root.
- [ ] Every on-chain method/field name is confirmed against the protocol's audited source or SDK —
      linked above, not guessed.
- [ ] All five `*Safety` factors are implemented per `methodology/` (or `null` with a real
      reason), each with a meaningful `detail` string.
- [ ] No fabricated numbers — a factor without real data uses a clearly-flagged neutral baseline.
- [ ] `methodology/` is updated in this PR if a formula, threshold, weight, or per-protocol
      anchoring fact changed. Code and methodology are not allowed to drift.
- [ ] Any new dependency is called out explicitly above, with justification.
