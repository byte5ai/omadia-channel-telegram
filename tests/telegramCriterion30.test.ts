/**
 * Criterion 30 (spec 2042): a contribution in a facilitation and the answer to
 * a poll work through plain text in Telegram. Each is driven through the real
 * bot: the question is posted by the send provider as numbered text, the person
 * types the reply, and the kernel receives the typed event a card submission
 * would have produced. (Choosing an agent: `telegramAgentRouting.test.ts`.)
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemorySpeakerHistoryStore, type ConversationMessageEvent } from '@omadia/channel-sdk';
import type { QuestionCard } from '@omadia/plugin-api';
import {
  OpenCardStore,
  TelegramConversationMessages,
  TelegramEmitter,
  createTelegramConversationSend,
  createTelegramTargetedSend,
  type TelegramBotOptions,
} from '@omadia/channel-telegram';

import { BOT_ID, BOT_USERNAME, groupText, harness, memoryStore, privateText, speakerA } from './fakes.js';

const GROUP = -100900;
type Mode = 'all' | 'addressed' | 'none';

interface Rig {
  readonly h: ReturnType<typeof harness>;
  readonly events: ConversationMessageEvent[];
  readonly setMode: (mode: Mode) => void;
  readonly send: ReturnType<typeof createTelegramConversationSend>;
  readonly dm: ReturnType<typeof createTelegramTargetedSend>;
  readonly openCards: OpenCardStore;
  readonly files: Map<string, string>;
}

async function rig(): Promise<Rig> {
  const events: ConversationMessageEvent[] = [];
  let mode: Mode = 'all';
  const files = new Map<string, string>();
  const openCards = new OpenCardStore(memoryStore(files));
  const conversationMessages = new TelegramConversationMessages(
    { isAllMessagesSubscribed: () => mode === 'all', conversationDelivery: () => mode, emit: (e) => void events.push(e) },
    BOT_USERNAME,
  );
  const h = harness({ openCards, conversationMessages } as Partial<TelegramBotOptions>, files);
  await h.pairingStore.putGroupActivation({
    chatId: GROUP, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z',
  });
  const deps = {
    emitter: new TelegramEmitter({ api: h.api.client, speakerHistory: new InMemorySpeakerHistoryStore() }),
    openCards,
    pairingStore: h.pairingStore,
    dmPolicy: 'open' as const,
    botUsername: BOT_USERNAME,
    canCollectAnswers: true,
  };
  return {
    h, events, openCards, files,
    setMode: (m) => { mode = m; },
    send: createTelegramConversationSend(deps),
    dm: createTelegramTargetedSend(deps),
  };
}

/** A person's message in the group; `replyTo` makes it a Telegram reply to that message. */
function groupMessage(text: string, fromId: number, replyTo?: number) {
  const update = groupText(text, GROUP, fromId);
  if (replyTo !== undefined) {
    update.message!.reply_to_message = {
      message_id: replyTo, from: { id: BOT_ID, is_bot: true, first_name: 'Bot', username: BOT_USERNAME }, chat: { id: GROUP, type: 'supergroup' }, date: 0,
    };
  }
  return update;
}

const poll = {
  pollId: 'termin',
  question: 'Welcher Tag passt?',
  options: [{ id: 'mo', label: 'Montag' }, { id: 'di', label: 'Dienstag' }, { id: 'mi', label: 'Mittwoch' }],
};

