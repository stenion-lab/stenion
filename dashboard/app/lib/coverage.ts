// Protocols and markets Stenion has assessed and does NOT score.
//
// WHAT THIS IS: the published form of a coverage decision. The registry shows
// what we score; without this, everything we investigated and declined is just
// absence — and absence tells a reader nothing. A stated reason tells them
// something true: that we looked, what we found, and how they can check it.
//
// WHAT THIS IS NOT: a score, a ranking, or a criticism. Nothing here is read by
// any scoring path, nothing here has a number, and an entry appearing here says
// something about Stenion's coverage rather than about the protocol. Same wall
// as PROTOCOL_NOTES and the payment rule — see CLAUDE.md.
//
// WHY A STATIC MODULE AND NOT THE `protocols` TABLE. Three reasons, the first
// decisive:
//
//  1. A `protocols` row with no `risk_scores` history ALREADY renders as
//     "never run — Stenion has not completed a scoring run for this protocol
//     yet" (see freshness() in ./format.ts). That is the our-pipeline-has-a-gap
//     state. Putting a deliberate decision in the same place collides it with
//     the very state this feature exists to separate.
//  2. Every row in `protocols` is written by upsertProtocol from adapter
//     metadata on every indexer cycle. These entries have no adapter, so
//     nothing would write them and nothing would keep them in step.
//  3. It would put unscored ids into GET /api/v1/protocols, which consumers
//     parse as the ranked leaderboard. A wallet rendering `safetyScore: null`
//     for Templar is worse than Templar's absence. Publishing this is a
//     separate additive endpoint (/api/v1/coverage), filed rather than
//     half-shipped.
//
// It is deliberately unrelated to the not-scorable RUN OUTCOME filed in
// ROADMAP.md. That is a different problem — a REGISTERED market that drains
// below the floor — and it needs a third RunRecord status, which is a breaking
// v2 change. These entries were never registered at all.
//
// THIS MODULE IS A LEAF: no imports, by design, so it stays trivially testable
// under Node's type-stripping loader (CLAUDE.md, "A tested module should be a
// leaf").
//
// BAR FOR ADDING ONE — the same bar as PROTOCOL_NOTES, plus a date rule:
//   - independently verifiable, and `verify` says exactly how. If you cannot
//     write that sentence, the entry does not go in.
//   - stated neutrally, explicit about what is verified versus inferred.
//   - `asOf` on any reason resting on a MEASUREMENT. "$3.62" is a reading, not
//     a property; an undated balance indexed by a search engine is a factual
//     assertion we would be making indefinitely.
//   - sourced from an investigation actually recorded in this repo. Figures
//     from a third-party aggregator that were never checked against contracts
//     are not a source — that rule is why Peridot and Slender are absent rather
//     than listed as dust.
//
// RECIPROCAL RULE: a protocol that becomes scorable loses its entry here in the
// SAME PR that registers it. The registry also filters live against the fetched
// leaderboard (see registry/page.tsx), so a forgotten entry self-heals rather
// than double-listing — but the cleanup is still part of that PR.

/**
 * Why an entry is not scored. Each member must correspond to a genuinely
 * different reason, because collapsing them into one "not scored" state loses
 * the information that makes publishing this worthwhile.
 *
 * Members are added when a real case appears, not in advance. `not-independent`
 * is deliberately absent: since multi-pool Blend targeting landed, a market
 * running another protocol's contracts is REGISTERED and SCORED carrying a
 * `deployedOn` label (the YieldBlox pool), so it is no longer a reason to be
 * unscored. A `deprecated` member is absent for the same reason — no evidenced
 * case exists today.
 *
 * THESE STRINGS ARE A PUBLIC API CONTRACT. GET /api/v1/coverage publishes this
 * union raw — the value a client reads is the member name written here, not its
 * COVERAGE_STATUS_META display text — and API.md commits to that in the v1
 * terms: adding a member is additive and stays on `v1`, so consumers are told to
 * tolerate a status they don't recognise. RENAMING OR REMOVING ONE IS BREAKING
 * AND NEEDS A `v2`. That rules out tidying a member name for readability, which
 * would otherwise look like a free local edit.
 */
