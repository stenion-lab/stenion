// The run loop, separated from the process entry point.
//
// Everything here is a pure function of its arguments: `runCycle` takes the
// targets and the store it should write to, and reaches for no environment, no
// pg pool, and no clock beyond `new Date()`. That is what makes the error model
// testable — the indexer's whole job on failure is to record a failed run and
// keep going, and as of 2026-08-16 `risk_scores` holds 1,683 rows and not one
// failed, so this path has never executed in production. It can only be proven
// against a deliberately throwing adapter.
//
// It lives in its own module rather than in index.ts because index.ts is a CLI
// entry point: it carries a `require.main === module` guard and extensionless
// relative imports, both of which are CommonJS-only and make the module
// impossible to load from a test under Node's native type stripping.

import { METHODOLOGY_VERSION } from '@stenion/core';
import type { Adapter, ProtocolMetadata, RiskFactorMap } from '@stenion/core';
import type { RunRecord, Store } from '@stenion/db';

/**
 * An adapter bound to its run pipeline. Wrapping each adapter this way keeps
 * its TRawData type internal (an `Adapter<BlendRawData>` is not assignable to
 * `Adapter<unknown>` because computeRiskFactors is contravariant in TRawData),
 * so a heterogeneous list of adapters can share one run loop. `adapterRef` is
 * the concrete adapter class name, persisted as the protocol's adapter column.
 */
export interface IndexTarget {
  metadata: ProtocolMetadata;
  adapterRef: string;
  run(): Promise<{ safetyScore: number; factors: RiskFactorMap; computedAt: Date }>;
}

export function toTarget<T>(adapter: Adapter<T>): IndexTarget {
  return {
    metadata: adapter.metadata,
    adapterRef: adapter.constructor.name,
    run: async () => {
      const raw = await adapter.fetchRawData();
      const factors = await adapter.computeRiskFactors(raw);
      const result = adapter.score(factors);
      return { safetyScore: result.score, factors: result.factors, computedAt: result.computedAt };
    },
  };
}

/** One protocol's outcome in a cycle summary. */
export interface CycleRunResult {
  id: string;
  status: 'ok' | 'failed';
  safetyScore?: number;
  error?: string;
}

/** What one cycle did — returned so the cron route can respond with a summary. */
export interface CycleSummary {
  ran: number;
  ok: number;
  failed: number;
  results: CycleRunResult[];
}

export async function runCycle(targets: IndexTarget[], store: Store): Promise<CycleSummary> {
  const results: CycleRunResult[] = [];

  for (const target of targets) {
    const runAt = new Date().toISOString();

    // Build the run outcome first (adapter errors caught here), then persist it
    // separately so a DB write failure is logged without aborting the cycle.
    let record: RunRecord;
    let result: CycleRunResult;
    try {
      const { safetyScore, factors, computedAt } = await target.run();
      record = {
        protocolId: target.metadata.id,
        status: 'ok',
        safetyScore,
        factors,
        // Stamped here, not by the adapter: one rulebook applies to every
        // protocol, so the version is a property of the run, not of the adapter.
        methodologyVersion: METHODOLOGY_VERSION,
        computedAt: computedAt.toISOString(),
        runAt,
      };
      result = { id: target.metadata.id, status: 'ok', safetyScore };
      console.log(`[${runAt}] ${target.metadata.id}: safetyScore=${safetyScore}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      record = { protocolId: target.metadata.id, status: 'failed', error, runAt };
      result = { id: target.metadata.id, status: 'failed', error };
      console.error(`[${runAt}] ${target.metadata.id}: FAILED — ${error}`);
    }

    try {
      await store.insertRunRecord(record);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[${runAt}] ${target.metadata.id}: DB write failed — ${error}`);
    }

    results.push(result);
  }

  return {
    ran: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}
