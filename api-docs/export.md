## GET /api/v1/protocols/export

A current snapshot export of the scored registry state, downloadable as JSON or CSV.

This endpoint is intentionally non-historical. It returns one row or object per currently scored
protocol/market, using the same persisted latest-successful score semantics as
[`GET /api/v1/protocols`](protocols.md): `safetyScore`, `computedAt`, `factors`,
`methodologyVersion`, and `operationalState` come from the latest `ok` run, while `lastRunAt` and
`lastRunStatus` describe the newest run of any status. If the latest attempted run failed, the last
successful score remains the exported current score and `lastRunStatus` exposes the failure. A
protocol that has never produced a successful score is excluded from this scored snapshot rather
than exported with nulls or zeros.

Scores are comparable only within one `category`. Export consumers should not rank `lending` and
`dex` rows against each other, and should tolerate new categories and factor keys.

> This endpoint was added after the captured production examples at the top of this document. No
> live response body is included here until it can be captured from a deployed API response; the
> contract below documents the shape without fabricating sample data.

**Request**

```bash
curl -OJ "https://stenion.vercel.app/api/v1/protocols/export?format=json"
curl -OJ "https://stenion.vercel.app/api/v1/protocols/export?format=csv"
```

| Query parameter | Values          | Notes                                           |
| --------------- | --------------- | ----------------------------------------------- |
| `format`        | `json` or `csv` | Optional. Defaults to `json`. Other values 400. |

**Successful responses**

| Format | `Content-Type`                    | `Content-Disposition` filename  |
| ------ | --------------------------------- | ------------------------------- |
| JSON   | `application/json; charset=utf-8` | `stenion-registry-current.json` |
| CSV    | `text/csv; charset=utf-8`         | `stenion-registry-current.csv`  |

Successful responses use the same freshness-aware public cache policy as `/api/v1/protocols`: the
shared-cache TTL is derived from exported rows' `lastRunAt` values, so caching does not hide a newer
run for longer than the documented floor.

### JSON shape

JSON preserves each factor map as structured JSON:

```ts
{
  protocols: Array<{
    id: string;
    name: string;
    chain: string;
    category: string;
    logo: string | null;
    deployedOn: { host: string; label: string } | null;
    safetyScore: number;
    computedAt: string;
    methodologyVersion: number;
    factors: {
      [factorKey: string]: {
        value: number;
        weight: number;
        detail: string;
        components?: Array<{ id: string; label: string; value: number | null; detail: string }>;
      } | null;
    };
    operationalState: {
      level: string;
      asOf: string;
      origin: 'admin' | 'protocol' | 'indeterminate';
      source: string;
      detail: string;
      blocked: string[];
    } | null;
    lastRunAt: string | null;
    lastRunStatus: 'ok' | 'failed' | null;
  }>;
}
```

### CSV shape

CSV has exactly one data row per exported current scored protocol. The stable top-level columns come
first:

```text
id,name,chain,category,logo,deployedOn.host,deployedOn.label,safetyScore,computedAt,methodologyVersion,lastRunAt,lastRunStatus,operationalState.level,operationalState.asOf,operationalState.origin,operationalState.source,operationalState.detail,operationalState.blocked
```

After those, the export builds the deterministic union of factor keys present in that response,
sorts them alphabetically, and emits three columns for each:

```text
<factor>.value,<factor>.weight,<factor>.detail
```

Rows whose category does not use a factor leave that factor's cells empty. `operationalState` is
flattened into its public fields; `operationalState.blocked` is joined as a semicolon-separated text
cell. CSV cells are RFC-4180 escaped for commas, quotes, and CR/LF. Empty, null, or undefined values
serialize as empty cells. Text cells beginning with `=`, `+`, `-`, or `@` after leading whitespace
are prefixed with an apostrophe to avoid spreadsheet formula execution; numeric score, value, and
weight cells are not modified by that mitigation.

**Errors and preflight**

Unsupported formats return `400` with:

```json
{ "error": "Unsupported format", "supportedFormats": ["json", "csv"] }
```

Database failures return the same generic, uncached `500` shape as the other public routes:

```json
{ "error": "Internal server error" }
```

The endpoint is public, read-only, CORS-enabled, and rate limited like the other `/api/v1` data
routes. `OPTIONS` returns the standard public API preflight response.

---