export type CoverageStatus =
  /** Lending state lives on another chain; reading it would break the trustless-Stellar rule. */
  | 'off-chain-state'
  /** Scorable in principle, but holds too little for a number to carry information. */
  | 'below-size-floor'
  /**
   * The market's oracle publishes no staleness tolerance and no deviation
   * bound, so `oracleSafety` has nothing to grade against.
   *
   * METHODOLOGY.md §2e, "The oracle-legibility precondition". This is NOT "we
   * could not read the oracle" — every one of these answers `decimals()` and
   * `lastprice()`, and the other four factors compute normally from them. What
   * is absent is the metadata §2 anchors to: SEP-40 defines no such fields, and
   * the nearest candidate (`resolution()`, a publish interval) demonstrably
   * fabricates a `priceFreshness` of 100 on a price that is hours stale.
   *
   * Deliberately its own status rather than folded into `below-size-floor`.
   * Orbit holds real money; the reason it is unscored has nothing to do with
   * its size, and collapsing the two would tell a reader the wrong thing about
   * both. It is also the one status here that can be **undone by the protocol**:
   * an oracle that starts publishing the two parameters makes the pool scorable
   * with no rule change at all.
   */
  | 'oracle-not-gradable'
  /** Not live on Stellar mainnet yet, so there is nothing to read. */
  | 'awaiting-mainnet'
  /**
   * No rulebook is published for this protocol's category. A category is scored
   * on its own factors under its own weights, and one that has none has nothing
   * to be scored against.
   *
   * DELIBERATELY EMPTY AT LAUNCH, AND STILL EMPTY. The ecosystem protocols this
   * would cover (Soroswap, FxDAO, DeFindex and the rest) carry a weaker claim
   * than the entries below: we categorised them from their own public
   * descriptions and never read their contracts. Several such entries beside
   * four real investigations would let the weaker claim free-ride on the
   * stronger one. They arrive when the category expansion in ROADMAP.md is
   * genuinely underway, at which point "not in scope yet" comes with taxonomy
   * work to point at. Kept in the union so that is a data change, not a
   * refactor.
   *
   * AQUARIUS WAS ON THAT LIST AND HAS BEEN REMOVED (#104). It can never land in
   * this status again: `dex` has a published rulebook and one Aquarius market is
   * scored under it, so "no taxonomy exists for this category" is now false of
   * it. Its unregistered markets are `awaiting-capacity` below, which is a
   * different statement — the rules exist and the slots do not. Leaving the name
   * here would have described a state the codebase can no longer be in.
   */
  | 'out-of-category'
  /**
   * Scorable under a published rulebook, and unregistered because the indexer
   * has no target slot left.
   *
   * THE ONLY MEMBER HERE THAT IS A STATEMENT ABOUT STENION RATHER THAN ABOUT THE
   * MARKET (#104), and it is spelled as one. Every other status says something
   * we read on chain and could not grade. This one says the opposite: the
   * rulebook applies, the reads work, the number would be as true of these
   * markets as of the one that is scored — and a scoring cycle runs inside
   * Vercel Hobby's 60s `maxDuration`, which at the shipped attempt timeout and
   * concurrency allows five targets in total.
   *
   * Deliberately NOT folded into `below-size-floor`, which would be a lie twice
   * over: `dex` has no size floor (methodology/dex.md, "Size floor: none, and
   * none pending") because neither of its factors is size-sensitive, and the
   * unregistered markets include the largest pools in the protocol.
   *
   * It is a state that ends by someone buying capacity or lowering the per-target
   * cost, not by the protocol changing anything — which is why the copy must not
   * imply a finding about the markets it lists.
   *
   * THE WAY OUT IS TRACKED IN ROADMAP.md, not here. All three scheduling dials
   * are at their limits (budget at 50s against a 60s hard ceiling, concurrency
   * pinned at 1 by the RPC 429 incident, attempt timeout already lowered once),
   * so nothing can be registered — of any category — until sharding or staggered
   * scheduling lands. This status is what that looks like from the registry;
   * ROADMAP.md's blocker is what it looks like as work.
   */
  | 'awaiting-capacity';

export interface CoverageEntry {
  /** slug — the anchor id on /registry, and the key deduped against the live leaderboard */
  id: string;
  /** display name, as the protocol writes it */
  name: string;
  status: CoverageStatus;
  /**
   * Root-relative path to a mark this app hosts under `public/`, or null.
   *
   * Same rules as a scored entry (ProtocolMetadata.logo): self-hosted only,
   * never a hotlink, and null is a designed state — <ProtocolLogo> draws an
   * initials tile. An unscored entry carries a mark for the same reason a
   * scored one does: it is a real protocol we assessed, and the point of
   * listing it is that a reader recognises it.
   */
  logo: string | null;
  /**
   * The protocol's own site/docs. Null where this repo records no verified URL
   * — a guessed domain beside a protocol's name is worse than no link, because
   * it could point at a squatter.
   */
  links: { site: string | null; docs: string | null };
  /**
   * The contract we read, when we read one and recorded it in full.
   *
   * Null does real work here: it means we have no full address to link, so no
   * explorer link is offered and none is implied. Both K2 markets below are
   * recorded in this repo only in truncated form (`CCGXGXIL…`), so they carry
   * null and their `verify` gives the derivation path instead — which is how
   * the address was obtained in the first place.
   */
  contractId: string | null;
  /**
   * One sentence, for the registry row — the whole of what a scanner gets.
   *
   * Separate from `reason[0]` rather than derived from it, because deriving it
   * means truncating, and a coverage reason cut mid-sentence is worse than no
   * sentence at all. This is also the text that has to survive find-in-page on
   * /registry, so it is server-rendered on the row and never deferred to the
   * detail page.
   *
   * WRITTEN WITHOUT A FIGURE, deliberately. `asOf` dates a measurement, and the
   * row has no room to date one properly; a balance quoted in a summary would
   * be exactly the standing undated claim the date rule exists to stop. The
   * numbers live in `reason`, on the detail page, beside their date.
   */
  summary: string;
  /** Protocol-specific prose, one paragraph per element. Never a generic label. */
  reason: string[];
  /** How a reader checks this themselves. Required — see the bar above. */
  verify: string;
  /**
   * ISO date (YYYY-MM-DD) the measurement behind `reason` was taken. Required
   * for `below-size-floor`; null when the reason rests on structure rather than
   * on a reading, or when no dated check is on record.
   */
  asOf: string | null;
}

