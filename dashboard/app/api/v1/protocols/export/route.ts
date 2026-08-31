// GET /api/v1/protocols/export — one-shot current scored registry export.
//
// This is a formatting layer over the same persisted latest-ok score and
// latest-run freshness semantics as GET /api/v1/protocols. It does not recompute
// scores, does not fetch per-protocol detail rows, and deliberately excludes
// protocols that have never produced a successful score.

import { enforceRateLimit, getStore } from '../../../_shared';
import {
  currentRegistryExportOptionsResponse,
  handleCurrentRegistryExportRequest,
} from './_export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handleCurrentRegistryExportRequest(req, {
    enforceRateLimit,
    getStore,
    logError: console.error,
  });
}

export function OPTIONS(): Response {
  return currentRegistryExportOptionsResponse();
}
