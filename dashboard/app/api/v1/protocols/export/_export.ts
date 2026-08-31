import type { CurrentRegistryExportEntry } from '@stenion/db';

import {
  NO_STORE,
  PREFLIGHT_MAX_AGE_SECONDS,
  cacheTtlSeconds,
  publicCacheControl,
} from '../../../_cache.ts';
import { CORS_HEADERS, jsonResponse } from '../../../_http.ts';

export const JSON_EXPORT_FILENAME = 'stenion-registry-current.json';
export const CSV_EXPORT_FILENAME = 'stenion-registry-current.csv';

type ExportFormat = 'json' | 'csv';

interface CurrentRegistryExportStore {
  listCurrentScoredRegistryState(): Promise<CurrentRegistryExportEntry[]>;
}

export interface CurrentRegistryExportHandlerDeps {
  enforceRateLimit(req: Request): Promise<Response | null>;
  getStore(): CurrentRegistryExportStore;
  logError?(...args: unknown[]): void;
}

const TOP_LEVEL_COLUMNS = [
  'id',
  'name',
  'chain',
  'category',
  'logo',
  'deployedOn.host',
  'deployedOn.label',
  'safetyScore',
  'computedAt',
  'methodologyVersion',
  'lastRunAt',
  'lastRunStatus',
  'operationalState.level',
  'operationalState.asOf',
  'operationalState.origin',
  'operationalState.source',
  'operationalState.detail',
  'operationalState.blocked',
] as const;

function parseFormat(req: Request): ExportFormat | null {
  const format = new URL(req.url).searchParams.get('format') ?? 'json';
  return format === 'json' || format === 'csv' ? format : null;
}

function attachment(filename: string): string {
  return `attachment; filename="${filename}"`;
}

function successHeaders(format: ExportFormat, lastRunAts: readonly (string | null)[]) {
  const ttl = cacheTtlSeconds(lastRunAts);
  return {
    'cache-control': publicCacheControl(ttl),
    'content-disposition': attachment(
      format === 'json' ? JSON_EXPORT_FILENAME : CSV_EXPORT_FILENAME,
    ),
  };
}

function csvText(value: string | null | undefined): string {
  if (value == null) return '';
  return csvEscape(preventFormula(value));
}

function csvNumber(value: number | null | undefined): string {
  if (value == null) return '';
  return csvEscape(String(value));
}

function preventFormula(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function factorKeys(protocols: readonly CurrentRegistryExportEntry[]): string[] {
  const keys = new Set<string>();
  for (const protocol of protocols) {
    for (const key of Object.keys(protocol.factors)) keys.add(key);
  }
  return [...keys].sort();
}

function csvColumns(protocols: readonly CurrentRegistryExportEntry[]): string[] {
  return [
    ...TOP_LEVEL_COLUMNS,
    ...factorKeys(protocols).flatMap((key) => [`${key}.value`, `${key}.weight`, `${key}.detail`]),
  ];
}

function csvRow(protocol: CurrentRegistryExportEntry, keys: readonly string[]): string[] {
  return [
    csvText(protocol.id),
    csvText(protocol.name),
    csvText(protocol.chain),
    csvText(protocol.category),
    csvText(protocol.logo),
    csvText(protocol.deployedOn?.host),
    csvText(protocol.deployedOn?.label),
    csvNumber(protocol.safetyScore),
    csvText(protocol.computedAt),
    csvNumber(protocol.methodologyVersion),
    csvText(protocol.lastRunAt),
    csvText(protocol.lastRunStatus),
    csvText(protocol.operationalState?.level),
    csvText(protocol.operationalState?.asOf),
    csvText(protocol.operationalState?.origin),
    csvText(protocol.operationalState?.source),
    csvText(protocol.operationalState?.detail),
    csvText(protocol.operationalState?.blocked.join('; ')),
    ...keys.flatMap((key) => {
      const factor = protocol.factors[key];
      return [csvNumber(factor?.value), csvNumber(factor?.weight), csvText(factor?.detail)];
    }),
  ];
}

export function currentRegistryCsv(protocols: readonly CurrentRegistryExportEntry[]): string {
  const keys = factorKeys(protocols);
  const lines = [
    csvColumns(protocols).map(csvEscape).join(','),
    ...protocols.map((protocol) => csvRow(protocol, keys).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export async function handleCurrentRegistryExportRequest(
  req: Request,
  deps: CurrentRegistryExportHandlerDeps,
): Promise<Response> {
  const limited = await deps.enforceRateLimit(req);
  if (limited) return limited;

  const format = parseFormat(req);
  if (!format) {
    return jsonResponse({ error: 'Unsupported format', supportedFormats: ['json', 'csv'] }, 400, {
      'cache-control': NO_STORE,
    });
  }

  try {
    const protocols = await deps.getStore().listCurrentScoredRegistryState();
    const headers = successHeaders(
      format,
      protocols.map((protocol) => protocol.lastRunAt),
    );
    if (format === 'json') {
      return jsonResponse({ protocols }, 200, headers);
    }

    return new Response(currentRegistryCsv(protocols), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        ...CORS_HEADERS,
        ...headers,
      },
    });
  } catch (err) {
    deps.logError?.('GET /api/v1/protocols/export failed:', err);
    return jsonResponse({ error: 'Internal server error' }, 500, { 'cache-control': NO_STORE });
  }
}

export function currentRegistryExportOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
      'cache-control': publicCacheControl(PREFLIGHT_MAX_AGE_SECONDS),
    },
  });
}