/**
 * The deliberately-versioned public shape for GET /api/v1/coverage.
 *
 * Keep this explicit even while it matches CoverageEntry: adding an internal
 * field to the dashboard model must not silently add it to a public API. All
 * measured values stay inside explanatory strings and `asOf`; this contract
 * contains no JSON number and no score-shaped field.
 */
export type ApiCoverageEntry = Pick<
  CoverageEntry,
  | 'id'
  | 'name'
  | 'status'
  | 'logo'
  | 'links'
  | 'contractId'
  | 'summary'
  | 'reason'
  | 'verify'
  | 'asOf'
>;

/**
 * Heading and framing per status. `chip` is what stands where a scored row has
 * its number, so it must read as a coverage statement in isolation — never as a
 * grade, and never with a numeral in it.
 */
export const COVERAGE_STATUS_META: Record<
  CoverageStatus,
  { heading: string; chip: string; blurb: string }
> = {
  'off-chain-state': {
    heading: 'Lending state is not on Stellar',
    chip: 'not natively Soroban',
    blurb:
      'Stenion’s adapters read trustless Stellar infrastructure — Soroban RPC and Horizon — and nothing else. A protocol whose reserves and positions live on another chain cannot be scored without reading that chain, which would change what the score means for every protocol.',
  },
  'below-size-floor': {
    heading: 'Below the market-size floor',
    chip: 'too small to score',
    blurb:
      'These markets can be read; there is just almost nothing in them. Scored anyway, every factor would fall to its can’t-assess branch and publish 0 — a number in the danger band, meaning the opposite of what is true. The floor is a precondition on scoring, not a quality bar: it says only that a number was computed from something rather than from nothing.',
  },
  'oracle-not-gradable': {
    heading: 'Oracle publishes nothing to grade price trust against',
    chip: 'oracle not gradable',
    blurb:
      'These markets can be read, and four of the five factors compute normally for them. What their price feeds do not publish is a staleness tolerance or a deviation bound — the two on-chain parameters oracleSafety is anchored to, neither of which SEP-40 defines. Scored anyway, the nearest substitute rates a price that is hours old as perfectly fresh, and dropping the factor instead would rank a market higher for having an oracle we cannot inspect. Not a judgment about these protocols or their oracles: it says only that this particular number has nothing to be computed from.',
  },
  'awaiting-mainnet': {
    heading: 'Not live on Stellar mainnet yet',
    chip: 'nothing to read yet',
    blurb:
      'Known, and on the list to evaluate. There is no mainnet deployment to read, so there is nothing to score — and nothing yet confirmed about whether it would be scorable when there is.',
  },
  'awaiting-capacity': {
    heading: 'Scorable, and waiting on indexer capacity',
    chip: 'no target slot yet',
    blurb:
      'Nothing about these markets stops them being scored. A rulebook covers them, their contracts read normally, and the number would be exactly as true of them as of the market from the same protocol that is scored. What is missing is a slot: one scoring cycle runs inside a serverless function with a hard sixty-second ceiling, and every registered market has to get a full attempt inside it, which caps how many can be indexed at all. This is a statement about Stenion’s capacity and not a finding about these markets — it ends when the capacity changes, and nothing the protocol does affects it.',
  },
  'out-of-category': {
    heading: 'Outside the current scoring category',
    chip: 'no taxonomy yet',
    blurb:
      'Stenion publishes no scoring taxonomy for this protocol’s category yet. Each category is scored on its own factors under its own weights — utilization against a borrow cap means nothing for an AMM — so a category arrives with a rulebook of its own, published in METHODOLOGY.md, rather than with the lending model stretched over it. Nothing here is a judgment about the protocol: it says only that the rules its number would be computed under have not been written.',
  },
};

/**
 * The order statuses render in: investigated-and-decided first, because those
 * entries carry a real contract read behind them; watching-and-waiting after;
 * category scope last. A status with no members renders nothing at all — a
 * heading over an empty group describes members that aren't there.
 */
export const COVERAGE_STATUS_ORDER: readonly CoverageStatus[] = [
  'off-chain-state',
  'oracle-not-gradable',
  'below-size-floor',
  'awaiting-mainnet',
  'awaiting-capacity',
  'out-of-category',
];

