/**
 * Criterion 30 (spec 2042), Telegram's part: what people write in a
 * conversation an agent moderates reaches the kernel as `created` events with
 * the fields the kernel matches a typed answer by. The answer itself (a reply
 * to a question posted as numbered text becomes a typed `card_answer`) is the
 * kernel's: `test/typedCardReplies.test.ts` there. Choosing an agent:
 * `telegramAgentRouting.test.ts`.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationMessageEvent } from '@omadia/channel-sdk';
import { TelegramConversationMessages, type TelegramBotOptions } from '@omadia/channel-telegram';

import { BOT_ID, BOT_USERNAME, groupText, harness, privateText, speakerA } from './fakes.js';

const GROUP = -100900;
type Mode = 'all' | 'addressed' | 'none';

async function rig() {
  const events: ConversationMessageEvent[] = [];
  let mode: Mode = 'all';
  const conversationMessages = new TelegramConversationMessages(
    { isAllMessagesSubscribed: () => mode === 'all', conversationDelivery: () => mode, emit: (e) => void events.push(e) },
    BOT_USERNAME,
  );
  const h = harness({ conversationMessages } as Partial<TelegramBotOptions>);
  await h.pairingStore.putGroupActivation({
    chatId: GROUP, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z',
  });
  return { h, events, setMode: (m: Mode) => { mode = m; } };
}

/** A person's message in the group; `replyTo` makes it a Telegram reply, to the bot when `toBot`. */
function groupMessage(text: string, fromId: number, replyTo?: number, toBot = true) {
  const update = groupText(text, GROUP, fromId);
  if (replyTo !== undefined) {
    update.message!.reply_to_message = {
      message_id: replyTo,
      from: toBot ? { id: BOT_ID, is_bot: true, first_name: 'Bot', username: BOT_USERNAME } : { id: 7, is_bot: false, first_name: 'Anna' },
      chat: { id: GROUP, type: 'supergroup' },
      date: 0,
    };
  }
  return update;
}

describe('created events carry what the kernel matches a typed answer by', () => {
  it('a reply to the bot\'s question: replyToMessageId is the Telegram message_id, addressedToBot is set', async () => {
    const r = await rig();
    await r.h.bot.handleUpdate(groupMessage('2', 41, 123));
    const event = r.events[0]!;
    assert.equal(event.kind, 'created');
    assert.equal(event.text, '2');
    assert.equal(event.replyToMessageId, '123');
    assert.equal(event.addressedToBot, true);
    assert.deepEqual(event.author, { kind: 'telegram-chat', id: '41', displayName: 'User41' });
  });

  it('a reply to someone else is recorded with its reply id but not as addressed to the bot', async () => {
    const r = await rig();
    await r.h.bot.handleUpdate(groupMessage('Stimmt.', 42, 55, false));
    assert.equal(r.events[0]?.replyToMessageId, '55');
    assert.equal(r.events[0]?.addressedToBot, undefined);
  });

  it('a mention and a command are addressed to the bot; the bot\'s own mention is not part of the text', async () => {
    const r = await rig();
    await r.h.bot.handleUpdate(groupMessage(`@${BOT_USERNAME} 3`, 43));
    assert.equal(r.events[0]?.addressedToBot, true);
    assert.equal(r.events[0]?.text, '3');
    await r.h.bot.handleUpdate(groupText(`/agents@${BOT_USERNAME}`, GROUP, 43, true));
    assert.equal(r.events[1]?.addressedToBot, true);
  });

  it('a private chat message is addressed to the bot', async () => {
    const r = await rig();
    r.setMode('addressed');
    await r.h.bot.handleUpdate(privateText('1', 77));
    const event = r.events[0]!;
    assert.equal(event.addressedToBot, true);
    assert.equal(event.conversationType, 'direct');
    assert.equal(event.conversationId, '77');
  });

  it('the event names the message by its Telegram message_id, the bot, the conversation and the time', async () => {
    const r = await rig();
    const update = groupMessage('Hallo', 44);
    await r.h.bot.handleUpdate(update);
    const event = r.events[0]!;
    assert.equal(event.messageId, String(update.message?.message_id));
    assert.equal(event.conversationId, String(GROUP));
    assert.equal(event.conversationType, 'group');
    assert.equal(event.receivedByChannelKey, `@${BOT_USERNAME}`);
    assert.equal(event.revision, 0);
    assert.equal(event.occurredAt, '1970-01-01T00:00:00.000Z');
  });
});

describe('a contribution in a facilitation, written as plain text', () => {
  it('`all`: every human message is recorded with its platform author and starts no turn', async () => {
    const r = await rig();
    await r.h.bot.handleUpdate(groupMessage('Ich würde mit Variante B starten.', 51));
    assert.equal(r.h.turns.length, 0, 'the engine drives, not the agent');
    assert.equal(r.h.api.sent.length, 0);
    assert.equal(r.events[0]?.text, 'Ich würde mit Variante B starten.');
  });

  it('`addressed`: only what addresses the bot is recorded, and the ordinary turn still runs', async () => {
    const r = await rig();
    r.setMode('addressed');
    await r.h.bot.handleUpdate(groupMessage('Nur so unter uns', 53));
    assert.equal(r.events.length, 0);
    assert.equal(r.h.turns.length, 0);

    r.h.answers.push({ text: 'Gerne.', speaker: speakerA });
    await r.h.bot.handleUpdate(groupMessage(`@${BOT_USERNAME} fasse zusammen`, 53));
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0]?.addressedToBot, true);
    assert.equal(r.h.turns.length, 1, 'follow-up: the agent still answers');
  });

  it('`none`: nothing is recorded and the ordinary flow applies; a bot is never an author', async () => {
    const r = await rig();
    r.setMode('none');
    r.h.answers.push({ text: 'ok', speaker: speakerA });
    await r.h.bot.handleUpdate(groupMessage('hallo', 54, 9));
    assert.equal(r.events.length, 0);
    assert.equal(r.h.turns.length, 1, 'a reply to the bot reaches the agent as always');

    r.setMode('all');
    const botMessage = groupMessage('automatisch', 55);
    botMessage.message!.from = { id: 5, is_bot: true, first_name: 'AnderesBot' };
    await r.h.bot.handleUpdate(botMessage);
    assert.equal(r.events.length, 0);
  });

  it('an unactivated group is not recorded: the bot stays silent there', async () => {
    const r = await rig();
    await r.h.bot.handleUpdate(groupText('Geheim', -100999, 56));
    assert.equal(r.events.length, 0);
    assert.equal(r.h.api.sent.length, 0);
  });
});
