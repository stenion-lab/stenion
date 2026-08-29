// The AquariusAdapter itself: identity, and the Adapter interface wired to the
// three modules beside it. This file is the adapter's whole public surface —
// `./types.ts`, `./fetch.ts` and `./score.ts` export more than this re-exports,
// and that extra is internal wiring rather than API.
//
// THE FIRST NON-LENDING ADAPTER. It implements `Adapter<AquariusRawData, 'dex',
// DexFactorMap>` — three parameters where both lending adapters take two,
// because `dex` is scored on `adminKeySafety` and `assetControlSafety` and the
// interface's default factor map is lending's five-key `RiskFactorMap`. The
// third parameter is defaulted, so nothing about Blend or Kinetic changed; see
// `Adapter` in `core/src/adapter.ts` for why it had to exist.
//
// IT IS STILL NOT REGISTERED. No `AQUARIUS_POOLS` constant exists and nothing is
// added to any target list here — which pools to register is a reviewed decision
// that depends on a size census (#104). This class scores whichever pool it is
// handed.

import { scoreFactors } from '@stenion/core';
import type {
  Adapter,
  DexFactorMap,
  OperationalState,
  ProtocolMetadata,
  ScoreResult,
} from '@stenion/core';

import { fetchAquariusRawData } from './fetch.ts';
import { aquariusOperationalState, computeAquariusRiskFactors } from './score.ts';
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
export { aquariusOperationalState, computeAquariusRiskFactors } from './score.ts';

export class AquariusAdapter implements Adapter<AquariusRawData, 'dex', DexFactorMap> {
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
   * The two `dex` factors — methodology/dex.md, weighted 0.55 / 0.45 from
   * `DEX_FACTORS`. Delegates to ./score.ts, which reads no clock and no instance
   * state, so a fixture exercises every rule.
   *
   * Returns `DexFactorMap`, not lending's `RiskFactorMap`: `dex` scores
   * `adminKeySafety` and `assetControlSafety` and has no referent for the other
   * three lending factors at all (no borrow ledger, no cap, no oracle). See
   * `CATEGORY_FACTORS.dex`.
   */
  async computeRiskFactors(raw: AquariusRawData): Promise<DexFactorMap> {
    return computeAquariusRiskFactors(raw);
  }

  /**
   * The pool's live restrictions — published beside the score and never in it.
   *
   * The byte-identical-factor-map invariant this rests on (#15) is asserted in
   * ./score.test.ts: no kill switch and no emergency-mode flag may move any
   * value `computeRiskFactors` produces.
   */
  operationalState(raw: AquariusRawData): OperationalState<'dex'> {
    return aquariusOperationalState(raw);
  }

  // Delegates to the shared rulebook in @stenion/core. The weighted mean is not
  // per-protocol and not per-category — `scoreFactors` is generic over the factor
  // map precisely so there is never a `dex` variant of it — so this method exists
  // only to satisfy the Adapter interface.
  score(factors: DexFactorMap): ScoreResult<DexFactorMap> {
    return scoreFactors(factors);
  }
}