export const COVERAGE: readonly CoverageEntry[] = [
  {
    id: 'templar',
    name: 'Templar',
    status: 'off-chain-state',
    // No mark self-hosted, and none borrowed: the initials tile is the designed
    // fallback (see ProtocolLogo).
    logo: null,
    // This repo records no verified URL for Templar. Rather than guess a domain
    // beside their name, both stay null.
    links: { site: null, docs: null },
    contractId: null,
    summary:
      'A NEAR-based protocol whose reserves, balances and positions live on NEAR — the only contract it runs on Soroban is a price oracle.',
    reason: [
      'Templar is a NEAR-based chain-abstraction protocol — it calls its product “Cypher Lending” — and its lending market state lives on NEAR, not on Stellar. Reserves, supply and borrow balances, utilization and collateral positions are all read through NEAR RPC. Stellar’s role is as a wallet and collateral entry point via NEAR’s MPC signing, not as the ledger the lending market runs on.',
      'The only native-Soroban contract Templar ships is a price oracle. That is one of the five factors Stenion scores; the other four are on another chain. An adapter faithful to what Templar actually is would have to read NEAR, and Stenion’s adapters read trustless Stellar infrastructure and nothing else — that rule is the pitch rather than an implementation detail, so bending it for one protocol would quietly change what every other score means.',
      'This is a decision about where the data lives, not a judgment about Templar. It could be represented only if Stenion’s model expanded to read another chain, which ROADMAP.md keeps explicitly out of scope.',
    ],
    verify:
      'Follow Templar’s own documentation for where lending state is held, then confirm it against the chain: the Soroban contract it publishes on Stellar exposes an oracle interface (price reads), with no reserve, supply/borrow or position storage. There is no Soroban contract to call get_reserves_list, or any equivalent, against.',
    // Structural rather than a measurement — and this repo records no date for
    // the investigation, so none is claimed.
    asOf: null,
  },
  {
    id: 'k2-solvbtc-iso',
    name: 'K2 SolvBTC / xSolvBTC market',
    status: 'below-size-floor',
    // K2's own mark. Correct identity rather than borrowed identity: this is a
    // K2-listed market on a K2 router, running K2's code under K2's admin and
    // oracle — unlike the YieldBlox case, where the host protocol's mark would
    // have asserted exactly what the entry denies.
    logo: '/assets/protocols/kinetic.png',
    links: { site: 'https://k2lend.com', docs: 'https://docs.k2lend.com' },
    contractId: null,
    summary:
      'One of K2’s three live market routers, holding too little for a score to measure anything — and not named on K2’s own published contracts page.',
    reason: [
      'K2 runs its markets as separate router contracts rather than as configurations inside one pool, the same way Blend’s factory deploys pools. Three are live on mainnet, all deployed from byte-identical code (wasm df2831cf…), sharing one price oracle, one pool admin and one treasury. Stenion scores the primary market; this is one of the two it does not.',
      'It held $3.62 in total priced supplied value when read. Stenion’s market-size floor asks whether a market can hold at least one position the protocol itself considers viable, anchored to the protocol’s own on-chain minimum — Blend’s min_collateral of $5.00, borrowed here as an analogue because K2 declares none on chain, and flagged in METHODOLOGY.md as a judgment call for K2 rather than an anchor. At $3.62 this market cannot host even one such position.',
      'Worth stating separately, because it is the part that took work: this market is not on K2’s published contracts page. That page lists the xSolvBTC market as a set of reserve token addresses with no router among them, and repeats the primary market’s SolvBTC aToken and debt ledger beside them — which reads as though the market sits inside the primary pool. It does not. The router address was not read from any documentation; it came from the pool_address field in the xSolvBTC aToken’s own instance storage, whose State also names it “K2 Iso Interest Bearing SolvBTC” (kiSolvBTC). Calling get_reserve_data for xSolvBTC on the primary router returns Error(Contract, #24) — it is not a reserve there.',
      'Nothing here says the market is unsafe or that anything is hidden. An empty market is an empty market rather than a defective one, and documentation lagging deployment is ordinary. What is reported is that the market exists, that we found it, and that a number computed from $3.62 would be a measurement of absence rather than of risk.',
    ],
    verify:
      'Read the instance storage of the xSolvBTC aToken (CBMGL7ZL…HGYJ6JALVY) via Soroban RPC getLedgerEntries and take pool_address from its State — that resolves the router (CCGXGXIL…) in full. Call get_reserves_list on it, then total_supply on each aToken and debt ledger for the balances. Compare against the tables at docs.k2lend.com/contracts.',
    asOf: '2026-08-20',
  },
  {
    id: 'k2-earn',
    name: 'K2 Earn (earnUSDC)',
    status: 'below-size-floor',
    logo: '/assets/protocols/kinetic.png',
    links: { site: 'https://k2lend.com', docs: 'https://docs.k2lend.com' },
    contractId: null,
    summary:
      'K2’s third router, operated by Gami/Upshift rather than by K2, and holding nothing at all when we read it.',
    reason: [
      'The third of K2’s three live routers, operated by a third party — Gami/Upshift — rather than by K2 itself. K2 is explicit that the separation is real: “Isolation is enforced at the contract level: collateral and debt in a third-party market cannot be combined with positions in K2’s primary market.”',
      'It held $0.00 in total priced supplied value when read — not a small amount, but nothing at all. It fails the market-size floor outright. Pointing the rulebook at it would not fail: every factor would fall to its can’t-assess branch and the market would publish a score of 0, which renders in the danger band and tells a reader the opposite of what is true.',
      'K2’s own contract table is out of date in the other direction here. It gives the earnUSDC aToken and debt ledger as “TBA” and says they “will be added once deployed.” Both are deployed and wired — the router’s get_reserves_list returns earnUSDC alongside USDC, and get_current_reserve_data resolves an aToken at CCOPG2ZQ… and a debt ledger at CBO4TOFT…. Reported because a reader taking the published list as complete gets a different picture than the chain gives, not as a criticism of the operator.',
      'If it fills, it becomes scorable, and registering it is a config entry rather than an adapter: KineticAdapter already takes a routerId, exactly as BlendAdapter took a poolId before multi-pool targeting landed. That generalisation is deliberately not built, because building it now would be dead code guarding an empty list.',
    ],
    verify:
      'Call get_reserves_list on the Earn router (CDWPVHKB…KTPF6TZE) and get_current_reserve_data for each asset, which resolves the aToken and debt ledger addresses; read total_supply on each for the balances, and compare the resolved aToken against the “TBA” row at docs.k2lend.com/third-party-markets/contract-addresses.',
    asOf: '2026-08-20',
  },
  // ---------------------------------------------------------------------------
  // The four non-aggregator Blend V2 markets.
  //
  // All four run Blend's pool wasm (a41fc53d…) and would be ordinary BLEND_POOLS
  // config entries but for their oracles. Each was read on 2026-08-26 by
  // enumerating the V2 pool factory's `deploy` events, then reading each pool's
  // Config, its reserves, and its oracle's exported interface out of that
  // contract's own wasm. They carry `deployedOn`-style wording in `name` for the
  // same reason a scored Blend market carries the field: presenting one of these
  // as an independent protocol would misrepresent the ecosystem.
  // ---------------------------------------------------------------------------
  {
    id: 'blend-orbit',
    name: 'Orbit (Blend V2 pool)',
    status: 'oracle-not-gradable',
    // Blend's own mark would assert exactly what this entry denies — that this
    // is Blend. Orbit publishes no mark this repo has verified and self-hosted,
    // so the initials tile stands.
    logo: null,
    // No URL for this market verified in this repo. A guessed domain beside a
    // protocol's name is worse than none.
    links: { site: null, docs: null },
    contractId: 'CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC',
    summary:
      'A Blend V2 market whose oracle is a bridge contract publishing no staleness tolerance and no deviation bound — the two parameters oracleSafety is anchored to.',
    reason: [
      'Orbit is a market on Blend V2, running the same pool contract (wasm a41fc53d…) that Stenion already scores twice. Everything on the pool side reads normally: four reserves, a multisig admin, and prices for every one of them. It is the oracle that stops it.',
      'The pool’s oracle (CAD2MCFU…) is a bridge contract, not Blend’s oracle-aggregator. Its entire exported interface is five functions — __constructor, add_asset, decimals, lastprice, set_admin — read out of its own wasm rather than probed by guessing names. It publishes no max_age(), no oracles() and no asset_configs(), which are the three reads METHODOLOGY.md §2 grades price trust against. None of them is part of SEP-40, which defines no staleness tolerance and no deviation bound at all.',
      'There is a second problem specific to this market, and it is the reason a fallback would be worse than no score. Its largest reserve (CBZPEX…) held $189,999.50 of the pool’s $190,862.93 total — 99.5% — and returns a price of exactly 1.0 stamped at the current ledger time, without touching any upstream contract. On Blend’s aggregator such base assets are excluded from oracleSafety rather than graded, because there is no oracle-derived price to grade; that exclusion is driven by the aggregator’s base() and BaseAssets, and this bridge publishes neither. So the reserve holding almost the entire market would be graded as a permanently-fresh feed. A confident 100 derived from a hardcoded constant is worse than no number, which is why this market is unscored rather than scored around.',
      'Nothing here says Orbit is unsafe, and nothing says its oracle is a bad one — a bridge that maps assets onto upstream feeds is an ordinary design. What is reported is that the specific parameters this factor is anchored to are not published, so the number cannot be computed from the market’s own data. Note separately that the pool read status 4 (Admin Frozen) when we looked: borrowing and supplying were disabled, withdrawals and repayments were not. That is a live operational state, not a score, and it is not the reason this entry is here.',
      'If the oracle later publishes a staleness tolerance and a per-asset deviation bound, this market becomes scorable with no rule change — a BLEND_POOLS entry and the deletion of this entry, in one PR.',
    ],
    verify:
      'Read the pool’s instance storage via Soroban RPC getLedgerEntries and take `oracle` from its Config — that resolves CAD2MCFU…. Fetch that contract’s wasm (getContractWasmByContractId) and list its exports from the contractspecv0 section, or call getContractMethods: five functions, none of them max_age, oracles or asset_configs. Then simulate lastprice(Asset::Stellar(CBZPEX…)) against it and compare the returned timestamp with the current ledger close time — they match, and the simulation footprint names no contract other than the oracle itself. Call get_reserve_list on the pool and total each reserve for the balances.',
    asOf: '2026-08-26',
  },
  {
    id: 'blend-forex',
    name: 'Forex (Blend V2 pool)',
    status: 'oracle-not-gradable',
    logo: null,
    links: { site: null, docs: null },
    contractId: 'CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF',
    summary:
      'A Blend V2 market priced through a proxy oracle that forwards to a SEP-40 feed, and neither contract publishes a staleness tolerance or a deviation bound.',
    reason: [
      'A Blend V2 market on the same pool wasm (a41fc53d…) Stenion already scores. Its oracle (CDCFT5QD…) exports five functions — decimals, lastprice, set_config, set_proxy, upgrade — and is a proxy: its CONFIG names a base_oracle at CB5OTV4G…, which is a full SEP-40 feed publishing base, assets, decimals, resolution, price, prices and lastprice.',
      'Neither contract publishes what METHODOLOGY.md §2 grades against. The proxy exposes no max_age(), oracles() or asset_configs(); the feed one hop upstream exposes resolution() = 300 and no max_age either. That is not an oversight in either contract — SEP-40 simply does not define a maximum acceptable price age or a deviation bound, and leaves staleness checking to the consumer. Anchoring to the upstream would also anchor to a contract this pool does not itself publish or constrain, which would be a rule about somebody else’s configuration.',
      'Reading its state on the same day gave a further reason not to force a number: three of its four reserves could not be priced at all. lastprice returned Error(Contract, #2) for CDIKUR…, CBN3NC… and CBCO65…, leaving XLM as the only priced reserve at $504.17, against 5,628 units of the unpriced CDIKUR… carrying live borrows. A market where most reserves have no readable price is one where every priced factor is computed from a fraction of the market.',
      'The pool also read status 5 (Frozen) — borrowing and supplying disabled, withdrawals and repayments still available. Reported for completeness; it is a live operational state rather than a score, and it is not why this entry exists.',
    ],
    verify:
      'Take `oracle` from the pool’s Config in instance storage to resolve CDCFT5QD…, then read that contract’s own instance storage: its CONFIG record names base_oracle CB5OTV4G…. List the exports of both via getContractMethods — neither has max_age, oracles or asset_configs; the upstream answers resolution() with 300. Then simulate lastprice(Asset::Stellar(addr)) on the proxy for each address returned by the pool’s get_reserve_list and observe which return Error(Contract, #2).',
    asOf: '2026-08-26',
  },
  {
    id: 'blend-spectra-pts',
    name: 'Spectra PTs (Blend V2 pool)',
    status: 'oracle-not-gradable',
    logo: null,
    links: { site: null, docs: null },
    contractId: 'CDZVHCO7LDUJZSME3PJPJXAKT7F6W5IXSOXTJ2QEK3Y2X2CDUREBUMUY',
    summary:
      'A Blend V2 market priced by a deterministic bond model rather than a feed, so its price can never be stale and a freshness score would be meaningless.',
    reason: [
      'A Blend V2 market on the familiar pool wasm (a41fc53d…), with a single reserve: a Spectra principal token. Its oracle (CC4VF5DW…) is not a price feed. Its own get_description returns “Spectra Deterministic Oracle - Zero Coupon Bond Model”, and its stored state is a start time, a maturity, an implied APY and a target value at maturity — from which it computes a price at whatever the current ledger time happens to be.',
      'That makes freshness meaningless rather than merely unanchored, and this is the distinction that decided the entry. There is no publish event, so a price is never old: the timestamp it returns is the ledger clock, the measured age is always about zero, and any freshness formula would return the top of the scale permanently, whatever happened to the underlying token. A score that cannot move is not a measurement. The contract is also explicit that its lastprice ignores the asset it is asked about — its own documentation says the parameter “is ignored… It exists solely for interface compatibility” — so it is bound to one token by construction.',
      'It publishes no max_age(), oracles() or asset_configs(), and no deviation bound of any kind. The one lever that can move its output is set_future_pt_value, callable by its owner. That is an admin control rather than an oracle deviation bound, and the taxonomy has no way to grade it as either.',
      'None of this is a criticism of the design. Pricing a principal token by accretion toward maturity is a coherent and common approach, and it is arguably more predictable than a feed. It is simply not something a factor built to measure price staleness and single-step deviation can grade. Recorded separately: this market held $9.88 in total supplied value and read status 2 (Admin On-Ice) on the same day — either would be worth noting on its own, but the oracle is the reason it is here.',
    ],
    verify:
      'Resolve the oracle from the pool’s Config (CC4VF5DW…) and call get_description, get_maturity, get_start_time, get_initial_implied_apy and get_future_pt_value on it — they return the bond parameters, and its instance storage holds the same values under apy, maturity, start_t and future_pt. List its exports with getContractMethods: nineteen functions, none of them max_age, oracles or asset_configs, and the doc comment on lastprice states that its asset argument is ignored. Simulate lastprice twice a few minutes apart and compare the returned timestamps against the ledger close time.',
    asOf: '2026-08-26',
  },
  {
    id: 'blend-solv',
    name: 'Solv (Blend V2 pool)',
    status: 'oracle-not-gradable',
    logo: null,
    links: { site: null, docs: null },
    contractId: 'CC4HHXPKR3FIXUQEC53MAK2IVWD6APAEBBXP5XCIW5FISN6PQOAC6UXG',
    summary:
      'A Blend V2 market on a SEP-40 feed registry, whose only time parameter is a publish interval long enough to rate a price hours old as perfectly fresh.',
    reason: [
      'A Blend V2 market on the same pool wasm (a41fc53d…). Its oracle (CBMGLKUQ…) is the closest of the four to a standard feed — a SEP-40 registry exporting base, assets, decimals, resolution, price, prices and lastprice alongside owner-only add_feed, update_feed and remove_feed. It is the only one of the four that implements SEP-40 at all.',
      'It still publishes neither of the parameters METHODOLOGY.md §2 needs: no max_age(), no oracles(), no asset_configs(), and no deviation bound anywhere in its interface. That is a property of SEP-40 rather than of this contract — the standard defines no maximum acceptable price age and no deviation bound, and explicitly leaves staleness checking to whoever reads the price.',
      'The one field that looks like an anchor is resolution(), and using it would produce a worse outcome than declining to score. resolution() is a publish interval, not a staleness tolerance, and this oracle reports 43200 — twelve hours. Fed into Stenion’s freshness window with no max_age to pair it with, a twelve-hour tick yields a twenty-four-hour dead line, so every price younger than a day scores the top of the scale. Its own feeds demonstrate the problem: two were live to the second when read, while USDC was 10,285 seconds old and one further feed 21,739 seconds old. All four would have published a freshness of 100. That is the fabricated confidence the rule against invented numbers exists to prevent, so the anchor is refused rather than used.',
      'The contract is unusually candid about this, which is worth recording rather than paraphrasing: its own documentation flags two deliberate departures from SEP-40 — that decimals is not immutable, and that resolution “should never change after deployment” but here can, through an owner-callable set_resolution. A value the owner can move is not an anchor even in principle. Separately, the market held $175.69 in total supplied value when read.',
    ],
    verify:
      'Resolve the oracle from the pool’s Config (CBMGLKUQ…) and call resolution() — it returns 43200 — then base(), assets() and decimals(). List its exports with getContractMethods and confirm no max_age, oracles or asset_configs, and read the doc comments on decimals and set_resolution, which state the two SEP-40 deviations. Then simulate lastprice(Asset::Stellar(addr)) for each address from the pool’s get_reserve_list and compare each returned timestamp against the current ledger close time to reproduce the spread of feed ages.',
    asOf: '2026-08-26',
  },
  {
    id: 'aquarius-unregistered-markets',
    // NO COUNT IN THE NAME, deliberately. The name renders on the registry row
    // where a scored entry renders its score, and "Aquarius (339 pools)" puts a
    // three-digit number in that position — exactly the "not scored" read as
    // "scored badly" this section is built to prevent. The count is a dated
    // measurement and lives in `reason` beside `asOf`, like every other figure.
    name: 'Aquarius (its unregistered markets)',
    status: 'awaiting-capacity',
    // No mark self-hosted, and none borrowed: the only logo Aquarius publishes
    // is hotlinked from its own stellar.toml. The initials tile is the designed
    // fallback, here as on the scored entry.
    logo: null,
    links: { site: 'https://aqua.network', docs: 'https://docs.aqua.network' },
    // The AMM router, which is what was read to enumerate them. Not any one
    // pool: this entry is about every pool the router lists except the one that
    // is scored, so a single pool address would misdescribe it.
    contractId: 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK',
    summary:
      'Every Aquarius pool is scorable under the published DEX rulebook; the indexer has room for one of them, and the rest are unregistered for want of a target slot rather than for anything found in them.',
    reason: [
      'Aquarius runs many more markets than Stenion has room to index. Reading the router’s own get_pools_for_tokens_range across all 304 of its token sets returns 340 pools — 272 constant-product, 42 stableswap and 26 concentrated — each running one of exactly three wasm hashes the router itself declares. One of them, the XLM/USDC constant-product pool, is registered and scored. This entry covers the other 339.',
      'They are not excluded for size, and there is no size threshold behind this. The DEX rulebook publishes no market-size floor and has none pending, because neither factor it scores depends on how much a pool holds: the seven privileged roles and the pending-upgrade deadline read the same on a pool holding three stroops as on one holding millions, and whether an issuer can freeze the pool’s balance does not depend on the size of that balance. A number computed for any of these pools would be as true of it as the one published for the market that is scored. Registration is a separate question, and the answer to it is capacity.',
      'The capacity is a hard arithmetic limit rather than a preference. One scoring cycle runs as a single serverless function invocation with a sixty-second ceiling that cannot be raised on the tier this project runs on, and the cycle’s own budget is set below that so a run is never killed halfway — a cycle cut off mid-flight can leave one market scored and another neither scored nor recorded as failed, which is worse than a clean failure. Inside that budget every registered market must be able to get one full attempt, and at the shipped attempt timeout and concurrency that allows five markets in total. Four are lending markets that were already registered. The fifth is the Aquarius pool that is scored.',
      'Which pool took the slot was decided on what could be graded rather than on size alone. The largest Aquarius pool by far holds a token that is a plain Soroban contract rather than a Stellar Asset Contract, so it has no issuer flags to read and one of its two reserves would be disclosed rather than graded — a number computed from half the market. The registered pool’s two reserves are both Stellar Asset Contracts, so nothing in its issuer-control factor is excluded.',
      'Nothing here is a judgment about any of these markets, and nothing here should be read as one. Several of them are larger than the one that is scored. This entry exists so that the single Aquarius row on the registry is not mistaken for the whole of Aquarius, and it ends when Stenion has the capacity to index more — not when anything about Aquarius changes.',
    ],
    verify:
      'Call get_tokens_sets_count() on the Aquarius AMM router (CBQDHNBF…) via Soroban RPC — it returns 304 — then get_pools_for_tokens_range(start, end) over that range, which returns each token set with a map of pool-hash to pool address; the map entries total 340. Read each pool contract’s instance entry to get its running wasm hash, and compare against ConstantPoolHash / StableSwapPoolHash / ConcentratedPoolHash in the router’s own instance storage to classify it. Reserves come from get_reserves() on each pool contract, never from the pools plane. Which market Stenion scores is AQUARIUS_POOLS in adapters/aquarius/types.ts.',
    asOf: '2026-08-29',
  },
  {
    id: 'nectar-network',
    name: 'Nectar Network',
    status: 'awaiting-mainnet',
    logo: null,
    // No verified URL recorded in this repo; same reasoning as Templar's links.
    links: { site: null, docs: null },
    contractId: null,
    summary:
      'Known and next on the list to evaluate, with no Stellar mainnet deployment to read yet — and nothing yet confirmed about whether it would be scorable when there is.',
    reason: [
      'Flagged as the next protocol to evaluate once it is live on Stellar mainnet. There is no deployment to read, so there is nothing to score.',
      'Listed to be clear about what is and is not known: nothing has been confirmed about whether Nectar would be scorable. That question gets settled from its own contracts when they exist — whether reserves, utilization, liquidity, admin and oracle are all readable via Soroban RPC and Horizon from contracts it controls, rather than the market turning out to be another Blend pool or a deployment whose state lives on another chain. Both of those have happened with other candidates.',
      'This entry rests on no dated check of our own. Unlike the K2 markets above, there is no reading behind it — it records that Nectar is known and being watched, not that its absence from mainnet was verified on some particular day.',
    ],
    verify:
      'Look for a Nectar deployment on Stellar mainnet. If one exists, the cheap first test is the one in CONTRIBUTING.md: read the contract’s instance storage, check whether Blend’s V2 pool factory (CDSYOAVX…) answers is_pool(address) with true, and compare its wasm hash against a known Blend pool. A byte-for-byte match means it is a Blend market, not an independent protocol.',
    asOf: null,
  },
];

