import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateOracleStaleness } from './oracle-staleness.ts';
import type { HistoryEntry } from './contract.ts';

describe('calculateOracleStaleness', () => {
  it('returns zeros for empty history', () => {
    const summary = calculateOracleStaleness([]);
    assert.deepEqual(summary, {
      assessedRuns: 0,
      staleRuns: 0,
      stalePercentage: 0,
      totalRuns: 0,
    });
  });

  it('correctly calculates staleness across ok runs', () => {
    const history: HistoryEntry[] = [
      {
        status: 'ok',
        safetyScore: 80,
        methodologyVersion: 2,
        computedAt: '2026-08-16T12:00:00Z',
        runAt: '2026-08-16T12:00:00Z',
        factors: {
          oracleSafety: {
            value: 100,
            weight: 0.25,
            detail: 'fresh',
            components: [
              { id: 'priceFreshness', label: 'Freshness', value: 100, detail: 'current' },
            ],
          },
        },
      },
      {
        status: 'ok',
        safetyScore: 40,
        methodologyVersion: 2,
        computedAt: '2026-08-16T11:00:00Z',
        runAt: '2026-08-16T11:00:00Z',
        factors: {
          oracleSafety: {
            value: 20,
            weight: 0.25,
            detail: 'stale prices',
            components: [{ id: 'priceFreshness', label: 'Freshness', value: 0, detail: 'stale' }],
          },
        },
      },
      {
        status: 'failed',
        error: 'network error',
        runAt: '2026-08-16T10:00:00Z',
      },
    ];

    const summary = calculateOracleStaleness(history);
    assert.equal(summary.totalRuns, 3);
    assert.equal(summary.assessedRuns, 2);
    assert.equal(summary.staleRuns, 1);
    assert.equal(summary.stalePercentage, 50);
  });

  it('correctly tracks high-staleness scenario (e.g. K2 93% stale runs)', () => {
    const history: HistoryEntry[] = [];
    // 93 stale runs
    for (let i = 0; i < 93; i++) {
      history.push({
        status: 'ok',
        safetyScore: 30,
        methodologyVersion: 2,
        computedAt: new Date(1760000000000 + i * 300000).toISOString(),
        runAt: new Date(1760000000000 + i * 300000).toISOString(),
        factors: {
          oracleSafety: {
            value: 0,
            weight: 0.25,
            detail: 'dead prices',
            components: [{ id: 'priceFreshness', label: 'Freshness', value: 0, detail: 'dead' }],
          },
        },
      });
    }
    // 7 fresh runs
    for (let i = 0; i < 7; i++) {
      history.push({
        status: 'ok',
        safetyScore: 90,
        methodologyVersion: 2,
        computedAt: new Date(1760000000000 + (93 + i) * 300000).toISOString(),
        runAt: new Date(1760000000000 + (93 + i) * 300000).toISOString(),
        factors: {
          oracleSafety: {
            value: 100,
            weight: 0.25,
            detail: 'fresh prices',
            components: [{ id: 'priceFreshness', label: 'Freshness', value: 100, detail: 'fresh' }],
          },
        },
      });
    }

    const summary = calculateOracleStaleness(history);
    assert.equal(summary.assessedRuns, 100);
    assert.equal(summary.staleRuns, 93);
    assert.equal(summary.stalePercentage, 93);
  });
});
