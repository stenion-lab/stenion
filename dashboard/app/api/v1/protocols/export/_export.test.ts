import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CurrentRegistryExportEntry } from '@stenion/db';

import {
  CSV_EXPORT_FILENAME,
  JSON_EXPORT_FILENAME,
  currentRegistryCsv,
  currentRegistryExportOptionsResponse,
  handleCurrentRegistryExportRequest,
} from './_export.ts';

const RUN_AT = '2026-08-16T10:05:00.000Z';
const COMPUTED_AT = '2026-08-16T10:00:00.000Z';

function entry(over: Partial<CurrentRegistryExportEntry> = {}): CurrentRegistryExportEntry {
  return {
    id: 'blend',
    name: 'Blend',
    chain: 'stellar',
    category: 'lending',
    logo: '/assets/protocols/blend.svg',
    deployedOn: null,
    safetyScore: 53,
    computedAt: COMPUTED_AT,
    methodologyVersion: 1,
    factors: {
      collateralSafety: { value: 53, weight: 0.2, detail: 'top reserve holds half' },
      oracleSafety: { value: 70, weight: 0.2, detail: 'fresh prices' },
    },
    operationalState: {
      level: 'active',
      source: 'PoolConfig.status = 1',
      blocked: [],
      origin: 'protocol',
      detail: 'pool status 1 (Active)',
      asOf: COMPUTED_AT,
    },
    lastRunAt: RUN_AT,
    lastRunStatus: 'ok',
    ...over,
  };
}

function simpleRows(csv: string): string[][] {
  return csv
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(','));
}

function deps(protocols: CurrentRegistryExportEntry[]) {
  const calls = { rateLimit: 0, store: 0 };
  return {
    calls,
    deps: {
      async enforceRateLimit() {
        calls.rateLimit += 1;
        return null;
      },
      getStore() {
        return {
          async listCurrentScoredRegistryState() {
            calls.store += 1;
            return protocols;
          },
        };
      },
    },
  };
}

