/**
 * What the plugin hands the kernel to post for agents (spec 2042 criterion 30):
 * the conversation and targeted send providers declare only what they do, post
 * as exactly this bot, and return unreachability instead of throwing.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemorySpeakerHistoryStore } from '@omadia/channel-sdk';
import {
  PairingStore,
  TELEGRAM_CONVERSATION_SEND_CAPABILITIES,
  TELEGRAM_REACTION_EMOJI,
  TELEGRAM_SEND_CAPABILITIES,
  TelegramEmitter,
  createTelegramConversationSend,
  createTelegramTargetedSend,
  type DmPolicy,
} from '@omadia/channel-telegram';

import { BOT_ID, memoryStore, recordingApi } from './fakes.js';

const BOT_KEY = `tg:${String(BOT_ID)}`;

const GROUP = -100777;

async function rig(opts: { dmPolicy?: DmPolicy; activate?: boolean; failWith?: string } = {}) {
  const api = recordingApi();
  if (opts.failWith) {
    const fail = async (): Promise<never> => {
      throw new Error(opts.failWith);
    };
    (api.client as unknown as { sendMessage: () => Promise<never> }).sendMessage = fail;
    (api.client as unknown as { setMessageReaction: () => Promise<never> }).setMessageReaction = fail;
  }
  const files = new Map<string, string>();
  const pairingStore = new PairingStore(memoryStore(files));
  if (opts.activate !== false) {
    await pairingStore.putGroupActivation({
      chatId: GROUP, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z',
    });
  }
  const deps = {
    emitter: new TelegramEmitter({ api: api.client, speakerHistory: new InMemorySpeakerHistoryStore() }),
    api: api.client,
    pairingStore,
    dmPolicy: opts.dmPolicy ?? ('open' as DmPolicy),
    botKey: BOT_KEY,
  };
  // One bot: no key and its own key name it, nothing else does.
  const lookup = (key: string | undefined) => (key === undefined || key === BOT_KEY ? deps : undefined);
  return {
    api,
    files,
    pairingStore,
    conversation: createTelegramConversationSend(lookup),
    targeted: createTelegramTargetedSend(lookup),
  };
}

const texts = (r: Awaited<ReturnType<typeof rig>>): string[] => r.api.sent.map((s) => String(s.params['text']));

describe('declared capabilities', () => {
  it('declare the own identity, and reactions on the conversation send: no poll, no card, no mentions, no AI label', () => {
    assert.deepEqual({ ...TELEGRAM_SEND_CAPABILITIES }, { asChannelKey: true });
    assert.deepEqual({ ...TELEGRAM_CONVERSATION_SEND_CAPABILITIES }, { asChannelKey: true, reactions: true });
  });

  it('the providers declare exactly that, so the kernel posts a card or poll as text itself', async () => {
    const r = await rig();
    assert.deepEqual({ ...r.conversation.supports }, { asChannelKey: true, reactions: true });
    assert.equal(typeof r.conversation.react, 'function', 'reactions are declared because react is implemented');
    assert.deepEqual({ ...r.targeted.supports }, { asChannelKey: true });
  });
});

describe('conversation send', () => {
  it('posts the text as this bot and returns the message id and the conversation', async () => {
    const r = await rig();
    const out = await r.conversation.sendToConversation(String(GROUP), { text: 'Kurzer Stand: alles grün.' }, { asChannelKey: BOT_KEY });
    assert.deepEqual(out, { outcome: 'delivered', messageId: '1', conversationId: String(GROUP) });
    assert.deepEqual(texts(r), ['Kurzer Stand: alles grün.']);
  });

  it('accepts the bot key in any case, and no key at all', async () => {
    const r = await rig();
    for (const key of [BOT_KEY, BOT_KEY.toUpperCase(), undefined]) {
      const out = await r.conversation.sendToConversation(String(GROUP), { text: 'x' }, key ? { asChannelKey: key } : undefined);
      assert.equal(out.outcome, 'delivered');
    }
  });

  it('never posts as another identity: a foreign key is unreachable and nothing goes out', async () => {
    const r = await rig();
    const out = await r.conversation.sendToConversation(String(GROUP), { text: 'x' }, { asChannelKey: 'tg:4242' });
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

describe('a card or poll that arrives anyway is refused, nothing half posted', () => {
  it('conversation and targeted send both answer channel_error and post nothing', async () => {
    const r = await rig();
    const card = { cardId: 'c', title: 't', questions: [{ id: 'q', kind: 'single_choice' as const, label: 'x', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] };
    const poll = { pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
    for (const message of [{ text: 'x', card }, { text: 'x', poll }]) {
      const a = await r.conversation.sendToConversation(String(GROUP), message);
      assert.equal(a.outcome === 'unreachable' && a.code, 'channel_error');
      const b = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:9' }, message);
      assert.equal(b.outcome === 'unreachable' && b.code, 'channel_error');
    }
    assert.equal(r.api.sent.length, 0);
  });

  it('the text the kernel made of a card is posted as it is, and its Telegram message_id is the question a reply points at', async () => {
    const r = await rig();
    const out = await r.conversation.sendToConversation(String(GROUP), { text: 'Budget\n\n1) Klein\n2) Groß' });
    assert.deepEqual(out, { outcome: 'delivered', messageId: '1', conversationId: String(GROUP) });
    assert.equal(r.api.sent[0]?.params['reply_markup'], undefined, 'no buttons');
    assert.match(texts(r)[0] ?? '', /1\) Klein/);
  });
});

describe('targeted send (a DM to one person)', () => {
  it('posts to the private chat of `user:telegram-chat:<id>` and reports that chat as the conversation', async () => {
    const r = await rig();
    const out = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:4711' }, { text: 'Kurze Rückfrage.' }, { asChannelKey: BOT_KEY });
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
    const c = await r.targeted.sendToUser({ principalId: 'user:telegram-chat:9' }, { text: 'x' }, { asChannelKey: '@ColleagueBot' });
    assert.equal(c.outcome === 'unreachable' && c.code, 'not_permitted');
    assert.equal(r.api.sent.length, 0);
  });
});

describe('reactions (spec 2043 §5.14): a thumbs-up instead of an echo', () => {
  const ack = (r: Awaited<ReturnType<typeof rig>>, conversationId: string, messageId: string, asChannelKey = BOT_KEY) =>
    r.conversation.react!(conversationId, messageId, 'acknowledge', { asChannelKey });

  it('acknowledge is Telegram\'s 👍', () => {
    assert.deepEqual({ ...TELEGRAM_REACTION_EMOJI }, { acknowledge: '👍' });
  });

  it('sets the reaction with setMessageReaction on the message the inbound event named, and posts nothing', async () => {
    const r = await rig();
    // inbound events report conversationId = String(chat.id), messageId = String(message_id)
    const out = await ack(r, String(GROUP), '321');
    assert.deepEqual(out, { outcome: 'reacted' });
    assert.deepEqual(r.api.reactions, [{ chat_id: GROUP, message_id: 321, reaction: [{ type: 'emoji', emoji: '👍' }] }]);
    assert.equal(r.api.sent.length, 0, 'no echo message');
  });

  it('accepts the bot key in any case and the telegram:-prefixed chat id', async () => {
    const r = await rig();
    assert.equal((await ack(r, `telegram:${String(GROUP)}`, '5', BOT_KEY.toUpperCase())).outcome, 'reacted');
    assert.equal(r.api.reactions[0]?.['chat_id'], GROUP);
  });

  it('never reacts as another identity: a foreign or empty key is not_permitted and nothing is set', async () => {
    const r = await rig();
    for (const key of ['tg:4242', '@ColleagueBot', '']) {
      const out = await ack(r, String(GROUP), '5', key);
      assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted', key);
    }
    // A missing key (or no options at all) never falls back to the installation's bot.
    for (const opts of [{}, { asChannelKey: undefined }, undefined]) {
      const out = await r.conversation.react!(String(GROUP), '5', 'acknowledge', opts as never);
      assert.equal(out.outcome === 'unreachable' && out.code, 'not_permitted');
    }
    assert.equal(r.api.reactions.length, 0);
  });

  it('a non-Telegram chat or message id is no_binding; a group the bot is not activated in is not_permitted', async () => {
    const r = await rig();
    const a = await ack(r, '19:abc@thread.tacv2', '5');
    assert.equal(a.outcome === 'unreachable' && a.code, 'no_binding');
    for (const messageId of ['1700000000.123', 'abc', '0', '-3']) {
      const b = await ack(r, String(GROUP), messageId);
      assert.equal(b.outcome === 'unreachable' && b.code, 'no_binding', messageId);
    }
    const inactive = await rig({ activate: false });
    const c = await ack(inactive, String(GROUP), '5');
    assert.equal(c.outcome === 'unreachable' && c.code, 'not_permitted');
    assert.equal(r.api.reactions.length + inactive.api.reactions.length, 0);
  });

  it('a reaction the chat does not allow, a deleted message, any Bot API failure: channel_error with the platform message, never thrown', async () => {
    for (const failure of [
      'Telegram API setMessageReaction failed: Bad Request: REACTION_INVALID (code=400)',
      'Telegram API setMessageReaction failed: Bad Request: message to react not found (code=400)',
      'Telegram API setMessageReaction failed: Too Many Requests: retry after 3 (code=429)',
    ]) {
      const r = await rig({ failWith: failure });
      const out = await ack(r, String(GROUP), '5');
      assert.deepEqual(out, { outcome: 'unreachable', code: 'channel_error', message: failure });
    }
  });

  it('reacts in a person\'s chat with the bot only when the DM policy allows that chat', async () => {
    const r = await rig({ dmPolicy: 'pairing' });
    const blocked = await ack(r, '9', '5');
    assert.equal(blocked.outcome === 'unreachable' && blocked.code, 'not_permitted');
    const open = await rig();
    assert.equal((await ack(open, '9', '5')).outcome, 'reacted');
  });
});
