// The KineticAdapter itself: identity, and the Adapter interface wired to the
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

import { fetchKineticRawData } from './fetch.ts';
import { computeKineticRiskFactors, kineticOperationalState } from './score.ts';
import { DEFAULT_HORIZON_URL, DEFAULT_RPC_URL, KINETIC_ROUTER } from './types.ts';
import type { KineticAdapterOptions, KineticRawData } from './types.ts';

export { decodeDecimals, decodeReserveFlags } from './fetch.ts';
export type {
  KineticAdapterOptions,
  KineticAdminRaw,
  KineticOracleConfigRaw,
  KineticRawData,
  KineticReserveFlags,
  KineticReserveRaw,
  ReserveConfigurationNative,
} from './types.ts';

export class KineticAdapter implements Adapter<KineticRawData, 'lending'> {
  /** Constructor-built so `contractId` is the router actually scored — see BlendAdapter. */
  readonly metadata: ProtocolMetadata<'lending'>;

  private readonly rpcUrl: string;
  private readonly horizonUrl: string;
  private readonly routerId: string;

  constructor(opts: KineticAdapterOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
    this.horizonUrl = opts.horizonUrl ?? DEFAULT_HORIZON_URL;
    this.routerId = opts.routerId ?? KINETIC_ROUTER;

    this.metadata = {
      id: 'kinetic',
      name: 'Kinetic',
      chain: 'stellar',
      // K2 is a lending protocol — see ProtocolCategory. Required as of
      // ADAPTER_INTERFACE_VERSION 3; nothing infers it.
      category: 'lending',
      // Literal, not this.constructor.name — see ProtocolMetadata.adapterRef.
      adapterRef: 'KineticAdapter',
      // Kinetic rebranded to "K2" (k2lend.com) and publishes no high-resolution
      // square mark — only a 3.15:1 wordmark and this 64x64 icon. The icon is
      // used unmodified: cropping a glyph out of the wordmark would give a
      // sharper asset but means altering their logo, which contradicts what the
      // attribution note on the dashboard says we do. Small and honest wins.
      //
      // NOTE the mark reads "K2" while `name` above is still "Kinetic". That
      // mismatch is real and predates this — renaming the protocol changes the
      // `id` slug (a primary key, and a public URL), so it is deliberately not
      // done here. Flagged in ROADMAP.md.
      logo: '/assets/protocols/kinetic.png',
      contractId: this.routerId,
      links: {
        site: 'https://k2lend.com',
        docs: 'https://docs.k2lend.com',
      },
    };
  }

  // Reads live on ./fetch.ts, which takes the target explicitly — this method
  // is where instance state becomes that argument, and nowhere else.
  async fetchRawData(): Promise<KineticRawData> {
    return fetchKineticRawData({
      rpcUrl: this.rpcUrl,
      horizonUrl: this.horizonUrl,
      routerId: this.routerId,
    });
  }

  async computeRiskFactors(raw: KineticRawData): Promise<RiskFactorMap> {
    return computeKineticRiskFactors(raw);
  }

  operationalState(raw: KineticRawData): OperationalState<'lending'> {
    return kineticOperationalState(raw);
  }

  // Delegates to the shared rulebook in @stenion/core. The weighted mean is not
  // per-protocol (METHODOLOGY.md ground rule 1), so it must not be reimplemented
  // here — this method exists only to satisfy the Adapter interface.
  score(factors: RiskFactorMap): RiskScoreResult {
    return scoreFactors(factors);
  }
}

export const kineticAdapter = new KineticAdapter();