describe('currentRegistryCsv', () => {
  it('emits one data row per current scored protocol', () => {
    const csv = currentRegistryCsv([
      entry({ id: 'high', safetyScore: 80 }),
      entry({ id: 'low', safetyScore: 20 }),
    ]);
    assert.equal(simpleRows(csv).length, 3);
  });

  it('uses deterministic factor columns across category-specific maps', () => {
    const csv = currentRegistryCsv([
      entry({
        id: 'dex',
        category: 'dex',
        factors: {
          assetControlSafety: { value: 40, weight: 0.45, detail: 'issuer controls' },
          adminKeySafety: { value: 10, weight: 0.55, detail: 'role posture' },
        },
      }),
      entry({
        id: 'lending',
        factors: {
          collateralSafety: { value: 80, weight: 0.2, detail: 'diverse collateral' },
        },
      }),
    ]);

    const [header, dex, lending] = simpleRows(csv);
    assert.deepEqual(header.slice(-9), [
      'adminKeySafety.value',
      'adminKeySafety.weight',
      'adminKeySafety.detail',
      'assetControlSafety.value',
      'assetControlSafety.weight',
      'assetControlSafety.detail',
      'collateralSafety.value',
      'collateralSafety.weight',
      'collateralSafety.detail',
    ]);
    assert.deepEqual(dex.slice(-3), ['', '', ''], 'absent lending factor cells stay empty');
    assert.deepEqual(lending.slice(-9, -6), ['', '', ''], 'absent dex factor cells stay empty');
  });

  it('flattens operationalState and deployment fields', () => {
    const csv = currentRegistryCsv([
      entry({
        deployedOn: { host: 'Blend', label: 'Blend V2 pool' },
        operationalState: {
          level: 'entryDisabled',
          source: 'PoolConfig.status = 4',
          blocked: ['supply', 'borrow'],
          origin: 'admin',
          detail: 'borrowing and supplying are disabled',
          asOf: COMPUTED_AT,
        },
      }),
    ]);
    const [header, row] = simpleRows(csv);
    const at = (column: string) => row[header.indexOf(column)];
    assert.equal(at('deployedOn.host'), 'Blend');
    assert.equal(at('deployedOn.label'), 'Blend V2 pool');
    assert.equal(at('operationalState.level'), 'entryDisabled');
    assert.equal(at('operationalState.blocked'), 'supply; borrow');
  });

  it('leaves null operationalState and null factor values empty rather than inventing values', () => {
    const csv = currentRegistryCsv([
      entry({
        logo: null,
        operationalState: null,
        factors: {
          collateralSafety: null,
        },
      }),
    ]);
    const [header, row] = simpleRows(csv);
    const at = (column: string) => row[header.indexOf(column)];
    assert.equal(at('logo'), '');
    assert.equal(at('operationalState.level'), '');
    assert.equal(at('collateralSafety.value'), '');
    assert.equal(at('collateralSafety.weight'), '');
    assert.equal(at('collateralSafety.detail'), '');
  });

  it('escapes commas, quotes, CR/LF and formula-leading text cells safely', () => {
    const csv = currentRegistryCsv([
      entry({
        name: '=Formula Market',
        factors: {
          collateralSafety: {
            value: 53,
            weight: 0.2,
            detail: 'comma, quote " and newline\ninside',
          },
          oracleSafety: {
            value: 70,
            weight: 0.2,
            detail: '-starts like a spreadsheet formula',
          },
        },
      }),
    ]);
    assert.match(csv, /blend,'=Formula Market,/);
    assert.match(csv, /"comma, quote "" and newline\ninside"/);
    assert.match(csv, /'-starts like a spreadsheet formula/);
    assert.match(csv, /\r\n$/);
  });
});

describe('handleCurrentRegistryExportRequest', () => {
  it('defaults to JSON with the documented envelope and attachment headers', async () => {
    const fixture = [entry()];
    const { calls, deps: handlerDeps } = deps(fixture);
    const res = await handleCurrentRegistryExportRequest(
      new Request('https://stenion.test/api/v1/protocols/export'),
      handlerDeps,
    );

    assert.equal(calls.rateLimit, 1);
    assert.equal(calls.store, 1);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(
      res.headers.get('content-disposition'),
      `attachment; filename="${JSON_EXPORT_FILENAME}"`,
    );
    assert.match(res.headers.get('cache-control') ?? '', /^public, max-age=0, s-maxage=/);
    assert.deepEqual(await res.json(), { protocols: fixture });
  });

  it('supports CSV with a text/csv content type and attachment filename', async () => {
    const { deps: handlerDeps } = deps([entry()]);
    const res = await handleCurrentRegistryExportRequest(
      new Request('https://stenion.test/api/v1/protocols/export?format=csv'),
      handlerDeps,
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(
      res.headers.get('content-disposition'),
      `attachment; filename="${CSV_EXPORT_FILENAME}"`,
    );
    assert.match(await res.text(), /^id,name,chain,category,logo,/);
  });

  it('rejects unsupported formats without querying the store', async () => {
    const { calls, deps: handlerDeps } = deps([entry()]);
    const res = await handleCurrentRegistryExportRequest(
      new Request('https://stenion.test/api/v1/protocols/export?format=xml'),
      handlerDeps,
    );

    assert.equal(calls.rateLimit, 1);
    assert.equal(calls.store, 0);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), {
      error: 'Unsupported format',
      supportedFormats: ['json', 'csv'],
    });
  });

  it('returns a rate-limit response before format parsing or store work', async () => {
    const limited = new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    let storeCalled = false;
    const res = await handleCurrentRegistryExportRequest(
      new Request('https://stenion.test/api/v1/protocols/export?format=xml'),
      {
        async enforceRateLimit() {
          return limited;
        },
        getStore() {
          storeCalled = true;
          return {
            async listCurrentScoredRegistryState() {
              return [entry()];
            },
          };
        },
      },
    );

    assert.equal(res, limited);
    assert.equal(storeCalled, false);
  });

  it('keeps 500 responses generic and uncached', async () => {
    const logs: unknown[][] = [];
    const res = await handleCurrentRegistryExportRequest(
      new Request('https://stenion.test/api/v1/protocols/export?format=csv'),
      {
        async enforceRateLimit() {
          return null;
        },
        getStore() {
          return {
            async listCurrentScoredRegistryState() {
              throw new Error('raw database details');
            },
          };
        },
        logError: (...args) => logs.push(args),
      },
    );

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { error: 'Internal server error' });
    assert.equal(logs.length, 1);
  });
});

describe('currentRegistryExportOptionsResponse', () => {
  it('matches the public API CORS preflight contract', () => {
    const res = currentRegistryExportOptionsResponse();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(res.headers.get('access-control-max-age'), '86400');
    assert.match(res.headers.get('cache-control') ?? '', /^public, max-age=0, s-maxage=86400$/);
  });
});
