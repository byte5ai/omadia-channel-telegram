#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 * Same shape as `omadia-channel-teams/scripts/test.mjs`, deliberately: two
 * channel plugins that run their tests two different ways is one more thing to
 * remember for no benefit. Node's built-in test runner (`node:test`) + assert
 * drive the tests; esbuild (already a dev dependency) transpiles each
 * `tests/*.test.ts` into `.test-build/` first.
 *
 * `@omadia/channel-telegram` is kept external so tests exercise the built
 * `dist/` (self-reference via package.json `exports`, requires a build first);
 * the `@omadia/*` peers are external too since tests only import types from
 * them, which are erased. Then `node --test` runs the transpiled output.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

if (!existsSync(testsDir)) {
  console.error('no tests/ directory');
  process.exit(1);
}

const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

// The suite imports the package by name, which resolves to `dist/`. Without a
// build that import fails with a module-not-found that reads like a broken test
// rather than a missing step, so say what is actually wrong.
if (!existsSync(join(pkgRoot, 'dist', 'index.js'))) {
  console.error('dist/ is missing — run `npm run build` (or `npx tsc`) first');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  external: [
    '@omadia/channel-telegram',
    '@omadia/channel-sdk',
    '@omadia/orchestrator',
    '@omadia/plugin-api',
  ],
});

const built = readdirSync(outDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(outDir, f));

console.log('▶ node --test');
const res = spawnSync(process.execPath, ['--test', ...built], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
