#!/usr/bin/env node
/**
 * Copy ../ui/* into dist/ui/ after tsc emits dist/. The Telegram plugin's
 * activate() serves these as static files via express.static so the
 * package is shippable as a single npm tarball with both code + UI
 * inside dist/.
 *
 * Kept as a small mjs script (no extra build tool) — runs as the post-tsc
 * step in `npm run build`.
 */
import { mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'ui');
const dstDir = join(here, '..', 'dist', 'ui');

function copyRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyRecursive(srcPath, dstPath);
    } else if (st.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

try {
  copyRecursive(srcDir, dstDir);
  console.log(`[telegram] copied UI assets ${srcDir} → ${dstDir}`);
} catch (err) {
  console.error(`[telegram] copy-ui-assets failed: ${err.message}`);
  process.exitCode = 1;
}
