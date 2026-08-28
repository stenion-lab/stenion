// The BlendAdapter itself: identity, and the Adapter interface wired to the
// three modules beside it. This file is the adapter's whole public surface —
// `./types.ts`, `./fetch.ts` and `./score.ts` export more than this re-exports,
// and that extra is internal wiring rather than API.

import { scoreFactors } from '@stenion/core';
import type {
  Adapter,
  OperationalState,
  ProtocolMetadata,
  RiskFactorMap,
  RiskScoreResult,
} from '@stenion/core';

import { fetchBlendRawData } from './fetch.ts';
import { blendOperationalState, computeBlendRiskFactors } from './score.ts';
import { BLEND_FIXED_V2, DEFAULT_HORIZON_URL, DEFAULT_RPC_URL } from './types.ts';
import type { BlendAdapterOptions, BlendRawData } from './types.ts';

export { BLEND_ETHERFUSE_V2, BLEND_FIXED_V2, BLEND_POOLS, BLEND_YIELDBLOX_V2 } from './types.ts';
export type {
  BlendAdapterOptions,
  BlendAdminRaw,
  BlendOracleConfigRaw,
  BlendPool,
  BlendRawData,
  BlendReserveRaw,
} from './types.ts';
export { ORACLE_GRADING_READS, isMissingContractFunction, oracleNotGradable } from './fetch.ts';
export type { OracleGradingRead, OracleGradingReads } from './fetch.ts';

export class BlendAdapter implements Adapter<BlendRawData, 'lending'> {
  /**
   * Built in the constructor rather than as a field initialiser because every
   * identity field has to describe the pool THIS INSTANCE scores, not a module
   * default. `contractId` is the sharp one: an adapter pointed at a second pool
   * that published an explorer link to the first would attach a wrong number to
   * a real address, which is worse than no link at all. It is set from
   * `this.poolId`, the same value `fetchRawData` reads, so the two cannot drift.
   *
   * `adapterRef` is the one field every pool shares, and that is correct rather
   * than a gap: both entries genuinely are produced by this class, so both rows
   * point a reader at this file. It stays a string literal — never
   * `this.constructor.name`; see ProtocolMetadata.adapterRef.
   */
  readonly metadata: ProtocolMetadata<'lending'>;

  private readonly rpcUrl: string;
  private readonly horizonUrl: string;
  private readonly poolId: string;

  constructor(opts: BlendAdapterOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
    this.horizonUrl = opts.horizonUrl ?? DEFAULT_HORIZON_URL;
    const pool = opts.pool ?? BLEND_FIXED_V2;
    this.poolId = pool.poolId;

    this.metadata = {
      id: pool.id,
      name: pool.name,
      chain: 'stellar',
      // Every Blend market is a lending market — see ProtocolCategory. Declared
      // per instance like the rest of the identity, not inherited from a
      // default, because there is no default: ADAPTER_INTERFACE_VERSION 3 makes
      // this required precisely so no adapter is silently filed under lending.
      category: 'lending',
      // Literal, not this.constructor.name — see ProtocolMetadata.adapterRef.
      adapterRef: 'BlendAdapter',
      contractId: this.poolId,
      // Spread, so a pool with no mark / no links / no deployment note leaves the
      // key ABSENT rather than set to undefined. Identical to TypeScript, not to
      // a reader of a serialized metadata object — and `upsertProtocol` maps
      // either to NULL, so nothing downstream is asked to tell them apart.
      ...(pool.logo === undefined ? {} : { logo: pool.logo }),
      ...(pool.links === undefined ? {} : { links: pool.links }),
      ...(pool.deployedOn === undefined ? {} : { deployedOn: pool.deployedOn }),
    };
  }

  // Reads live on ./fetch.ts, which takes the target explicitly — this method
  // is where instance state becomes that argument, and nowhere else.
  async fetchRawData(): Promise<BlendRawData> {
    return fetchBlendRawData({
      rpcUrl: this.rpcUrl,
      horizonUrl: this.horizonUrl,
      poolId: this.poolId,
    });
  }

  async computeRiskFactors(raw: BlendRawData): Promise<RiskFactorMap> {
    return computeBlendRiskFactors(raw);
  }

  operationalState(raw: BlendRawData): OperationalState<'lending'> {
    return blendOperationalState(raw);
  }

  // Delegates to the shared rulebook in @stenion/core. The weighted mean is not
  // per-protocol (METHODOLOGY.md ground rule 1), so it must not be reimplemented
  // here — this method exists only to satisfy the Adapter interface.
  score(factors: RiskFactorMap): RiskScoreResult {
    return scoreFactors(factors);
  }
}

/** Blend's flagship Fixed V2 pool, ready to use. */
export const blendAdapter = new BlendAdapter();
