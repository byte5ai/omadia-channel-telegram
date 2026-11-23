/**
 * The system texts of the bot (pairing welcome, bare /start greeting, the
 * refusal for an unpaired DM, the group-activation notice) name the system
 * the operator configured (`system_name`, default "omadia"), never a
 * hard-coded product name. The welcome after pairing reads
 * "Willkommen zum <Name> System" / "Welcome to the <Name> system", followed
 * by the identity the chat is connected as.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { PairingTokenRegistry, type TelegramUpdate } from '@omadia/channel-telegram';

import { BOT_ID, harness, type Harness } from './fakes.js';

let updateId = 5000;

function dm(text: string, fromId: number, languageCode?: string): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: 'Anna', ...(languageCode ? { language_code: languageCode } : {}) },
      chat: { id: fromId, type: 'private' },
      date: 0,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
  } as TelegramUpdate;
}

const lastText = (h: Harness): string => String(h.api.sent.at(-1)?.params['text'] ?? '');
const allText = (h: Harness): string => h.api.sent.map((s) => String(s.params['text'] ?? '')).join('\n');

async function pairedWelcome(systemName: string | undefined, languageCode?: string): Promise<string> {
  const pairingTokens = new PairingTokenRegistry();
  const h = harness({ pairingTokens, dmPolicy: 'pairing', ...(systemName !== undefined ? { systemName } : {}) });
  const { token } = pairingTokens.issue({ harnessIdentityId: 'u1', harnessIdentityLabel: 'Anna Example' });
  await h.bot.handleUpdate(dm(`/start ${token}`, 77, languageCode));
  return lastText(h);
}

describe('system name in the bot’s system texts', () => {
  it('the pairing welcome names the configured system (de)', async () => {
    const text = await pairedWelcome('Idaria', 'de');
    assert.match(text, /^Willkommen zum Idaria System/);
    assert.match(text, /Anna Example/);
  });

  it('the pairing welcome names the configured system (en)', async () => {
    const text = await pairedWelcome('Idaria', 'en-GB');
    assert.match(text, /^Welcome to the Idaria system/);
    assert.match(text, /Anna Example/);
  });

  it('without a configured name the system is called omadia', async () => {
    assert.match(await pairedWelcome(undefined, 'de'), /^Willkommen zum omadia System/);
    assert.match(await pairedWelcome('   ', 'de'), /^Willkommen zum omadia System/);
  });

  it('the bare /start greeting and the unpaired refusal name the system', async () => {
    const h = harness({ dmPolicy: 'pairing', systemName: 'Idaria' });
    await h.bot.handleUpdate(dm('/start', 78, 'de'));
    assert.match(lastText(h), /Idaria/);
    await h.bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: updateId,
        from: { id: 78, is_bot: false, first_name: 'Anna', language_code: 'en' },
        chat: { id: 78, type: 'private' },
        date: 0,
        text: 'hello',
      },
    } as TelegramUpdate);
    assert.match(lastText(h), /not connected to the Idaria system/);
  });

  it('the group-activation notice names the system', async () => {
    const h = harness({ systemName: 'Idaria' });
    await h.pairingStore.putDmBinding({
      telegramUserId: 5,
      harnessIdentityId: 'h1',
      harnessIdentityLabel: 'Anna',
      telegramDisplayName: 'Anna',
      boundAt: new Date().toISOString(),
    });
    await h.bot.handleUpdate({
      update_id: updateId++,
      my_chat_member: {
        chat: { id: -1001, type: 'supergroup', title: 'Team' },
        from: { id: 5, is_bot: false, first_name: 'Anna' },
        date: 0,
        old_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: 'left' },
        new_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: 'member' },
      },
    } as TelegramUpdate);
    assert.match(lastText(h), /Idaria/);
  });

  it('no system text names "byte5 Harness" any more', async () => {
    const pairingTokens = new PairingTokenRegistry();
    const h = harness({ pairingTokens, dmPolicy: 'pairing' });
    const { token } = pairingTokens.issue({ harnessIdentityId: 'u1', harnessIdentityLabel: 'Anna' });
    await h.bot.handleUpdate(dm('/start', 79));
    await h.bot.handleUpdate(dm(`/start ${token}`, 79));
    assert.doesNotMatch(allText(h), /byte5 Harness/);
  });
});
