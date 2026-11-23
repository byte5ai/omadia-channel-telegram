/**
 * Live finding (2026-11-23, byte5 Fly): the admin token was written to the
 * boot log in cleartext on its first generation, and an operator who set a
 * new one through the setup API got it stored in the plain config, not the
 * vault, with no effect, because the manifest had no setup field for it.
 *
 * The token is never logged. It is a secret setup field (vault key
 * `telegram_admin_token`): an operator sets their own to rotate it or to
 * reach the admin UI; without one a random token is generated and kept in
 * the vault, unknown to anyone, until the operator sets one.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureAdminToken } from '../src/adminToken.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = readFileSync(join(here, '..', 'manifest.yaml'), 'utf8');

function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => void store.set(key, value),
  };
}

describe('admin token', () => {
  it('is a secret setup field, so a value set through the setup API lands in the vault', () => {
    assert.match(manifest, /- key: "telegram_admin_token"\s+type: "secret"/);
  });

  it('a generated token is stored in the vault and never logged', async () => {
    const secrets = fakeSecrets();
    const lines: string[] = [];
    const token = await ensureAdminToken(secrets, (line) => lines.push(line));
    assert.ok(token && token.length >= 32);
    assert.equal(secrets.store.get('telegram_admin_token'), token);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(!line.includes(token), `logged the token: ${line}`);
  });

  it('a token the operator set is used as is and not logged', async () => {
    const secrets = fakeSecrets({ telegram_admin_token: 'operator-chosen-token-0123456789' });
    const lines: string[] = [];
    assert.equal(await ensureAdminToken(secrets, (line) => lines.push(line)), 'operator-chosen-token-0123456789');
    for (const line of lines) assert.ok(!line.includes('operator-chosen-token'), `logged the token: ${line}`);
  });

  it('the plugin source logs no admin token value', () => {
    const source = readFileSync(join(here, '..', 'src', 'plugin.ts'), 'utf8');
    assert.doesNotMatch(source, /\$\{adminToken\}/);
  });
});