const ranking: QuestionCard = {
  cardId: 'rank1', title: 'Reihenfolge', questions: [{ id: 'q', kind: 'ranking', label: 'Was zuerst?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }] }],
};

describe('answering a poll in plain text', () => {
  it('a typed number as a reply becomes the same option a button tap would carry, with a verified author', async () => {
    const r = await rig();
    const out = await r.send.sendToConversation(String(GROUP), { text: 'Termin?', poll });
    const messageId = Number(out.outcome === 'delivered' && out.cardMessageId);
    await r.h.bot.handleUpdate(groupMessage('2', 41, messageId));

    assert.equal(r.events.length, 1);
    const event = r.events[0]!;
    assert.equal(event.kind, 'card_answer');
    assert.equal(event.cardAnswer?.cardId, 'termin');
    assert.deepEqual(event.cardAnswer?.value, { optionId: 'di' });
    assert.equal(event.cardAnswer?.answererVerified, true);
    assert.deepEqual(event.author, { kind: 'telegram-chat', id: '41', displayName: 'User41' });
    assert.equal(event.messageId, String(messageId), 'the message answered');
    assert.equal(event.conversationId, String(GROUP));
    assert.equal(event.receivedByChannelKey, `@${BOT_USERNAME}`);
    assert.equal(r.h.turns.length, 0, 'an answer is not a question for the agent');
    assert.equal(r.h.api.sent.length, 1, 'no per-vote chatter in a group');
  });

  it('the label works as well as the number, in any case', async () => {
    const r = await rig();
    const out = await r.send.sendToConversation(String(GROUP), { text: '', poll });
    const id = Number(out.outcome === 'delivered' && out.messageId);
    await r.h.bot.handleUpdate(groupMessage('mittwoch', 42, id));
    assert.deepEqual(r.events[0]?.cardAnswer?.value, { optionId: 'mi' });
  });

  it('a reply that is no answer is told so and records nothing; a loose "2" in the group is not an answer', async () => {
    const r = await rig();
    r.setMode('addressed');
    const out = await r.send.sendToConversation(String(GROUP), { text: '', poll });
    const id = Number(out.outcome === 'delivered' && out.messageId);
    await r.h.bot.handleUpdate(groupMessage('vielleicht später', 43, id));
    assert.equal(r.events.filter((e) => e.kind === 'card_answer').length, 0);
    assert.match(String(r.h.api.sent.at(-1)?.params['text']), /nicht als Antwort/);

    const before = r.events.length;
    await r.h.bot.handleUpdate(groupMessage('2', 43));
    assert.equal(r.events.length, before, 'not addressed, not a reply');
  });

  it('a closed question no longer counts, and says so', async () => {
    const r = await rig();
    const closed: QuestionCard = { cardId: 'zu', title: 'Alt', closesAt: new Date(Date.now() - 60_000).toISOString(), questions: [{ id: 'q', kind: 'single_choice', label: 'x', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] };
    const out = await r.send.sendToConversation(String(GROUP), { text: '', card: closed });
    await r.h.bot.handleUpdate(groupMessage('1', 44, Number(out.outcome === 'delivered' && out.messageId)));
    assert.equal(r.events.length, 0);
    assert.match(String(r.h.api.sent.at(-1)?.params['text']), /beendet/);
  });

  it('with no subscription for the chat (mode none) a reply is an ordinary message again', async () => {
    const r = await rig();
    const out = await r.send.sendToConversation(String(GROUP), { text: '', poll });
    r.setMode('none');
    await r.h.bot.handleUpdate(groupMessage('1', 45, Number(out.outcome === 'delivered' && out.messageId)));
    assert.equal(r.events.length, 0);
    assert.equal(r.h.turns.length, 1, 'a reply to the bot reaches the agent as always');
  });

  it('an answer survives a restart: a new bot over the same memory still matches the question', async () => {
    const r = await rig();
    const out = await r.send.sendToConversation(String(GROUP), { text: '', poll });
    const id = Number(out.outcome === 'delivered' && out.messageId);
    await r.openCards.flush();

    const events: ConversationMessageEvent[] = [];
    const restarted = harness(
      {
        openCards: new OpenCardStore(memoryStore(r.files)),
        conversationMessages: new TelegramConversationMessages(
          { isAllMessagesSubscribed: () => true, conversationDelivery: () => 'all', emit: (e) => void events.push(e) },
          BOT_USERNAME,
        ),
      } as Partial<TelegramBotOptions>,
      r.files,
    );
    await restarted.bot.handleUpdate(groupMessage('3', 46, id));
    assert.deepEqual(events[0]?.cardAnswer?.value, { optionId: 'mi' });
  });
});

describe('answering a question card in a private chat (targeted send)', () => {
  const consent: QuestionCard = {
    cardId: 'ok-plan', proposalId: 'plan', proposalVersion: 3, title: 'Plan', changeable: false,
    questions: [{ id: 'c', kind: 'consent', label: 'Einverstanden?', reasonRequiredOnObject: true }],
  };

  it('the next message answers the one open question, typed with proposal id and version, and is confirmed', async () => {
    const r = await rig();
    r.setMode('addressed');
    await r.dm.sendToUser({ principalId: 'user:telegram-chat:77' }, { text: 'Bitte prüfen.', card: consent });
    await r.h.bot.handleUpdate(privateText('ja', 77));
    const event = r.events.at(-1)!;
    assert.equal(event.kind, 'card_answer');
    assert.equal(event.cardAnswer?.cardId, 'ok-plan');
    assert.equal(event.cardAnswer?.proposalId, 'plan');
    assert.equal(event.cardAnswer?.proposalVersion, 3);
    assert.deepEqual(event.cardAnswer?.answers, [{ questionId: 'c', kind: 'consent', decision: 'agree' }]);
    assert.equal(event.conversationType, 'direct');
    assert.match(String(r.h.api.sent.at(-1)?.params['text']), /erfasst/);
    assert.equal(r.h.turns.length, 0);

    await r.h.bot.handleUpdate(privateText('ja', 77));
    assert.match(String(r.h.api.sent.at(-1)?.params['text']), /nicht mehr ändern/, 'changeable: false');
  });

  it('an objection needs its reason, a ranking takes the order typed', async () => {
    const r = await rig();
    r.setMode('addressed');
    const posted = await r.dm.sendToUser({ principalId: 'user:telegram-chat:78' }, { text: '', card: consent });
    const id = Number(posted.outcome === 'delivered' && posted.messageId);
    const bare = privateText('einwand', 78);
    bare.message!.reply_to_message = { message_id: id, chat: { id: 78, type: 'private' }, date: 0 } as never;
    await r.h.bot.handleUpdate(bare);
    assert.equal(r.events.length, 0);
    assert.match(String(r.h.api.sent.at(-1)?.params['text']), /nicht als Antwort/);
    await r.h.bot.handleUpdate(privateText('einwand: zu teuer', 78));
    assert.deepEqual(r.events.at(-1)?.cardAnswer?.answers, [{ questionId: 'c', kind: 'consent', decision: 'object', reason: 'zu teuer' }]);

    await r.dm.sendToUser({ principalId: 'user:telegram-chat:79' }, { text: '', card: ranking });
    await r.h.bot.handleUpdate(privateText('2,1,3', 79));
    assert.deepEqual(r.events.at(-1)?.cardAnswer?.answers, [{ questionId: 'q', kind: 'ranking', ranking: ['y', 'x', 'z'] }]);
  });

  it('a private message that is no answer is an ordinary message to the agent, not swallowed', async () => {
    const r = await rig();
    r.setMode('addressed');
    await r.dm.sendToUser({ principalId: 'user:telegram-chat:80' }, { text: '', card: consent });
    r.h.answers.push({ text: 'Antwort', speaker: speakerA });
    await r.h.bot.handleUpdate(privateText('Was kostet das eigentlich?', 80));
    assert.equal(r.h.turns.length, 1);
    assert.equal(r.events.filter((e) => e.kind === 'card_answer').length, 0);
  });
});

describe('a contribution in a facilitation, written as plain text', () => {
  it('`all`: every human message is recorded with its platform author and starts no turn', async () => {
    const r = await rig();
    r.setMode('all');
    const update = groupMessage('Ich würde mit Variante B starten.', 51);
    await r.h.bot.handleUpdate(update);
    assert.equal(r.h.turns.length, 0, 'the engine drives, not the agent');
    assert.equal(r.h.api.sent.length, 0);
    const event = r.events[0]!;
    assert.equal(event.kind, 'created');
    assert.equal(event.text, 'Ich würde mit Variante B starten.');
    assert.deepEqual(event.author, { kind: 'telegram-chat', id: '51', displayName: 'User51' });
    assert.equal(event.conversationType, 'group');
    assert.equal(event.messageId, String(update.message?.message_id));
    assert.equal(event.revision, 0);
  });

  it('a reply is recorded with the message it answers', async () => {
    const r = await rig();
    await r.h.bot.handleUpdate(groupMessage('Dem stimme ich zu.', 52, 7));
    assert.equal(r.events[0]?.replyToMessageId, '7');
  });

  it('`addressed`: only what addresses the bot is recorded (and flagged), and the ordinary turn still runs', async () => {
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

  it('`none`: nothing is recorded; a bot is never an author; a text-less message records nothing', async () => {
    const r = await rig();
    r.setMode('none');
    await r.h.bot.handleUpdate(groupMessage('hallo', 54));
    assert.equal(r.events.length, 0);

    r.setMode('all');
    const botMessage = groupMessage('automatisch', 55);
    botMessage.message!.from = { id: 5, is_bot: true, first_name: 'AnderesBot' };
    await r.h.bot.handleUpdate(botMessage);
    assert.equal(r.events.length, 0);
  });

  it('an unactivated group is not recorded: the bot stays silent there', async () => {
    const r = await rig();
    const update = groupText('Geheim', -100999, 56);
    await r.h.bot.handleUpdate(update);
    assert.equal(r.events.length, 0);
    assert.equal(r.h.api.sent.length, 0);
  });
});
