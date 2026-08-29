// POST /api/cron/run-indexer — trigger ONE indexer cycle.
//
// The indexer is NOT a long-running deployed process on Vercel (serverless has no
// always-on scheduler, and Hobby-tier Vercel Cron is capped at once-per-day). Instead
// this route runs a single scoring cycle when hit, and an EXTERNAL scheduler —
// cron-job.org — POSTs to it every 5 minutes with `Authorization: Bearer <CRON_SECRET>`.
// The scoring logic itself is unchanged — this calls the same runIndexerCycle() the
// standalone indexer uses.
//
// THE SCHEDULE IS NOT IN THIS REPO. It lives in the cron-job.org dashboard, so there is
// no workflow file, vercel.json `crons` entry, or any other scheduling config to find in
// version control — changing the cadence means logging into that service.
//
// PROTECTION: this endpoint writes to the DB and hits RPC/Horizon, so it must not be
// publicly spam-triggerable. It requires `Authorization: Bearer <CRON_SECRET>`,
// compared in constant time. If CRON_SECRET is not configured, the route refuses to
// run (500) rather than execute unprotected. No CORS — this is not a public endpoint.

import { timingSafeEqual } from 'node:crypto';
import { loadEnv } from '@stenion/db';
import { runIndexerCycle } from '@stenion/indexer';

// pg + Soroban/Horizon I/O need the Node.js runtime. A full cycle (5 targets —
// three Blend pools, Kinetic, and one Aquarius pool) makes several on-chain sim
// calls each, so allow up to 60s (Vercel Hobby max) rather than the 10s default.
// The cycle's own wall-clock budget (STENION_CYCLE_BUDGET_MS, 50s) is what keeps
// it inside this ceiling; see architecture/ on why a budget rather than a fixed
// schedule, and why 50s is the last value that fits under 60.
//
// The summary this route returns carries per-target `durationMs` and a whole-cycle
// `totalMs`. That is the ONLY honest way to check the budget arithmetic: it has to
// be measured on Vercel's path to the RPC, and a developer machine's path is not
// that one. `curl` this route after a deploy and read the numbers back.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Constant-time string compare; false fast on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: Request): Promise<Response> {
  // Populate process.env from the repo-root .env when running locally (walk-up);
  // a no-op on Vercel where CRON_SECRET/DATABASE_URL/RPC vars come from the
  // project's configured environment.
  loadEnv();

  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    // Misconfiguration — never run the trigger unprotected.
    console.error('CRON_SECRET is not set; refusing to run the indexer cron route.');
    return Response.json({ error: 'Cron trigger not configured' }, { status: 500 });
  }

  const auth = req.headers.get('authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!provided || !safeEqual(provided, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runIndexerCycle();
    // `triggered` (not `ok`) so it doesn't collide with the summary's ok-count.
    return Response.json({ triggered: true, ...summary });
  } catch (err) {
    // Bad env / unreachable DB throws here; per-protocol scoring errors do NOT
    // (they're captured in the summary). Log the raw error, return a generic 500.
    console.error('Indexer cron cycle failed:', err);
    return Response.json({ error: 'Indexer run failed' }, { status: 500 });
  }
}
