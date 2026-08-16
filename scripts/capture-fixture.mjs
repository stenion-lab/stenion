#!/usr/bin/env node
/* global console, process, URL */
//
// Capture a live mainnet snapshot of an adapter's raw on-chain state, for use as
// a frozen regression fixture (adapters/fixtures/*.json).
//
// This is a MANUAL tool. It hits Soroban RPC and Horizon, so it is never run by
// CI and is not part of `pnpm test` — the fixtures it produces are committed and
// then read offline. Freezing them is the point: a refactor that changes a
// published number should fail loudly against yesterday's real data.
//
// Refresh a fixture only deliberately — when a change to the raw shape makes an
// old one structurally invalid, not on a schedule. A refresh is a reviewed diff
// like any other, and the expected factor values in adapters/snapshot.test.ts
// have to be re-derived alongside it (that re-derivation is the review: if a
// number moved, you need to know why before committing it).
//
// Usage:
//   pnpm capture:fixture blend
//   pnpm capture:fixture kinetic
//   pnpm capture:fixture all
//
// Requires the workspace to be built (`pnpm --filter @stenion/adapters build`)
// and STENION_RPC_URL / STENION_HORIZON_URL in the repo-root .env or the shell.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'adapters', 'fixtures');

/** Load repo-root .env without overriding real environment variables. */
function loadEnv() {
  const path = resolve(REPO_ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && !(key in process.env)) process.env[key] = value;
  }
}

/**
 * Serialize to a TypeScript literal rather than JSON.
 *
 * Two reasons. BigInt has no JSON representation and these shapes are full of
 * them (b_supply, rates, max_util, prices), so JSON would need a lossy string
 * encoding and a reviver. More importantly, a `.ts` fixture is checked by tsc
 * against the adapter's own raw type via `satisfies` — so if `BlendRawData`
 * gains a required field, every stale fixture fails to compile instead of
 * silently feeding the adapter a shape it no longer produces.
 *
 * Output is deliberately unformatted; `pnpm format` normalizes it.
 */
function toLiteral(value) {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(toLiteral).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${toLiteral(v)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`cannot serialize ${typeof value}`);
}

async function main() {
  const which = (process.argv[2] ?? '').toLowerCase();
  if (!['blend', 'kinetic', 'all'].includes(which)) {
    console.error('Usage: pnpm capture:fixture <blend|kinetic|all>');
    process.exitCode = 2;
    return;
  }

  loadEnv();
  const distUrl = pathToFileURL(resolve(REPO_ROOT, 'adapters', 'dist', 'index.js')).href;
  let mod;
  try {
    mod = await import(distUrl);
  } catch (err) {
    throw new Error(
      `Could not load adapters/dist — run \`pnpm --filter @stenion/adapters build\` first.\n  ${err.message}`,
    );
  }

  const opts = {
    rpcUrl: process.env.STENION_RPC_URL,
    horizonUrl: process.env.STENION_HORIZON_URL,
  };
  const targets = {
    blend: () => new mod.BlendAdapter(opts),
    kinetic: () => new mod.KineticAdapter(opts),
  };
  const names = which === 'all' ? ['blend', 'kinetic'] : [which];

  mkdirSync(FIXTURE_DIR, { recursive: true });

  for (const name of names) {
    const adapter = targets[name]();
    console.log(`Capturing ${name} from ${opts.rpcUrl ?? '(adapter default RPC)'} …`);
    const raw = await adapter.fetchRawData();

    const factors = await adapter.computeRiskFactors(raw);
    const score = adapter.score(factors).score;

    // The captured-at stamp is metadata only — nothing reads it at test time.
    // `fetchedAt` *inside* the raw data is what price ages are measured
    // against, and freezing that is what keeps the freshness score stable.
    const typeName = name === 'blend' ? 'BlendRawData' : 'KineticRawData';
    const constName = `${name}Mainnet`;
    const source = `// Frozen mainnet snapshot — generated by scripts/capture-fixture.mjs.
//
// DO NOT HAND-EDIT. Regenerate with \`pnpm capture:fixture ${name}\`, then re-derive
// the expected values in adapters/snapshot.test.ts. If a factor moved, find out
// why before committing — that is the entire point of this file.
//
// Captured: ${new Date().toISOString()}
// At capture time this scored: safetyScore ${score} (${Object.entries(factors)
      .map(([k, f]) => `${k} ${f === null ? 'null' : f.value}`)
      .join(', ')})
//
// \`satisfies\` is load-bearing: if ${typeName} gains a required field, this file
// stops compiling rather than quietly feeding the adapter a stale shape.

import type { ${typeName} } from '../${name}.ts';

export const ${constName} = ${toLiteral(raw)} satisfies ${typeName};
`;

    const file = resolve(FIXTURE_DIR, `${name}-mainnet.ts`);
    writeFileSync(file, source, 'utf8');

    console.log(`  → ${file}`);
    console.log(`    reserves: ${raw.reserves.length}, safetyScore: ${score}`);
    for (const [key, f] of Object.entries(factors)) {
      console.log(`    ${key.padEnd(19)} ${f === null ? 'null' : f.value}`);
    }
    console.log('    (run `pnpm format` to normalize the generated file)');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
