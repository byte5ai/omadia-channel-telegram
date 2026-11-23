/**
 * Telegram delivers updates to the bot webhooks without an omadia session.
 * The kernel's blanket session gate answers every `/api/*` request that is
 * neither a core exemption nor a granted plugin public path with
 * `401 auth.missing`, so a webhook the manifest does not declare never reaches
 * its handler: the installation's bot and every agent bot stay silent in
 * webhook mode (found live on 2026-11-23, omadia-channel-telegram#8).
 *
 * The declared prefixes must be exactly the two webhook mounts and must not
 * open the admin router, which authenticates with its own bearer token and has
 * no reason to skip the session gate.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = readFileSync(join(here, '..', 'manifest.yaml'), 'utf8');

/** The list under `permissions.public_paths`, read without a YAML dependency. */
function declaredPublicPaths(text: string): string[] {
  const lines = text.split('\n');
  const permissionsAt = lines.findIndex((l) => /^permissions:\s*$/.test(l));
  assert.ok(permissionsAt >= 0, 'manifest has a permissions block');
  const paths: string[] = [];
  let inList = false;
  for (const line of lines.slice(permissionsAt + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    if (/^ {2}public_paths:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const item = /^ {4}- "([^"]+)"\s*$/.exec(line);
    if (item?.[1]) {
      paths.push(item[1]);
      continue;
    }
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    break;
  }
  return paths;
}

describe('manifest public paths', () => {
  const paths = declaredPublicPaths(manifest);

  it('declares the webhook of the installation’s own bot', () => {
    assert.ok(paths.includes('/api/telegram/webhook'), `declared: ${JSON.stringify(paths)}`);
  });

  it('declares the webhooks of the agents’ own bots', () => {
    assert.ok(paths.includes('/api/telegram/agent-bots'), `declared: ${JSON.stringify(paths)}`);
  });

  it('does not open the admin router or the whole namespace', () => {
    for (const p of paths) {
      assert.ok(!p.startsWith('/api/telegram/admin'), `admin must stay behind the session: ${p}`);
      assert.notEqual(p, '/api/telegram');
    }
  });
});
