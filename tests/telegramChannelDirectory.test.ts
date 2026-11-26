/**
 * byte5ai/omadia#2001 — the keys /operator/channels lists are exactly the
 * ones a turn is resolved on.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { PairingStore, createTelegramChannelDirectory } from '@omadia/channel-telegram';

import { BOT_USERNAME, harness, memoryStore } from './fakes.js';

describe('#2001 — Telegram channel key directory', () => {
  it('lists the bot, activated groups and paired direct chats under the routed keys', async () => {
    const store = new PairingStore(memoryStore());
    await store.putGroupActivation({
      chatId: -100123,
      chatTitle: 'Vertrieb',
      chatType: 'supergroup',
      activatedBy: 'u1',
      activatedVia: 'auto',
      activatedAt: new Date().toISOString(),
    });
    await store.putDmBinding({
      telegramUserId: 42,
      harnessIdentityId: 'u1',
      harnessIdentityLabel: 'Anna',
      telegramUsername: 'anna',
      telegramDisplayName: 'Anna B',
      boundAt: new Date().toISOString(),
    });
    const directory = createTelegramChannelDirectory({
      channelType: 'telegram',
      originPluginId: '@omadia/channel-telegram',
      botUsername: BOT_USERNAME,
      pairingStore: store,
    });
    assert.equal(directory.channelType, 'telegram');
    const rows = await directory.listKeys();
    assert.deepEqual(rows.map((r) => r.key), [`@${BOT_USERNAME}`, '-100123', '42']);
    assert.match(rows[1]!.label, /Vertrieb/);
    assert.match(rows[2]!.label, /Anna B \(@anna\)/);

    // The same keys the bot resolves turns on.
    const h = harness();
    const keys = h.bot.routingKeys(-100123).filter(Boolean);
    assert.ok(keys.includes('-100123') && keys.includes(`@${BOT_USERNAME}`));
  });

  it('degrades to the bot row when the store cannot be read', async () => {
    const errors: string[] = [];
    const directory = createTelegramChannelDirectory({
      channelType: 'telegram',
      originPluginId: 'x',
      botUsername: 'b',
      pairingStore: {
        listDmBindings: async () => { throw new Error('down'); },
        listGroupActivations: async () => { throw new Error('down'); },
      },
      onError: (what) => errors.push(what),
    });
    assert.deepEqual((await directory.listKeys()).map((r) => r.key), ['@b']);
    assert.equal(errors.length, 2);
  });
});
