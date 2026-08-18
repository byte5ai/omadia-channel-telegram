#!/usr/bin/env node
/**
 * build-zip.mjs — compile an Omadia plugin/channel and produce an uploadable ZIP.
 *
 * Run it from a plugin package directory (it reads ./package.json from the
 * current working directory):
 *
 *     npm run build        # → out/<id>-<version>.zip
 *
 * Why esbuild and not plain `tsc`?
 *   The Omadia host resolves a plugin's bare imports against ITS OWN
 *   node_modules. Anything the host does NOT already ship (e.g. discord.js,
 *   @slack/web-api, an SDK you add) must therefore be BUNDLED into
 *   dist/plugin.js. We esbuild-bundle `src/plugin.ts` → `dist/plugin.js`
 *   (ESM), keeping only the host-provided peers external (see `external`
 *   below). A pure agent with no extra deps bundles to a tiny file all the
 *   same — one code path for every plugin kind.
 *
 * Steps:
 *   1) esbuild bundle  → dist/plugin.js
 *   2) verify the entry exists
 *   3) stage runtime artefacts into out/<id>-<version>-package/
 *   4) zip into out/<id>-<version>.zip
 *
 * Run `npm run typecheck` separately for the tsc gate.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

const pkgRoot = process.cwd();

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: "name" and "version" are required');
}

// --- 1) esbuild bundle -----------------------------------------------------
// ESM banner so any bundled CJS dependency can still call require / __dirname
// / __filename inside the ESM output.
const ESM_BANNER = [
  "import { createRequire as ___createRequire } from 'node:module';",
  "import { fileURLToPath as ___fileURLToPath } from 'node:url';",
  "import { dirname as ___dirname } from 'node:path';",
  'const require = ___createRequire(import.meta.url);',
  'const __filename = ___fileURLToPath(import.meta.url);',
  'const __dirname = ___dirname(__filename);',
].join('\n');

// The host loads this file (manifest `lifecycle.entry`), so it's what we
// bundle AND what we verify below — not package.json's `main` (a tsc artifact).
const BUNDLE_OUTFILE = 'dist/plugin.js';

console.log('▶ esbuild bundle');
await build({
  entryPoints: [join(pkgRoot, 'src/plugin.ts')],
  outfile: join(pkgRoot, BUNDLE_OUTFILE),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: ESM_BANNER },
  external: [
    // Host-provided peers — NEVER bundle these; the Omadia host supplies them.
    '@omadia/plugin-api',
    '@omadia/channel-sdk',
    'express',
    // Optional native acceleration modules some platform SDKs (discord.js / ws,
    // voice libs, …) load via try/catch. Keeping them external + absent is
    // handled gracefully at runtime. Add your SDK's optionals here as needed.
    'zlib-sync',
    'bufferutil',
    'utf-8-validate',
  ],
});

// --- 2) verify entry -------------------------------------------------------
const entryAbs = join(pkgRoot, BUNDLE_OUTFILE);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  throw new Error(`entry not found after bundle: ${BUNDLE_OUTFILE}`);
}

// --- 3) stage runtime artefacts -------------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const stageName = `${safeName}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// Everything the host needs at runtime. `skills/` ships prompt-partials that
// agents load at activation — it MUST be in the ZIP. node_modules must NOT.
const INCLUDE = ['manifest.yaml', 'dist', 'assets', 'skills', 'README.md', 'LICENSE', 'NOTICE'];

for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, entry), { recursive: true });
}

// package.json is staged, not copied: devDependencies are removed first.
// Nothing installs them from a plugin ZIP, and this package's
// `@omadia/channel-sdk` entry is a `file:../odoo-bot/middleware/...` path — the
// published 0.2.0 artifact carries it today, which puts one machine's
// directory layout into a publicly downloadable file and would break any host
// that ran an install against it.
const stagedPkg = { ...pkg };
delete stagedPkg.devDependencies;
writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`);

// --- 4) zip ----------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

createZip({ zipPath, stageName, stageDir, cwd: join(pkgRoot, 'out') });

console.log(`✓ built ${zipPath}`);

/**
 * Archive `stageName` into `zipPath` using whichever zipper is available.
 * `zip` (Linux/macOS, Git-Bash) is tried first; on Windows it's usually
 * absent, so we fall back to 7-Zip and then to the built-in PowerShell
 * `Compress-Archive`. Every strategy produces the same layout: the archive
 * contains a top-level `stageName/` folder. Throws only if none succeed.
 */
function createZip({ zipPath, stageName, stageDir, cwd }) {
  const strategies = [
    {
      label: 'zip',
      cmd: 'zip',
      args: ['-r', '-q', zipPath, stageName],
      opts: { cwd, stdio: 'inherit' },
    },
    {
      label: '7z',
      cmd: '7z',
      args: ['a', '-tzip', '-bd', '-bso0', zipPath, stageName],
      opts: { cwd, stdio: 'inherit' },
    },
    {
      // Windows built-in. -LiteralPath the staged dir so its leaf name
      // (`stageName`) becomes the archive root, matching `zip -r`.
      label: 'Compress-Archive',
      cmd: process.platform === 'win32' ? 'powershell' : 'pwsh',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -LiteralPath '${stageDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      opts: { cwd, stdio: 'inherit' },
    },
  ];

  const attempted = [];
  for (const s of strategies) {
    const res = spawnSync(s.cmd, s.args, s.opts);
    // ENOENT → tool not installed; try the next strategy.
    if (res.error && res.error.code === 'ENOENT') {
      attempted.push(`${s.label} (not found)`);
      continue;
    }
    if (res.error) {
      attempted.push(`${s.label} (${res.error.message})`);
      continue;
    }
    if (res.status === 0 && existsSync(zipPath)) return; // success
    attempted.push(`${s.label} (exit ${res.status})`);
  }

  throw new Error(
    `could not create ${zipPath} — no working zip tool. Tried: ${attempted.join(', ')}. ` +
      'Install `zip`, install 7-Zip (`7z`), or ensure PowerShell (Compress-Archive) is available.',
  );
}