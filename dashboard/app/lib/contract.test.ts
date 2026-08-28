// Tests for `factorRows` — the ordering the factor breakdown renders from.
//
// WHY THIS EXISTS. Until #82 the breakdown was drawn by walking FACTOR_ORDER and
// reading the map by key, which is correct for exactly one factor set: lending's
// five, today's only rulebook. The same component now renders a HISTORICAL run's
// map as well, and a run stored whatever its own rulebook published. So the rows
// have to come from the map, and the two ways that can go wrong — dropping a key
// the map has, or inventing a row it doesn't — are both silent in the UI. One
// draws less than the data says, the other draws "N/A" for factors that were
// never part of that rulebook. Neither throws.
//
// Run with: pnpm --filter @stenion/dashboard test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FACTOR_ORDER, factorRows, type RiskFactor, type RiskFactorMap } from './contract.ts';

const f = (value: number, over: Partial<RiskFactor> = {}): RiskFactor => ({
  value,
  weight: 0.2,
  detail: `scored ${value}`,
  ...over,
});

/** A full lending map — what every stored run holds today. */
const lending = (): RiskFactorMap => ({
  collateralSafety: f(58),
  oracleSafety: f(100),
  adminKeySafety: f(60),
  liquiditySafety: f(30),
  utilizationSafety: f(72),
});

describe('factorRows — lending, the only rulebook that exists', () => {
  it('renders the five factors in FACTOR_ORDER, whatever order the map declares them in', () => {
    // Not hypothetical: the map arrives from a jsonb column, and Postgres returns
    // jsonb keys in its own storage order — the live blend history hands them
    // back oracle-first, not collateral-first.
    const jsonbOrder = {
      oracleSafety: f(100),
      adminKeySafety: f(60),
      liquiditySafety: f(30),
      collateralSafety: f(58),
      utilizationSafety: f(72),
    } as RiskFactorMap;

    assert.deepEqual(
      factorRows(jsonbOrder).map((r) => r.key),
      FACTOR_ORDER.map((o) => o.key),
    );
  });

  it('carries each factor through by identity, never a copy or a recomputation', () => {
    // This surfaces stored numbers. Anything that rebuilt a factor object here
    // would be a second place a published value could come from.
    const map = lending();
    for (const row of factorRows(map)) {
      assert.equal(row.factor, map[row.key as keyof RiskFactorMap]);
    }
  });

  it('uses FACTOR_ORDER labels, not derived ones', () => {
    assert.deepEqual(
      factorRows(lending()).map((r) => r.label),
      FACTOR_ORDER.map((o) => o.label),
    );
  });

  it('keeps a null factor as a row — "not applicable" is an answer, not an absence', () => {
    const map = { ...lending(), liquiditySafety: null };
    const row = factorRows(map).find((r) => r.key === 'liquiditySafety');
    assert.ok(row, 'a null factor must still get a row to render N/A into');
    assert.equal(row.factor, null);
  });
});

describe('factorRows — a factor set that is not lending’s', () => {
  // A second category has its own factors under its own weights (CATEGORY_FACTORS
  // in core), and a run stamped under an older rulebook has whatever that one
  // published. There is no such data today — one category, one version — so this
  // is the only place either shape is exercised.

  it('renders a foreign factor set instead of five N/A cards', () => {
    const amm = {
      poolDepthSafety: f(64),
      impermanentLossSafety: f(41),
    } as unknown as RiskFactorMap;

    const rows = factorRows(amm);
    assert.deepEqual(
      rows.map((r) => r.key),
      ['poolDepthSafety', 'impermanentLossSafety'],
    );
    assert.deepEqual(
      rows.map((r) => r.factor?.value),
      [64, 41],
    );
  });

  it('derives a readable label for a factor FACTOR_ORDER has no name for', () => {
    const amm = { impermanentLossSafety: f(41) } as unknown as RiskFactorMap;
    assert.equal(factorRows(amm)[0].label, 'Impermanent loss');
  });

  it('drops nothing and invents nothing on a partial map', () => {
    // A run predating a factor being added has fewer keys than the current
    // rulebook. It must render what it has — not a blank card for a factor that
    // was not part of the rules it was scored under.
    const partial = {
      collateralSafety: f(58),
      oracleSafety: f(100),
    } as unknown as RiskFactorMap;

    assert.deepEqual(
      factorRows(partial).map((r) => r.key),
      ['collateralSafety', 'oracleSafety'],
    );
  });

  it('puts known factors first and unknown ones after, in the order the map declares them', () => {
    const mixed = {
      impermanentLossSafety: f(41),
      oracleSafety: f(100),
      poolDepthSafety: f(64),
      collateralSafety: f(58),
    } as unknown as RiskFactorMap;

    assert.deepEqual(
      factorRows(mixed).map((r) => r.key),
      ['collateralSafety', 'oracleSafety', 'impermanentLossSafety', 'poolDepthSafety'],
    );
  });

  it('returns no rows for an empty map rather than five empty ones', () => {
    assert.deepEqual(factorRows({} as RiskFactorMap), []);
  });
});
