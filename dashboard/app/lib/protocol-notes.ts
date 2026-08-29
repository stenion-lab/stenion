// Per-protocol findings surfaced on a protocol's detail page.
//
// WHAT THIS IS: verifiable observations about a protocol's on-chain setup that
// a reader of its entry should see, but that are NOT scored — either because
// they aren't a risk measurement, or because scoring them would require
// inventing a threshold we can't anchor. Surfacing what we found but didn't
// score is part of the job; burying it in a methodology footnote isn't.
//
// WHAT THIS IS NOT: an input to any number. Nothing here touches `safetyScore`
// or any factor. The registry ranks purely on score, and a note — favourable or
// not — can never move it. Same wall as the payment rule.
//
// BAR FOR ADDING ONE: independently verifiable from chain or from public
// source, stated neutrally, and explicit about what is verified versus what is
// inferred. No speculation about intent, no accusation. If we can't say exactly
// how a reader could check it themselves, it doesn't go here.

export interface ProtocolNote {
  title: string;
  /** Each paragraph rendered separately. Plain text — no markup. */
  body: string[];
  /** How a reader can verify this themselves. */
  verify: string;
}

export const PROTOCOL_NOTES: Record<string, ProtocolNote[]> = {
  kinetic: [
    {
      title: "The price feed is older than K2's own staleness threshold in most observed runs",
      body: [
        'Between 2026-08-11 18:16 and 2026-08-18 15:55 UTC, Stenion recorded 1,469 scored ' +
          'runs against K2. In 1,370 of them — 93% — oracleSafety was 0. The distribution ' +
          'is close to all-or-nothing: 1,370 runs at 0 against 3 runs at 100, rather than ' +
          'spread across the range. In every run of that window where the sub-signals ' +
          'were recorded separately, the deviation-bound signal was 100 — so the zeroes ' +
          'are price age, not a missing circuit breaker.',
        'The threshold behind that is 3600 seconds: price_staleness_threshold, K2’s own ' +
          'on-chain limit, not a Stenion constant. The oldest single price observed in ' +
          'the window was 41,777 seconds (11h 36m).',
        'It is not a continuous outage. The feed refreshes to an age of a few hundred ' +
          'seconds, climbs back past the threshold over roughly an hour, and then sits ' +
          'there for hours before refreshing again. That cycle is what makes the overall ' +
          'score oscillate: the oscillation is the price ageing out and being renewed, ' +
          'not the pool’s risk genuinely changing every few minutes. It shows up as a ' +
          'repeating sawtooth in the score history above once enough runs have ' +
          'accumulated since the history was reset — a chart covering only a few hours ' +
          'may catch one excursion, or none.',
        'The runs behind these counts have since been discarded — the stored score ' +
          'history was reset when the methodology was flattened to a single published ' +
          'version, so these figures cannot be re-derived from the API. What is stated ' +
          'here is an observation over a closed window that was made and recorded, not a ' +
          'claim about rows you can still fetch. The condition itself needs none of our ' +
          'history: it is checkable on-chain directly, by the steps below.',
        'What is not being claimed: the circuit breaker was scored 100 throughout, so ' +
          'the bound on a single-step price move is armed — this is purely about ' +
          'freshness. And a price past a staleness threshold does not by itself mean the ' +
          'protocol acts on it. K2’s own code may reject the stale price and revert ' +
          'whatever operation depended on it. What is observable from outside is the age ' +
          'of the price the oracle serves, not which of those two follows. Both matter ' +
          'to a depositor — one means positions can be valued on an hours-old price, the ' +
          'other means borrowing or liquidation may be unavailable for long stretches — ' +
          'but separating them needs a call path we cannot observe.',
        'Recorded here as well as scored because a factor value shows the state right ' +
          'now. An oracleSafety of 0 in this instant and an oracleSafety that has been 0 ' +
          'for most of three days are different facts, and only the second one is a ' +
          'pattern.',
      ],
      verify:
        'Read ORACLE from the kinetic_router instance storage ' +
        '(CCTUJZLY…AWNXOJIV6J7) via Soroban RPC, then call get_asset_prices_vec_fresh on ' +
        'that oracle and compare each PriceData.timestamp against the current ledger ' +
        'close time. Read the thresholds from the same contract: get_oracle_config for ' +
        'price_staleness_threshold, and get_asset_config per asset for max_age.',
    },
    {
      title: 'Individual price feeds go stale for hours while others update in seconds',
      body: [
        'All four of K2’s reserves are priced by the same oracle contract ' +
          '(CCHRZE2K…) through the same batchAdapter source. Their prices do not age ' +
          'together. In one reading on 2026-08-18, SolvBTC was 27 seconds old and XLM 177 ' +
          'seconds old, while USDC was 21,421 seconds old (5h 57m) and PYUSD 41,777 ' +
          'seconds old (11h 36m). Repeated readings minutes apart showed the same split, ' +
          'with the two stale ages advancing in step with wall-clock time — meaning those ' +
          'entries were not being refreshed at all during the observation, rather than ' +
          'being sampled at an unlucky moment.',
        'For scale against K2’s own limits: price_staleness_threshold is 3600 seconds, so ' +
          'the USDC reading exceeded it roughly sixfold and the PYUSD reading elevenfold. ' +
          'The per-asset max_age values are looser — 43,200 seconds for XLM and SolvBTC, ' +
          '86,400 for USDC and PYUSD — and neither stale reading had reached those.',
        'What this changes about the picture above: the staleness is not the whole oracle ' +
          'going quiet and coming back. The oracle is demonstrably alive and serving some ' +
          'assets within seconds while others sit untouched for hours, through one ' +
          'contract and one source. Freshness here is a property of the individual feed ' +
          'entry, not of the oracle as a whole.',
        'USDC is the reading worth noting rather than PYUSD. PYUSD held about $4 of ' +
          'supplied value at the time and USDC about $54 — both small in absolute terms, ' +
          'but USDC is well above the size line Stenion uses elsewhere, so this is not a ' +
          'question of an abandoned dust market. A lending protocol valuing a stablecoin ' +
          'position off a six-hour-old reading is the observable condition.',
        'What is not being claimed: nothing here says the protocol acted on a stale ' +
          'price. K2’s own code may reject it and revert whatever operation depended on ' +
          'it — that is the same limit noted above, and it applies equally here. What is ' +
          'observable from outside is the age of the price the oracle serves. Nor is any ' +
          'cause implied: an upstream feed pausing, a per-asset configuration, and a ' +
          'deliberate choice all look identical from here.',
        'Every reserve’s price age is now published on each run in the oracleSafety ' +
          'factor’s priceAges component, alongside a count of how many exceed K2’s own ' +
          'threshold. It is reported, not scored — the freshness score already grades the ' +
          'worst of them, and grading the spread again would count the same staleness ' +
          'twice.',
        'Still running as of 2026-08-20. A fresh reading two days after the one above found ' +
          'SolvBTC at 26 seconds, XLM at 71, USDC at 618 and PYUSD at 23,304 (6h 28m) — the ' +
          'same split, from the same oracle, in the same call. Two things are worth taking ' +
          'from the repeat rather than from either reading alone. The condition is a standing ' +
          'property of these feeds and not a moment we happened to catch. And WHICH feed is ' +
          'stale moves: USDC was 21,421 seconds old on 2026-08-18 and 618 seconds old on ' +
          '2026-08-20, while PYUSD exceeded K2’s 3,600-second threshold on both. So a reader ' +
          'should not take the specific assets named here as the affected set — the pattern is ' +
          'that some entry is hours behind while others are seconds behind, not that it is ' +
          'always this one.',
      ],
      verify:
        'Call get_asset_prices_vec_fresh on CCHRZE2K…5BNOMQRMU for the four assets in ' +
        'get_reserves_list on the router (CCTUJZLY…AWNXOJIV6J7) and compare each ' +
        'PriceData.timestamp against the current ledger close time — read them together ' +
        'in one call so the ages are directly comparable. Repeat a few minutes later: an ' +
        'age that grows by the elapsed wall-clock time is an entry that is not being ' +
        'refreshed. Read get_asset_config per asset for source and max_age, and ' +
        'get_oracle_config for price_staleness_threshold.',
    },
    {
      title: 'The deployed price oracle is a superset of its audited version',
      body: [
        "K2's price oracle contract (CCHRZE2K…) exports 44 functions. Thirty-five of " +
          'them match the audited source published for the Code4rena review ' +
          '(code-423n4/2026-04-k2), and the deployed contract reports the same ' +
          'version() == 2 that source declares. Nine do not appear in the audited ' +
          'code at all: four *_as_admin variants, get_asset_prices_vec_fresh, and a ' +
          'four-function secondary-feed subsystem.',
        'The live kinetic_router prices its reserves through one of those additions. ' +
          'Scanning the deployed router for the oracle method symbols it references ' +
          'shows get_asset_prices_vec_fresh present and get_asset_price_data — the ' +
          'method whose circuit-breaker enforcement is verifiable in the audited ' +
          'source — absent.',
        "This matters to K2's oracleSafety score. The 20% circuit breaker " +
          '(max_price_change_bps) is enforced on every return path of ' +
          'get_asset_price_data in the audited source, and its audited sibling ' +
          'get_asset_prices_vec enforces it too. All three methods return identical ' +
          'price data today. On that basis Stenion scores the breaker as enforced — ' +
          'but the path the pool actually uses has no public source, so that is an ' +
          'inference, not a verification, and it is recorded as one.',
        'Stated neutrally: a deployed contract diverging from its audited snapshot is ' +
          'common and the additions may be entirely sound. What is being reported is ' +
          'the divergence and its consequence for what we can and cannot verify — not ' +
          'a claim that anything is wrong.',
      ],
      verify:
        'Fetch the contract code for CCHRZE2K…5BNOMQRMU and CCTUJZLY…AWNXOJIV6J7 via ' +
        'Soroban RPC getLedgerEntries and read the wasm export section; compare against ' +
        'contracts/price-oracle/src/contract.rs in code-423n4/2026-04-k2.',
    },
    {
      title: 'Two of K2’s live contracts are missing or out of date in its published contract list',
      body: [
        'K2 runs its markets as separate router contracts rather than as configurations inside ' +
          'one pool. Three are live on Stellar mainnet, all deployed from byte-identical code ' +
          '(wasm df2831cf…), sharing one price oracle, one pool admin and one treasury, each ' +
          'with its own configurator: the primary pooled market (CCTUJZLY…), a SolvBTC/xSolvBTC ' +
          'isolated market (CCGXGXIL…), and an Earn market for earnUSDC/USDC (CDWPVHKB…) ' +
          'operated by a third party, Gami/Upshift.',
        'The isolated market’s router does not appear on K2’s contracts page. That page lists ' +
          'the xSolvBTC market as a set of reserve token addresses with no router among them, ' +
          'and repeats the primary market’s SolvBTC aToken and debt ledger beside them — which ' +
          'reads as though the market sits inside the primary pool. It does not. The router ' +
          'address above was not read from any documentation: it came from the pool_address ' +
          'field in the xSolvBTC aToken’s own instance storage, whose State also names it ' +
          '"K2 Iso Interest Bearing SolvBTC" (kiSolvBTC). Calling get_reserve_data for xSolvBTC ' +
          'on the primary router returns Error(Contract, #24) — it is not a reserve there.',
        'The Earn market’s contract table is out of date in the other direction. It gives the ' +
          'earnUSDC aToken and debt ledger as "TBA" and says they "will be added once ' +
          'deployed". Both are deployed and wired: the Earn router’s get_reserves_list returns ' +
          'earnUSDC alongside USDC, and get_current_reserve_data resolves an aToken at ' +
          'CCOPG2ZQ… and a debt ledger at CBO4TOFT….',
        'What this changes for Stenion’s coverage, stated plainly: this entry scores the ' +
          'primary market only. It is not a score for K2 as a whole, and the two other markets ' +
          'are unscored rather than assessed and passed over. Neither holds enough to be ' +
          'scorable — the isolated market held $3.62 and the Earn market held nothing at all ' +
          'when read on 2026-08-20 — so they fall below the market-size floor in the ' +
          'methodology, which is why there is no entry for either.',
        'What is not being claimed: nothing here says the documentation is wrong about what ' +
          'the contracts do, that anything is hidden, or that any market is unsafe. ' +
          'Documentation lagging deployment is ordinary, and an empty market is an empty ' +
          'market rather than a defective one. What is reported is the divergence itself — ' +
          'a live market reachable only by reading contract storage, and a deployed pair ' +
          'described as pending — because a reader who takes the published list as complete ' +
          'gets a different picture of the protocol than the chain gives.',
      ],
      verify:
        'Read the instance storage of the xSolvBTC aToken (CBMGL7ZL…HGYJ6JALVY) via Soroban ' +
        'RPC getLedgerEntries and take pool_address from its State; call get_reserves_list and ' +
        'is_paused on the router it names. Compare against the tables at ' +
        'docs.k2lend.com/contracts and docs.k2lend.com/third-party-markets/contract-addresses. ' +
        'For the Earn market, call get_reserves_list on CDWPVHKB…KTPF6TZE and ' +
        'get_current_reserve_data for each asset, and compare the a_token_address it returns ' +
        'against the "TBA" row. Balances come from total_supply on each aToken and debt ledger.',
    },
    {
      title: 'get_price_with_protection provides no protection',
      body: [
        "In K2's audited oracle source, oracle.rs defines get_price_with_protection " +
          'and get_price_with_protection_fallback. Both ignore their _config ' +
          'parameter and call the underlying query function directly — neither ' +
          'applies a circuit breaker or any other check.',
        'This is not a hole: the real validation runs one level up, in ' +
          'validate_price_change inside get_asset_price_data, so prices are still ' +
          'checked. It is recorded because the name asserts a guarantee the function ' +
          'does not provide, which is the kind of thing that misleads anyone reading ' +
          'the source to understand how the oracle is defended.',
      ],
      verify:
        'Read contracts/price-oracle/src/oracle.rs in code-423n4/2026-04-k2 and follow ' +
        'the call sites of validate_price_change in contract.rs.',
    },
  ],

  'aquarius-xlm-usdc': [
    {
      title:
        'This entry is one Aquarius market of 340, and the seven roles that control it control all of them',
      body: [
        'Aquarius is an AMM with many markets rather than one pool. Reading its router’s own ' +
          'get_pools_for_tokens_range across all 304 of its token sets on 2026-08-29, at ledger ' +
          '64,182,824, returns 340 pools: 272 constant-product, 42 stableswap and 26 ' +
          'concentrated. This entry is one of the 272. It is not Aquarius, and a reader who ' +
          'takes the number above as a grade on the protocol has read it wrongly — what is ' +
          'scored is the pool at the contract address on this page.',
        'Every one of those 340 pools runs one of exactly three contracts. Each pool’s running ' +
          'wasm hash equals one of ConstantPoolHash, StableSwapPoolHash or ' +
          'ConcentratedPoolHash as the router itself declares them, with no exceptions found — ' +
          'this pool runs ae0da5a8…de9852, the constant-product hash. So the code under this ' +
          'market is the same code under 271 others.',
        'The admin surface is shared too, and that is the part that carries into the score. ' +
          'get_privileged_addrs() on this pool returns the same seven roles, held by the same ' +
          'seven accounts, as the router itself: an Admin held by a 3-of-n account with a high ' +
          'threshold of 2, and six single-signer accounts holding EmergencyAdmin, ' +
          'EmergencyPauseAdmin, PauseAdmin, OperationsAdmin, RewardsAdmin and SystemFeeAdmin. ' +
          'A per-pool set_privileged_addrs exists, so this is a current reading rather than an ' +
          'invariant — but as it stands, adminKeySafety is measuring something about Aquarius ' +
          'rather than about this market, and would read the same on any of the 340.',
        'What that means for the two published factors: adminKeySafety does not distinguish this ' +
          'market from any other Aquarius market today, and assetControlSafety — which reads ' +
          'the issuers of the tokens this pool actually holds — is the factor that does. That ' +
          'is a property of Aquarius’s current setup, not of the rulebook, and the weights were ' +
          'deliberately not tuned around it.',
        'What is not being claimed: sharing one codebase and one admin set across 340 markets is ' +
          'ordinary for an AMM and is not itself a finding. It is recorded because the entry ' +
          'names one pair, and a reader is entitled to know how much of the number is about ' +
          'that pair and how much is about the protocol underneath it.',
      ],
      verify:
        'Call get_tokens_sets_count() and get_pools_for_tokens_range(0, 304) on the Aquarius AMM ' +
        'router CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK via Soroban RPC to ' +
        'enumerate the pools. Read each pool contract’s instance entry for its executable wasm ' +
        'hash, and the router’s instance storage for ConstantPoolHash / StableSwapPoolHash / ' +
        'ConcentratedPoolHash to classify it. Call get_privileged_addrs() on this pool and on ' +
        'the router and compare the two maps.',
    },
  ],
};

export function notesFor(protocolId: string): ProtocolNote[] {
  return PROTOCOL_NOTES[protocolId] ?? [];
}
