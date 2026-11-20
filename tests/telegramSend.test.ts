/**
 * What the plugin hands the kernel to post for agents (spec 2042 criterion 30):
 * the conversation and targeted send providers declare only what they do, post
 * as exactly this bot, and return unreachability instead of throwing.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemorySpeakerHistoryStore, renderCardAsText } from '@omadia/channel-sdk';
import type { QuestionCard } from '@omadia/plugin-api';
import {
  ANSWER_HINT,
  OpenCardStore,
  PairingStore,
  TelegramEmitter,
  createTelegramConversationSend,
  createTelegramTargetedSend,
  telegramSendCapabilities,
  type DmPolicy,
} from '@omadia/channel-telegram';

import { BOT_USERNAME, memoryStore, recordingApi } from './fakes.js';

const GROUP = -100777;

async function rig(opts: { dmPolicy?: DmPolicy; canCollectAnswers?: boolean; activate?: boolean; failWith?: string } = {}) {
  const api = recordingApi();
  if (opts.failWith) {
    (api.client as unknown as { sendMessage: () => Promise<never> }).sendMessage = async () => {
      throw new Error(opts.failWith);
    };
  }
  const files = new Map<string, string>();
  const pairingStore = new PairingStore(memoryStore(files));
  if (opts.activate !== false) {
    await pairingStore.putGroupActivation({
      chatId: GROUP, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z',
    });
  }
  const openCards = new OpenCardStore(memoryStore(files));
  const deps = {
    emitter: new TelegramEmitter({ api: api.client, speakerHistory: new InMemorySpeakerHistoryStore() }),
    openCards,
    pairingStore,
    dmPolicy: opts.dmPolicy ?? ('open' as DmPolicy),
    botUsername: BOT_USERNAME,
    canCollectAnswers: opts.canCollectAnswers ?? true,
  };
  return {
    api,
    files,
    pairingStore,
    openCards,
    conversation: createTelegramConversationSend(deps),
    targeted: createTelegramTargetedSend(deps),
  };
}

const texts = (r: Awaited<ReturnType<typeof rig>>): string[] => r.api.sent.map((s) => String(s.params['text']));

const choiceCard: QuestionCard = {
  cardId: 'budget-vote',
  proposalId: 'p1',
  proposalVersion: 2,
  title: 'Budget 2027',
  questions: [{ id: 'q1', kind: 'single_choice', label: 'Welche Variante?', options: [{ id: 'a', label: 'Klein' }, { id: 'b', label: 'Groß' }] }],
};

describe('declared capabilities', () => {
  it('declare the own identity, polls and one-question text cards; no mentions, no card update, no AI label', () => {
    const caps = telegramSendCapabilities(true);
    assert.equal(caps.asChannelKey, true);
    assert.equal(caps.poll, true);
    assert.deepEqual(caps.card?.kinds, ['single_choice', 'multiple_choice', 'ranking', 'consent', 'number', 'date']);
    assert.equal(caps.card?.maxQuestions, 1);
    assert.equal(caps.card?.update, false);
    assert.equal(caps.mentions, undefined);
    assert.equal(caps.aiLabel, undefined);
  });

  it('without the inbound side no poll and no card is declared, and none is posted', async () => {
    const caps = telegramSendCapabilities(false);
    assert.equal(caps.poll, undefined);
    assert.equal(caps.card, undefined);
    const r = await rig({ canCollectAnswers: false });
    const out = await r.conversation.sendToConversation(String(GROUP), { text: 'x', card: choiceCard }, { asChannelKey: `@${BOT_USERNAME}` });
    assert.equal(out.outcome, 'unreachable');
    assert.equal(r.api.sent.length, 0);
  });
});

describe('conversation send', () => {
  it('posts the text as this bot and returns the message id and the conversation', async () => {
    const r = await rig();
    const out = await r.conversation.sendToConversation(String(GROUP), { text: 'Kurzer Stand: alles grün.' }, { asChannelKey: `@${BOT_USERNAME}` });
    assert.deepEqual(out, { outcome: 'delivered', messageId: '1', conversationId: String(GROUP) });
    assert.deepEqual(texts(r), ['Kurzer Stand: alles grün.']);
  });

  it('accepts the bare or lowercase bot key, and no key at all', async () => {
    const r = await rig();
    for (const key of [BOT_USERNAME, `@${BOT_USERNAME.toLowerCase()}`, undefined]) {
      const out = await r.conversation.sendToConversation(String(GROUP), { text: 'x' }, key ? { asChannelKey: key } : undefined);
      assert.equal(out.outcome, 'delivered');
    }
  });

  it('never posts as another identity: a foreign key is unreachable and nothing goes out', async () => {
    const r = await rig();
    const out = await r.conversation.sendToConversation(String(GROUP), { text: 'x' }, { asChannelKey: '@MirasOwnBot' });
    assert.equal(out.outcome, 'unreachable');
    assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
    assert.equal(r.api.sent.length, 0);
  });

  it('a group the bot is not activated in, and a non-Telegram id, are unreachable', async () => {
    const r = await rig({ activate: false });
    const a = await r.conversation.sendToConversation(String(GROUP), { text: 'x' });
    assert.equal(a.outcome === 'unreachable' && a.code, 'not_permitted');
    const b = await r.conversation.sendToConversation('19:abc@thread.tacv2', { text: 'x' });
    assert.equal(b.outcome === 'unreachable' && b.code, 'no_binding');
    assert.equal(r.api.sent.length, 0);
  });

  it('a Bot API failure is returned, never thrown', async () => {
    const forbidden = await rig({ failWith: 'Telegram API sendMessage failed: Forbidden: bot was kicked (code=403)' });
    const a = await forbidden.conversation.sendToConversation(String(GROUP), { text: 'x' });
    assert.equal(a.outcome === 'unreachable' && a.code, 'not_permitted');
    const gone = await rig({ failWith: 'Telegram API sendMessage failed: Bad Request: chat not found (code=400)' });
    const b = await gone.conversation.sendToConversation(String(GROUP), { text: 'x' });
    assert.equal(b.outcome === 'unreachable' && b.code, 'no_binding');
    const other = await rig({ failWith: 'boom' });
    const c = await other.conversation.sendToConversation(String(GROUP), { text: 'x' });
    assert.equal(c.outcome === 'unreachable' && c.code, 'channel_error');
  });
});

describe('questions go out as plain numbered text (criterion 30)', () => {
  it('a card is the SDK text plus how to answer, and is remembered under its message id', async () => {
    const r = await rig();
    const out = await r.conversation.sendToConversation(String(GROUP), { text: 'Bitte abstimmen.', card: choiceCard });
    assert.equal(out.outcome, 'delivered');
    assert.equal(out.outcome === 'delivered' && out.cardMessageId, '1');
    assert.equal(r.api.sent[0]?.params['reply_markup'], undefined, 'no buttons');
    const body = texts(r)[0] ?? '';
    assert.match(body, /Bitte abstimmen\./);
    assert.match(body, /Budget 2027/);
    assert.match(body, /1\) Klein/);
    assert.match(body, /2\) Groß/);
    assert.ok(body.includes(ANSWER_HINT));
    assert.ok(renderCardAsText(choiceCard).split('\n').every((line) => body.includes(line)));

    const hit = await r.openCards.match({ chatId: GROUP, isPrivate: false, replyToMessageId: 1 });
    assert.equal(hit?.card.cardId, 'budget-vote');
    assert.equal(hit?.card.proposalVersion, 2);
  });

  it('a poll is a single-choice question, its id comes back as the card id', async () => {
    const r = await rig();
    await r.conversation.sendToConversation(String(GROUP), {
      text: 'Wann?',
      poll: { pollId: 'termin', question: 'Welcher Tag?', options: [{ id: 'mo', label: 'Montag' }, { id: 'di', label: 'Dienstag' }], hint: 'Bis Freitag' },
    });
    assert.match(texts(r)[0] ?? '', /1\) Montag/);
    const hit = await r.openCards.match({ chatId: GROUP, isPrivate: false, replyToMessageId: 1 });
    assert.equal(hit?.card.kind, 'poll');
    assert.equal(hit?.card.cardId, 'termin');
  });

  it('refuses what a typed reply cannot answer: several questions, text and assignment questions', async () => {
    const r = await rig();
    const two = { ...choiceCard, questions: [...choiceCard.questions, { id: 'q2', kind: 'number' as const, label: 'Wie viele?' }] };
    const text = { ...choiceCard, questions: [{ id: 'q1', kind: 'text' as const, label: 'Dein Wunsch?' }] };
    for (const card of [two, text]) {
      const out = await r.conversation.sendToConversation(String(GROUP), { text: 'x', card });
      assert.equal(out.outcome === 'unreachable' && out.code, 'channel_error');
    }
    assert.equal(r.api.sent.length, 0, 'nothing posted, so the sender can fall back to a chat ballot');
  });

  it('a card and a poll together, or a poll with one option, are refused', async () => {
    const r = await rig();
    const both = await r.conversation.sendToConversation(String(GROUP), {
      text: 'x', card: choiceCard, poll: { pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    });
    assert.equal(both.outcome, 'unreachable');
    const one = await r.conversation.sendToConversation(String(GROUP), { text: 'x', poll: { pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }] } });
    assert.equal(one.outcome, 'unreachable');
    assert.equal(r.api.sent.length, 0);
  });
});

describe('targeted send (a DM to one person)', () => {
  it('posts to the private chat of `user:telegram-chat:<id>` and reports that chat as the conversation', async () => {
    const r = await rig();
    const out = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:4711' }, { text: 'Kurze Rückfrage.' }, { asChannelKey: `@${BOT_USERNAME}` });
    assert.deepEqual(out, { outcome: 'delivered', messageId: '1', conversationId: '4711' });
    assert.equal(r.api.sent[0]?.params['chat_id'], 4711);
  });

  it('prefers the typed user ref; a principal that is not a Telegram user is user_not_found', async () => {
    const r = await rig();
    const ok = await r.targeted.sendToUser({ principalId: 'user:anna@firma.de', userRef: { kind: 'telegram-chat', id: '55' } }, { text: 'x' });
    assert.equal(ok.outcome, 'delivered');
    const none = await r.targeted.sendToUser({ principalId: 'user:anna@firma.de' }, { text: 'x' });
    assert.equal(none.outcome === 'unreachable' && none.code, 'user_not_found');
    const group = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:-100' }, { text: 'x' });
    assert.equal(group.outcome === 'unreachable' && group.code, 'user_not_found');
  });

  it('respects the DM policy: an unpaired person under `pairing` is not messaged', async () => {
    const r = await rig({ dmPolicy: 'pairing' });
    const out = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:9' }, { text: 'x' });
    assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
    assert.equal(r.api.sent.length, 0);
    await r.pairingStore.putDmBinding({ telegramUserId: 9, harnessIdentityId: 'h', harnessIdentityLabel: 'A', telegramDisplayName: 'A', boundAt: '2026-11-20T00:00:00Z' });
    const paired = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:9' }, { text: 'x' });
    assert.equal(paired.outcome, 'delivered');
  });

  it('first contact impossible and a blocked bot are told apart; a foreign identity is refused', async () => {
    const first = await rig({ failWith: "Telegram API sendMessage failed: Forbidden: bot can't initiate conversation with a user (code=403)" });
    const a = await first.targeted.sendToUser({ principalId: 'user:telegram-chat:9' }, { text: 'x' });
    assert.equal(a.outcome === 'unreachable' && a.code, 'app_not_installed');
    const blocked = await rig({ failWith: 'Telegram API sendMessage failed: Forbidden: bot was blocked by the user (code=403)' });
    const b = await blocked.targeted.sendToUser({ principalId: 'user:telegram-chat:9' }, { text: 'x' });
    assert.equal(b.outcome === 'unreachable' && b.code, 'blocked');
    const r = await rig();
    const c = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:9' }, { text: 'x' }, { asChannelKey: '@Other' });
    assert.equal(c.outcome === 'unreachable' && c.code, 'not_permitted');
    assert.equal(r.api.sent.length, 0);
  });
});
