/**
 * The webhooks are registered through `ctx.routes` with `auth: 'custom'`,
 * at exactly the prefixes the manifest declares in `permissions.public_paths`.
 *
 * Found live on 0.7.2: the kernel validates a declared public path against
 * the prefixes the plugin registered through `ctx.routes`. The webhooks were
 * mounted through `core.registerRouter`, which the kernel does not count, so
 * activation failed with "the plugin registered no routers, so it owns no
 * other prefix".
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { createTelegramWebhookRouter, type TelegramBot } from '@omadia/channel-telegram';

const here = dirname(fileURLToPath(import.meta.url));
const pluginSource = readFileSync(join(here, '..', 'src', 'plugin.ts'), 'utf8');

describe('webhook routes', () => {
  it('both webhooks go through ctx.routes with auth custom, none through core.registerRouter', () => {
    const registrations = [...pluginSource.matchAll(/ctx\.routes\.register\(\s*([^,]+),[\s\S]*?\{ auth: 'custom' \}/g)].map(
      (m) => m[1]?.trim(),
    );
    assert.deepEqual(registrations, ['`${WEBHOOK_PATH_PREFIX}${AGENT_BOTS_PATH}`', '`${WEBHOOK_PATH_PREFIX}/webhook`']);
    assert.doesNotMatch(pluginSource, /core\.registerRouter\(ctx\.agentId, WEBHOOK_PATH_PREFIX, /);
  });

  it('the installation’s webhook answers at the root of its own mount', async () => {
    const handled: unknown[] = [];
    const bot = { handleUpdate: async (u: unknown) => void handled.push(u) } as unknown as TelegramBot;
    const app = express();
    app.use('/api/telegram/webhook', createTelegramWebhookRouter({ bot, webhookSecret: 's3cret', path: '/' }));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${String(port)}/api/telegram/webhook`;
      const post = (secret?: string) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
          body: JSON.stringify({ update_id: 1 }),
        });
      assert.equal((await post()).status, 401);
      assert.equal((await post('wrong')).status, 401);
      assert.equal((await post('s3cret')).status, 200);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(handled.length, 1);
    } finally {
      server.close();
    }
  });
});
