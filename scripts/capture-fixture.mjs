#!/usr/bin/env node
/* global console, process, URL */
//
// Capture a live mainnet snapshot of an adapter's raw on-chain state, for use as
// a frozen regression fixture (adapters/fixtures/**/*.ts).
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
//   pnpm capture:fixture yieldblox
//   pnpm capture:fixture etherfuse
//   pnpm capture:fixture aquarius        (all five Aquarius pools)
//   pnpm capture:fixture aquarius-xlm-usdc   (one of them — see AQUARIUS below)
//   pnpm capture:fixture all
//
// `blend`, `yieldblox` and `etherfuse` are three POOLS behind one adapter, not
// three adapters — BlendAdapter pointed at BLEND_FIXED_V2, BLEND_YIELDBLOX_V2
// and BLEND_ETHERFUSE_V2. They get separate fixtures because they are separate
// on-chain state: different oracle aggregator, different admin, different
// reserve set. The shared engine is exactly what makes all three worth having —
// a decode regression that the three tidy Fixed reserves happen to survive shows
// up in YieldBlox's eight.
//
// EVERY ADAPTER SCORES AGAIN, AquariusAdapter included. Targets still
// carry `scorable`, and it still means "this category has a published rulebook a
// number can come from" rather than anything about the pool — an unscorable
// target captures the raw shape and skips the factor summary rather than being
// excluded from fixtures. It is kept because the two-step category admission
// TAXONOMY.md requires (factor set, then weight table) puts the next category
// through the same state Aquarius passed through before its scoring half
// landed.
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
  // Aquarius's five pools are individually addressable for the reason blend /
  // yieldblox / etherfuse are: they are five markets behind one adapter, and
  // re-capturing all five to refresh one would silently refresh four frozen
  // fixtures whose snapshot expectations then have to be re-derived. A refresh
  // is a reviewed diff, so it has to be possible to ask for exactly one.
  const AQUARIUS = [
    'aquarius-xlm-usdc',
    'aquarius-constant-product',
    'aquarius-stable',
    'aquarius-concentrated',
    'aquarius-wasm-token',
  ];
  const VALID = ['blend', 'kinetic', 'yieldblox', 'etherfuse', 'aquarius', ...AQUARIUS, 'all'];
  if (!VALID.includes(which)) {
    console.error(`Usage: pnpm capture:fixture <${VALID.join('|')}>`);
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
  // Each entry names the adapter instance AND the raw type its fixture is
  // checked against, because those no longer line up one-to-one: two of these
  // are BlendAdapter on different pools, so the type is shared while the state
  // is not.
  const targets = {
    blend: {
      type: 'BlendRawData',
      module: 'blend',
      scorable: true,
      make: () => new mod.BlendAdapter({ ...opts, pool: mod.BLEND_FIXED_V2 }),
    },
    kinetic: {
      type: 'KineticRawData',
      module: 'kinetic',
      scorable: true,
      make: () => new mod.KineticAdapter(opts),
    },
    yieldblox: {
      type: 'BlendRawData',
      module: 'blend',
      scorable: true,
      make: () => new mod.BlendAdapter({ ...opts, pool: mod.BLEND_YIELDBLOX_V2 }),
    },
    etherfuse: {
      type: 'BlendRawData',
      module: 'blend',
      scorable: true,
      make: () => new mod.BlendAdapter({ ...opts, pool: mod.BLEND_ETHERFUSE_V2 }),
    },

    // ---- Aquarius (dex) ----------------------------------------------------
    //
    // FIVE POOLS BEHIND ONE ADAPTER. Four are chosen to exercise every branch
    // the fetch layer has, because live Aquarius state is otherwise monotonous —
    // all 340 pools share one admin posture, so a single fixture would freeze
    // almost nothing. The fifth is the REGISTERED market, which is a
    // different job: those four are branch coverage and this one is the pool the
    // public registry actually publishes a number about.
    //
    //   xlm-usdc          THE REGISTERED POOL — read from AQUARIUS_POOLS, so the
    //                     fixture can never be captured from a pool the registry
    //                     does not score
    //   constant-product  two SAC tokens, real reserves, 100 bps
    //   stable            THREE tokens — the no-hardcoded-pair rule, exercised
    //                     rather than asserted (3 of 304 token sets are these)
    //   concentrated      where get_reserves() means the total across all tick
    //                     ranges rather than the tradable balance
    //   wasm-token        holds a non-SAC token, the only branch that produces a
    //                     route-(a) `notApplicable` issuer disclosure
    'aquarius-xlm-usdc': {
      type: 'AquariusRawData',
      module: 'aquarius',
      dir: 'aquarius',
      scorable: true,
      // The pool object comes from the registry rather than being repeated here:
      // a fixture captured from a hand-typed address could freeze a pool the
      // indexer does not run, and the snapshot test would then pin nothing.
      make: () => new mod.AquariusAdapter({ ...opts, pool: mod.AQUARIUS_XLM_USDC }),
    },
    'aquarius-constant-product': {
      type: 'AquariusRawData',
      module: 'aquarius',
      dir: 'aquarius',
      scorable: true,
      make: () =>
        new mod.AquariusAdapter({
          ...opts,
          pool: {
            id: 'aquarius-xlm-aqua',
            name: 'Aquarius XLM/AQUA',
            poolId: 'CCSY43EHJAHT3NQDYKAMJXRFBEEH7OXDL3J3VNGO33UUSEXWNN27GBIZ',
          },
        }),
    },
    'aquarius-stable': {
      type: 'AquariusRawData',
      module: 'aquarius',
      dir: 'aquarius',
      scorable: true,
      make: () =>
        new mod.AquariusAdapter({
          ...opts,
          pool: {
            id: 'aquarius-stable-3',
            name: 'Aquarius 3-token stable',
            poolId: 'CD6VHCKSUPGQVQPEQUI6EAEO6Z4PXMFTPHW3UTAOF7W4UF7TH7ZSKZBG',
          },
        }),
    },
    'aquarius-concentrated': {
      type: 'AquariusRawData',
      module: 'aquarius',
      dir: 'aquarius',
      scorable: true,
      make: () =>
        new mod.AquariusAdapter({
          ...opts,
          pool: {
            id: 'aquarius-concentrated',
            name: 'Aquarius XLM/AQUA concentrated',
            poolId: 'CA4HTZNY2RBZWEQE5GBMNREZMFRPAZSVJ6OGPC7T3VM7NHRJYFAVID2S',
          },
        }),
    },
    'aquarius-wasm-token': {
      type: 'AquariusRawData',
      module: 'aquarius',
      dir: 'aquarius',
      scorable: true,
      make: () =>
        new mod.AquariusAdapter({
          ...opts,
          pool: {
            id: 'aquarius-wasm-token',
            name: 'Aquarius pool holding a wasm token',
            poolId: 'CA262ONRV6P2IZPFVCTQNIU5XZIPZE4RLZNSOVJUNFUWDQR6MBNKS3IB',
          },
        }),
    },
  };
  const names =
    which === 'all'
      ? ['blend', 'kinetic', 'yieldblox', 'etherfuse', ...AQUARIUS]
      : which === 'aquarius'
        ? AQUARIUS
        : [which];

  mkdirSync(FIXTURE_DIR, { recursive: true });

  for (const name of names) {
    const target = targets[name];
    const adapter = target.make();
    console.log(
      `Capturing ${name} (${adapter.metadata.contractId}) from ` +
        `${opts.rpcUrl ?? '(adapter default RPC)'} …`,
    );
    const started = Date.now();
    const raw = await adapter.fetchRawData();
    const fetchMs = Date.now() - started;

    // An adapter with no rulebook behind it cannot be asked for a number. See
    // the header: `scorable: false` is a property of the CATEGORY's rulebook,
    // not of this pool.
    const factors = target.scorable ? await adapter.computeRiskFactors(raw) : null;
    const score = factors === null ? null : adapter.score(factors).score;

    // The captured-at stamp is metadata only — nothing reads it at test time.
    // `fetchedAt` *inside* the raw data is what price ages are measured
    // against, and freezing that is what keeps the freshness score stable.
    const typeName = target.type;
    const constName = `${name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Mainnet`;
    // A target may nest its fixtures in a subfolder — `aquarius/` holds four,
    // which is enough to be worth grouping. The folder already says which
    // adapter they belong to, so the filename drops the redundant prefix while
    // the EXPORTED CONST keeps it: `aquariusStableMainnet` has to stay
    // unambiguous at an import site, where the folder is not visible.
    const outDir = target.dir ? resolve(FIXTURE_DIR, target.dir) : FIXTURE_DIR;
    const fileBase =
      target.dir && name.startsWith(`${target.dir}-`) ? name.slice(target.dir.length + 1) : name;
    // ../ per level from the fixture back up to adapters/.
    const upToAdapters = target.dir ? '../../' : '../';
    const source = `// Frozen mainnet snapshot — generated by scripts/capture-fixture.mjs.
//
// DO NOT HAND-EDIT. Regenerate with \`pnpm capture:fixture ${name}\`, then re-derive
// the expected values in adapters/snapshot.test.ts. If a factor moved, find out
// why before committing — that is the entire point of this file.
//
// Captured: ${new Date().toISOString()}
// ${
      factors === null
        ? 'Not scored at capture time: this adapter has no scoring implementation yet, so ' +
          'its scoring methods throw by design. This fixture freezes the RAW SHAPE.'
        : `At capture time this scored: safetyScore ${score} (${Object.entries(factors)
            .map(([k, f]) => `${k} ${f === null ? 'null' : f.value}`)
            .join(', ')})`
    }
//
// \`satisfies\` is load-bearing: if ${typeName} gains a required field, this file
// stops compiling rather than quietly feeding the adapter a stale shape.

import type { ${typeName} } from '${upToAdapters}${target.module}/index.ts';

export const ${constName} = ${toLiteral(raw)} satisfies ${typeName};
`;

    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `${fileBase}-mainnet.ts`);
    writeFileSync(file, source, 'utf8');

    console.log(`  → ${file}`);
    // `reserves` is Blend/Kinetic's word for it; Aquarius calls the same thing
    // reserves too, but nothing here may assume a field that a future adapter
    // has no equivalent of.
    const size = Array.isArray(raw.reserves) ? `reserves: ${raw.reserves.length}, ` : '';
    console.log(`    ${size}fetch: ${fetchMs}ms, safetyScore: ${score ?? 'n/a (not scorable)'}`);
    for (const [key, f] of Object.entries(factors ?? {})) {
      console.log(`    ${key.padEnd(19)} ${f === null ? 'null' : f.value}`);
    }
    console.log('    (run `pnpm format` to normalize the generated file)');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