/**
 * The entries to publish, given what the live leaderboard actually contains.
 *
 * Derived from what was fetched, never assumed — the same discipline as the
 * `deployedOn` note at the top of the registry. If a market listed here has
 * since been registered and scored, it must not also appear as unscored, and
 * the guard that prevents that has to read the real board rather than trust
 * this file to have been cleaned up. The cleanup is still the registering PR's
 * job; this only stops a forgotten entry from contradicting the board.
 *
 * An empty `scoredIds` (the leaderboard failed to load) yields the full list on
 * purpose: this section is static and stays true during a database outage, and
 * the registry's own error state already tells the reader the live data is
 * unavailable.
 */
export function coverageToPublish(scoredIds: Iterable<string>): CoverageEntry[] {
  const scored = new Set(scoredIds);
  return COVERAGE.filter((entry) => !scored.has(entry.id));
}

/**
 * Public API projection of the entries that are not on the live leaderboard.
 *
 * This is intentionally a projection rather than returning CoverageEntry
 * directly. The endpoint is a public v1 contract, so its fields change only by
 * an explicit edit here. Arrays and nested objects are copied so consumers of
 * this helper cannot mutate the static source records.
 */
export function coverageForApi(scoredIds: Iterable<string>): ApiCoverageEntry[] {
  return coverageToPublish(scoredIds).map((entry) => ({
    id: entry.id,
    name: entry.name,
    status: entry.status,
    logo: entry.logo,
    links: { ...entry.links },
    contractId: entry.contractId,
    summary: entry.summary,
    reason: [...entry.reason],
    verify: entry.verify,
    asOf: entry.asOf,
  }));
}

/**
 * One entry by id, or null — the lookup behind /coverage/[id].
 *
 * Null is a real 404 at that route, NOT a fallback to some generic page: an id
 * we hold no coverage decision for is an id we have nothing true to say about,
 * and a page that says "not scored" for an arbitrary slug would manufacture a
 * coverage claim out of a typo.
 *
 * Note what this deliberately does not do: it never consults the live
 * leaderboard. The dedupe against scored ids belongs to the route (which
 * redirects to /protocol/[id]), because it needs data this leaf module has no
 * business fetching — see coverageToPublish for the same split.
 */
export function coverageById(id: string): CoverageEntry | null {
  return COVERAGE.find((entry) => entry.id === id) ?? null;
}

/**
 * Entries grouped by status, in COVERAGE_STATUS_ORDER, omitting any status with
 * no members. Empty groups are dropped here rather than in the view, so the
 * "never render a heading over nothing" rule holds wherever this is consumed.
 */
export function groupCoverage(
  entries: readonly CoverageEntry[],
): { status: CoverageStatus; entries: CoverageEntry[] }[] {
  return COVERAGE_STATUS_ORDER.map((status) => ({
    status,
    entries: entries.filter((e) => e.status === status),
  })).filter((group) => group.entries.length > 0);
}
