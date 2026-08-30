// POST /api/cron/run-indexer[?shard=<i>&totalShards=<n>] — trigger ONE indexer cycle
// over ONE shard of the registry.
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
// SHARDING. `?shard=i&totalShards=n` scores only the targets belonging to shard `i`, so a
// registry too big for one 60s invocation is covered by `n` jobs instead of one. Both
// parameters are optional and BOTH-OR-NEITHER: omitting them scores the whole registry,
// which is exactly what this route did before sharding existed, so the job already
// configured keeps working untouched. Which target lands in which shard is decided by
// `selectShard` in @stenion/indexer, from the target ids alone — not here, and not by
// anything in this route's configuration.
//
// THE n JOBS MUST BE STAGGERED, NOT SIMULTANEOUS, and that is a load-bearing detail
// rather than a preference: `STENION_CYCLE_CONCURRENCY` bounds parallel targets WITHIN one
// invocation and has no idea another invocation exists, so two shards fired at the same
// minute put two request streams on the shared public RPC and reproduce the concurrency-2
// incident from a direction the config cannot see. Offset the jobs by a minute or more —
// a cycle is ~16s — and peak in-flight stays at one. The mapping and the offsets are
// written down in architecture/deploy-architecture.md.
//
// PROTECTION: this endpoint writes to the DB and hits RPC/Horizon, so it must not be
// publicly spam-triggerable. It requires `Authorization: Bearer <CRON_SECRET>`,
// compared in constant time. If CRON_SECRET is not configured, the route refuses to
// run (500) rather than execute unprotected. No CORS — this is not a public endpoint.

import { timingSafeEqual } from 'node:crypto';
import { loadEnv } from '@stenion/db';
import { resolveShardSpec, runIndexerCycle } from '@stenion/indexer';

// pg + Soroban/Horizon I/O need the Node.js runtime. A full unsharded cycle (5 targets —
// three Blend pools, Kinetic, and one Aquarius pool) makes several on-chain sim
// calls each, so allow up to 60s (Vercel Hobby max) rather than the 10s default.
// A sharded invocation runs a subset and finishes well inside that.
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

  // Parsed AFTER the auth check, so an unauthenticated caller learns nothing about
  // the parameters this route takes. The rule it enforces (0 <= shard < totalShards)
  // is what guarantees a full rotation covers every target exactly once; it lives in
  // @stenion/indexer because a route handler is not something this repo can load from
  // a test.
  const url = new URL(req.url);
  const parsed = resolveShardSpec(
    url.searchParams.get('shard'),
    url.searchParams.get('totalShards'),
  );
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { shard, totalShards } = parsed.spec;

  try {
    const summary = await runIndexerCycle(parsed.spec);
    // `triggered` (not `ok`) so it doesn't collide with the summary's ok-count.
    // `shard`/`totalShards` are echoed back because verifying coverage means
    // checking that the union of what the shards ran is the whole registry, and a
    // summary that doesn't say which shard produced it cannot be checked that way.
    return Response.json({ triggered: true, shard, totalShards, ...summary });
  } catch (err) {
    // Bad env / unreachable DB throws here; per-protocol scoring errors do NOT
    // (they're captured in the summary). Log the raw error, return a generic 500.
    console.error('Indexer cron cycle failed:', err);
    return Response.json({ error: 'Indexer run failed' }, { status: 500 });
  }
}
