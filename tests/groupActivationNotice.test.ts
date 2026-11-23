/**
 * Live finding (2026-11-23): an agent's own bot cannot write to a person who
 * never opened a chat with it, so the group-activation notice by DM failed
 * with 403 and nobody learned that the group was activated. The notice now
 * goes to the group itself when the direct message is refused.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { TelegramUpdate } from '@omadia/channel-telegram';

import { BOT_ID, harness, recordingApi } from './fakes.js';

describe('group activation notice', () => {
  it('goes to the group when the direct message to the adder is refused', async () => {
    const base = recordingApi();
    const refusingDm = {
      ...base.client,
      sendMessage: async (p: Record<string, unknown>) => {
        if (p['chat_id'] === 5) throw new Error("Forbidden: bot can't initiate conversation with a user (403)");
        return (base.client.sendMessage as (q: Record<string, unknown>) => Promise<unknown>)(p);
      },
    };
    const h = harness({ systemName: 'Idaria', api: refusingDm as never });
    await h.pairingStore.putDmBinding({
      telegramUserId: 5,
      harnessIdentityId: 'h1',
      harnessIdentityLabel: 'Anna',
      telegramDisplayName: 'Anna',
      boundAt: new Date().toISOString(),
    });
    await h.bot.handleUpdate({
      update_id: 9001,
      my_chat_member: {
        chat: { id: -1002, type: 'supergroup', title: 'Team' },
        from: { id: 5, is_bot: false, first_name: 'Anna' },
        date: 0,
        old_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: 'left' },
        new_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: 'member' },
      },
    } as TelegramUpdate);
    const toGroup = base.sent.filter((s) => s.params['chat_id'] === -1002);
    assert.equal(toGroup.length, 1);
    assert.match(String(toGroup[0]?.params['text']), /Idaria/);
  });
});
