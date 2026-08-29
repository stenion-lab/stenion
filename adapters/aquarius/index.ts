// The AquariusAdapter itself: identity, and the Adapter interface wired to the
// modules beside it. This file is the adapter's whole public surface —
// `./types.ts` and `./fetch.ts` export more than this re-exports, and that extra
// is internal wiring rather than API.
//
// THIS ADAPTER FETCHES AND DOES NOT SCORE, DELIBERATELY (#101). `dex` ships with
// two factors (`adminKeySafety`, `assetControlSafety`) and NO weight table — the
// weights are their own review (#102) and the scoring implementation is #103. So
// `computeRiskFactors`, `score` and `operationalState` throw rather than
// returning something plausible. An adapter that returned a made-up factor map
// to satisfy the interface would be indistinguishable from a working one at the
// call site, which is precisely the failure the two-step admission exists to
// prevent.
//
// There is no `score.ts` in this folder yet, and that is the same fact stated in
// the file layout. CLAUDE.md's four-file adapter shape is types/fetch/score/
// index; `score.ts` is where the factors and `operationalState` live, and it
// arrives with #103 rather than existing now as a file full of throws.

import type {
  Adapter,
  OperationalState,
  ProtocolMetadata,
  RiskFactorMap,
  RiskScoreResult,
} from '@stenion/core';

import { fetchAquariusRawData } from './fetch.ts';
import { DEFAULT_HORIZON_URL, DEFAULT_RPC_URL } from './types.ts';
import type { AquariusAdapterOptions, AquariusRawData } from './types.ts';

export {
  AQUARIUS_POOL_TYPES,
  AQUARIUS_ROLES,
  AQUARIUS_ROUTER_ID,
  DEFAULT_HORIZON_URL,
  DEFAULT_RPC_URL,
} from './types.ts';
export type {
  AquariusAdapterOptions,
  AquariusIssuerFlagsRaw,
  AquariusIssuerRead,
  AquariusKillFlagsRaw,
  AquariusPool,
  AquariusPoolType,
  AquariusRawData,
  AquariusRole,
  AquariusRoleAccountRaw,
  AquariusRoleRaw,
  AquariusRolesRead,
  AquariusRouterRaw,
  AquariusTokenRaw,
  AquariusUpgradeRaw,
} from './types.ts';
export {
  STELLAR_ASSET_EXECUTABLE,
  asPoolType,
  decodeRoles,
  instanceKeyName,
  fetchAquariusRawData,
  parseAssetName,
  unrecognisedPoolType,
} from './fetch.ts';

/**
 * The message every unimplemented scoring method throws.
 *
 * A STRING LITERAL, never built from a runtime identifier — the workspace is
 * bundled and minified into the dashboard's serverless functions, so a name
 * taken from `this.constructor.name` would be right in every test and wrong in
 * production. Same rule as `ProtocolMetadata.adapterRef`.
 */
function notScorable(method: string): Error {
  return new Error(
    `AquariusAdapter.${method} is not implemented: the dex rulebook publishes no weight table ` +
      'yet (methodology/dex.md, "Factor weights"), so nothing can be scored under it. This ' +
      'adapter reads the chain and stops there by design — see issue #101. Scoring is #103.',
  );
}

export class AquariusAdapter implements Adapter<AquariusRawData, 'dex'> {
  /**
   * Built in the constructor rather than as a field initialiser because every
   * identity field has to describe the pool THIS INSTANCE reads. `contractId`
   * is the sharp one: an adapter pointed at a second pool that published an
   * explorer link to the first would attach a wrong reading to a real address.
   * It is set from `this.poolId`, the same value `fetchRawData` reads, so the
   * two cannot drift.
   */
  readonly metadata: ProtocolMetadata<'dex'>;

  private readonly rpcUrl: string;
  private readonly horizonUrl: string;
  private readonly poolId: string;

  constructor(opts: AquariusAdapterOptions) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
    this.horizonUrl = opts.horizonUrl ?? DEFAULT_HORIZON_URL;
    this.poolId = opts.pool.poolId;

    this.metadata = {
      id: opts.pool.id,
      name: opts.pool.name,
      chain: 'stellar',
      // The first adapter of a category other than lending. Declared per
      // instance like the rest of the identity — ADAPTER_INTERFACE_VERSION 3
      // makes this required precisely so no adapter is silently filed under
      // lending, and this is the first time that has mattered.
      category: 'dex',
      // Literal, not this.constructor.name — see ProtocolMetadata.adapterRef.
      adapterRef: 'AquariusAdapter',
      contractId: this.poolId,
      ...(opts.pool.logo === undefined ? {} : { logo: opts.pool.logo }),
      ...(opts.pool.links === undefined ? {} : { links: opts.pool.links }),
      ...(opts.pool.deployedOn === undefined ? {} : { deployedOn: opts.pool.deployedOn }),
    };
  }

  // Reads live on ./fetch.ts, which takes the target explicitly — this method
  // is where instance state becomes that argument, and nowhere else.
  async fetchRawData(): Promise<AquariusRawData> {
    return fetchAquariusRawData({
      rpcUrl: this.rpcUrl,
      horizonUrl: this.horizonUrl,
      poolId: this.poolId,
    });
  }

  /**
   * Not implemented — see the file header. Throws rather than returning a
   * partial or placeholder factor map: `dex` has no weight table, so there is
   * no honest number to put in one.
   */
  async computeRiskFactors(_raw: AquariusRawData): Promise<RiskFactorMap> {
    throw notScorable('computeRiskFactors');
  }

  /**
   * Not implemented — #103.
   *
   * The raw shape already carries everything this needs: `killed` (swap,
   * deposit, claim — read via getters) and `emergencyMode`, on the pool and on
   * the router. What is missing is the mapping onto `dex`'s vocabulary and the
   * `swapDisabled` rung, which is scoring-adjacent logic and belongs in
   * `score.ts` beside the factors rather than being written here first.
   */
  operationalState(_raw: AquariusRawData): OperationalState<'dex'> {
    throw notScorable('operationalState');
  }

  /**
   * Not implemented — #103.
   *
   * Deliberately NOT `scoreFactors(factors)`. The shared weighted mean would
   * happily average an empty or hand-built map and return a confident number,
   * and `dex` has no weights for it to average. Delegating here would make an
   * unscorable category look scorable at the one call site the indexer uses.
   */
  score(_factors: RiskFactorMap): RiskScoreResult {
    throw notScorable('score');
  }
}
