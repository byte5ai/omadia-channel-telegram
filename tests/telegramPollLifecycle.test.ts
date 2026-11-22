/**
 * Review fixes for native facilitators (byte5ai/omadia-channel-telegram#13):
 *  - multiple-answer polls for approval votes (`multipleAnswers`, omadia#2155);
 *  - a runoff round stops the earlier poll of the same step (`stopPoll`);
 *  - a refused poll is followed by the options as text;
 *  - one person's poll answers keep their order;
 *  - poll records are deleted and evicted;
 *  - membership dedupe only after a successful emit;
 *  - readiness and snapshot survive a failing activation lookup, and a read
 *    unaddressed message verifies privacy off;
 *  - images are downloaded only behind the gates;
 *  - private turns state `replyToMessageId` (omadia#2157).
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationMembershipEvent, ConversationMessageEvent } from '@omadia/channel-sdk';
import { InMemorySpeakerHistoryStore } from '@omadia/channel-sdk';
import {
  PairingStore,
  TelegramConversationMessages,
  TelegramEmitter,
  TelegramMembershipEvents,
  TelegramPollStore,
  createTelegramConversationSend,
  createTelegramMeetingSource,
  createTelegramReadinessProvider,
  type PostedPoll,
  type TelegramBotOptions,
  type TelegramReadinessBot,
  type TelegramUpdate,
} from '@omadia/channel-telegram';

import { BOT_ID, BOT_USERNAME, groupText, harness, memoryStore, privateText, recordingApi } from './fakes.js';

const GROUP = -100900;
const BOT_KEY = `tg:${String(BOT_ID)}`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `MAX_OPEN_POLLS_PER_CHAT` in src/telegramPolls.ts. */
const MAX_OPEN_POLLS_PER_CHAT = 20;
const activation = (chatId: number) => ({
  chatId, chatTitle: 'Team', chatType: 'supergroup' as const, activatedBy: 'h', activatedVia: 'auto' as const, activatedAt: '2026-11-21T00:00:00Z',
});
const person = (id: number, name = `User${String(id)}`) => ({ id, is_bot: false, first_name: name });
let nextUpdate = 50_000;

const OPTIONS = [{ id: 'A', label: 'Berlin' }, { id: 'B', label: 'Hamburg' }, { id: 'C', label: 'Köln' }];

async function rig(opts: { sendPollFails?: boolean; stopPollFails?: boolean } = {}) {
  const api = recordingApi();
  const pollCalls: Array<Record<string, unknown>> = [];
  const stopCalls: Array<Record<string, unknown>> = [];
  let polled = 0;
  const client = api.client as unknown as Record<string, (p: Record<string, unknown>) => Promise<unknown>>;
  client['sendPoll'] = async (p) => {
    if (opts.sendPollFails) throw new Error('Telegram API sendPoll failed: Bad Request (code=400)');
    polled += 1;
    pollCalls.push(p);
    return { message_id: 499 + polled, chat: { id: GROUP, type: 'supergroup' }, date: 0, poll: { id: `tg-poll-${String(polled)}` } };
  };
  client['stopPoll'] = async (p) => {
    stopCalls.push(p);
    if (opts.stopPollFails) throw new Error('Telegram API stopPoll failed: Bad Request: poll has already been closed (code=400)');
    return {};
  };
  const files = new Map<string, string>();
  const store = memoryStore(files);
  const pairingStore = new PairingStore(store);
  await pairingStore.putGroupActivation(activation(GROUP));
  const polls = new TelegramPollStore(store, BOT_ID);
  const deps = {
    emitter: new TelegramEmitter({ api: api.client, speakerHistory: new InMemorySpeakerHistoryStore() }),
    api: api.client,
    polls,
    pairingStore,
    dmPolicy: 'open' as const,
    botKey: BOT_KEY,
  };
  const send = createTelegramConversationSend((key) => (key === undefined || key === BOT_KEY ? deps : undefined));
  const events: ConversationMessageEvent[] = [];
  const conversationMessages = new TelegramConversationMessages(
    { isAllMessagesSubscribed: () => true, conversationDelivery: () => 'all', emit: (e) => void events.push(e) },
    BOT_ID,
  );
  const h = harness({ conversationMessages, polls: new TelegramPollStore(store, BOT_ID) } as Partial<TelegramBotOptions>, files);
  const post = (pollId: string, extra: Record<string, unknown> = {}) =>
    send.sendToConversation(String(GROUP), { text: 'Vote', poll: { pollId, question: 'Which venue?', options: OPTIONS, ...extra } }, { asChannelKey: BOT_KEY });
  return { api, pollCalls, stopCalls, files, polls, post, h, events };
}

function pollAnswer(optionIds: number[], pollId = 'tg-poll-1', user = person(7, 'Anna')): TelegramUpdate {
  return { update_id: nextUpdate++, poll_answer: { poll_id: pollId, user, option_ids: optionIds } };
}

describe('multiple-answer polls (omadia#2155)', () => {
  it('multipleAnswers posts a multiple-answer poll and answers carry optionIds', async () => {
    const r = await rig();
    await r.post('step-1:1', { multipleAnswers: true });
    assert.equal(r.pollCalls[0]?.['allows_multiple_answers'], true);
    await r.h.bot.handleUpdate(pollAnswer([0, 2]));
    await r.h.bot.handleUpdate(pollAnswer([1], 'tg-poll-1', person(8)));
    assert.deepEqual(r.events.map((e) => e.cardAnswer?.value), [{ optionIds: ['A', 'C'] }, { optionIds: ['B'] }]);
  });

  it('without the flag a poll stays single choice with optionId', async () => {
    const r = await rig();
    await r.post('step-1:1');
    assert.equal(r.pollCalls[0]?.['allows_multiple_answers'], false);
    await r.h.bot.handleUpdate(pollAnswer([2]));
    assert.deepEqual(r.events[0]?.cardAnswer?.value, { optionId: 'C' });
  });
});

describe('a newer poll of the same step stops the older one', () => {
  it('a runoff round stops the first round and drops its record; votes there are not reported', async () => {
    const r = await rig();
    await r.post('step-1:1');
    await r.post('step-1:2');
    assert.deepEqual(r.stopCalls, [{ chat_id: GROUP, message_id: 500 }]);
    assert.deepEqual((await r.polls.openInChat(GROUP)).map((p) => p.pollId), ['step-1:2']);
    await r.h.bot.handleUpdate(pollAnswer([0], 'tg-poll-1'));
    assert.equal(r.events.length, 0, 'the stopped poll maps to nothing');
    await r.h.bot.handleUpdate(pollAnswer([0], 'tg-poll-2'));
    assert.equal(r.events[0]?.cardAnswer?.cardId, 'step-1:2');
  });

  it('a poll of another step, or the same poll id again, stops nothing', async () => {
    const r = await rig();
    await r.post('step-1:1');
    await r.post('step-2:1');
    await r.post('step-2:1');
    assert.equal(r.stopCalls.length, 0);
  });

  it('a failing stopPoll never fails the send', async () => {
    const r = await rig({ stopPollFails: true });
    await r.post('step-1:1');
    const out = await r.post('step-1:2');
    assert.equal(out.outcome, 'delivered');
    assert.equal(out.outcome === 'delivered' && out.cardMessageId, '501');
    assert.equal(r.stopCalls.length, 1);
    assert.deepEqual(
      (await r.polls.openInChat(GROUP)).map((p) => p.pollId),
      ['step-1:1', 'step-1:2'],
      'a poll that could not be stopped keeps its record, so the next round tries again',
    );
  });
});

describe('a poll Telegram refuses', () => {
  it('is followed by the options as text, and reported without cardMessageId', async () => {
    const r = await rig({ sendPollFails: true });
    const out = await r.post('step-1:1');
    assert.deepEqual(out, { outcome: 'delivered', messageId: '1', conversationId: String(GROUP) });
    assert.equal(r.api.sent.length, 2, 'the text, then the options');
    const fallback = String(r.api.sent[1]?.params['text'] ?? '');
    assert.match(fallback, /A — Berlin/);
    assert.match(fallback, /C — Köln/);
  });
});

describe('one person\'s poll answers keep their order', () => {
  it('a slow first lookup is not overtaken by the second answer', async () => {
    const events: ConversationMessageEvent[] = [];
    const conversationMessages = new TelegramConversationMessages(
      { isAllMessagesSubscribed: () => true, conversationDelivery: () => 'all', emit: (e) => void events.push(e) },
      BOT_ID,
    );
    const poll: PostedPoll = {
      telegramPollId: 'tg-poll-1', pollId: 'step-1:1', chatId: GROUP, messageId: 500, optionIds: ['A', 'B'], postedAt: new Date().toISOString(),
    };
    let calls = 0;
    const polls = {
      find: async () => {
        calls += 1;
        // the first lookup is slow (a store read), the second is cached
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        return poll;
      },
    };
    const h = harness({ conversationMessages, polls } as Partial<TelegramBotOptions>);
    await Promise.all([h.bot.handleUpdate(pollAnswer([0])), h.bot.handleUpdate(pollAnswer([1]))]);
    assert.deepEqual(events.map((e) => e.cardAnswer?.value), [{ optionId: 'A' }, { optionId: 'B' }]);
  });
});

describe('poll records are bounded', () => {
  it('forget deletes the record; records past the age limit go when the chat posts again', async () => {
    const files = new Map<string, string>();
    let now = Date.parse('2026-11-01T00:00:00Z');
    const store = new TelegramPollStore(memoryStore(files), BOT_ID, () => now);
    const posted = (id: string, at: number): PostedPoll => ({
      telegramPollId: id, pollId: `s:${id}`, chatId: GROUP, messageId: 1, optionIds: ['A', 'B'], postedAt: new Date(at).toISOString(),
    });
    await store.remember(posted('old', now));
    await store.remember(posted('gone', now));
    await store.forget({ telegramPollId: 'gone', chatId: GROUP });
    assert.equal([...files.keys()].some((k) => k.endsWith('/gone.json')), false);
    now += 31 * DAY_MS;
    await store.remember(posted('new', now));
    assert.deepEqual((await store.openInChat(GROUP)).map((p) => p.telegramPollId), ['new']);
    assert.equal([...files.keys()].some((k) => k.endsWith('/old.json')), false, 'the expired record is deleted');
    assert.equal(await new TelegramPollStore(memoryStore(files), BOT_ID).find('old'), undefined);
  });

  it('a poll dropped for age or the per-chat cap is stopped on Telegram', async () => {
    const files = new Map<string, string>();
    let now = Date.parse('2026-11-01T00:00:00Z');
    const stopped: string[] = [];
    let failOnce = true;
    const store = new TelegramPollStore(memoryStore(files), BOT_ID, () => now, async (poll) => {
      stopped.push(poll.pollId);
      if (failOnce) {
        failOnce = false;
        throw new Error('poll has already been closed');
      }
    });
    const posted = (id: string, at: number): PostedPoll => ({
      telegramPollId: id, pollId: `s-${id}:1`, chatId: GROUP, messageId: 1, optionIds: ['A', 'B'], postedAt: new Date(at).toISOString(),
    });
    await store.remember(posted('aged', now));
    now += 31 * DAY_MS;
    await store.remember(posted('fresh', now));
    assert.deepEqual(stopped, ['s-aged:1'], 'the aged poll is stopped (a failure is only logged)');
    for (let i = 0; i < MAX_OPEN_POLLS_PER_CHAT; i += 1) await store.remember(posted(`n${String(i)}`, now + i));
    assert.deepEqual(stopped, ['s-aged:1', 's-fresh:1'], 'the oldest beyond the cap is stopped');
    assert.equal((await store.openInChat(GROUP)).length, MAX_OPEN_POLLS_PER_CHAT);
  });
});

describe('membership dedupe after a failed emit', () => {
  it('a change whose emit threw goes out with the next copy', async () => {
    const events: ConversationMembershipEvent[] = [];
    let isFailing = true;
    const membership = new TelegramMembershipEvents((e) => {
      if (isFailing) throw new Error('kernel down');
      events.push(e);
    }, () => 0);
    const chat = { id: GROUP, type: 'supergroup' as const };
    membership.joined(chat, [person(7)], 0);
    isFailing = false;
    membership.joined(chat, [person(7)], 0);
    membership.joined(chat, [person(7)], 0);
    assert.equal(events.length, 1, 'retried once, then deduplicated');
  });
});

describe('readiness with a failing activation lookup and proven privacy off', () => {
  function readinessBot(opts: { activationThrows?: boolean; readUnaddressed?: boolean }): TelegramReadinessBot {
    return {
      botId: BOT_ID,
      username: BOT_USERNAME,
      pairingStore: {
        getGroupActivation: async () => {
          if (opts.activationThrows) throw new Error('memory store unavailable');
          return activation(GROUP);
        },
      } as TelegramReadinessBot['pairingStore'],
      api: {
        getMe: async () => ({ ...person(BOT_ID), is_bot: true, can_read_all_group_messages: true }),
        getChatMember: async () => ({ user: { ...person(BOT_ID), is_bot: true }, status: 'member' }),
      } as TelegramReadinessBot['api'],
      hasReadUnaddressedMessage: () => opts.readUnaddressed === true,
    };
  }

  it('a throwing activation lookup is graph_error, and no snapshot', async () => {
    const bot = readinessBot({ activationThrows: true });
    const report = await createTelegramReadinessProvider(() => bot).check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(report.ready, false);
    assert.equal(report.missing[0]?.code, 'graph_error');
    assert.equal(await createTelegramMeetingSource(() => bot).snapshot(String(GROUP), { asChannelKey: BOT_KEY }), undefined);
  });

  it('privacy off is verified once the bot read a message that did not address it', async () => {
    const unproven = await createTelegramReadinessProvider(() => readinessBot({})).check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(unproven.verified, false);
    const proven = await createTelegramReadinessProvider(() => readinessBot({ readUnaddressed: true })).check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(proven.ready, true);
    assert.equal(proven.verified, undefined);
  });

  it('the bot notes an unaddressed message, not a command or a mention', async () => {
    const h = harness();
    await h.pairingStore.putGroupActivation(activation(GROUP));
    await h.bot.handleUpdate(groupText('/vote A', GROUP, 7));
    await h.bot.handleUpdate(groupText(`@${BOT_USERNAME} hi`, GROUP, 7));
    assert.equal(h.bot.hasReadUnaddressedMessage(GROUP), false);
    await h.bot.handleUpdate(groupText('A, please', GROUP, 7));
    assert.equal(h.bot.hasReadUnaddressedMessage(GROUP), true);
  });

  it('a membership change of the bot in the group resets the proof', async () => {
    const h = harness();
    await h.pairingStore.putGroupActivation(activation(GROUP));
    await h.bot.handleUpdate(groupText('A, please', GROUP, 7));
    assert.equal(h.bot.hasReadUnaddressedMessage(GROUP), true);
    const me = { id: BOT_ID, is_bot: true, first_name: 'Me' };
    await h.bot.handleUpdate({
      update_id: nextUpdate++,
      my_chat_member: {
        chat: { id: GROUP, type: 'supergroup', title: 'Team' },
        from: person(7, 'Anna'),
        date: 1_700_000_000,
        old_chat_member: { user: me, status: 'member' },
        new_chat_member: { user: me, status: 'left' },
      },
    });
    assert.equal(h.bot.hasReadUnaddressedMessage(GROUP), false);
  });
});

describe('images are downloaded only behind the gates', () => {
  function photo(chatId: number, type: 'supergroup' | 'private', caption?: string): TelegramUpdate {
    return {
      update_id: nextUpdate++,
      message: {
        message_id: nextUpdate,
        from: person(7),
        chat: { id: chatId, type },
        date: 0,
        photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 10, height: 10 }],
        ...(caption ? { caption } : {}),
      },
    } as TelegramUpdate;
  }

  it('an unaddressed group photo is not fetched; an addressed one is', async () => {
    const h = harness();
    const downloads: string[] = [];
    (h.api.client as unknown as { downloadFile: (id: string) => Promise<unknown> }).downloadFile = async (id) => {
      downloads.push(id);
      return { bytes: Buffer.from('jpg'), sizeBytes: 3, mediaType: 'image/jpeg' };
    };
    await h.pairingStore.putGroupActivation(activation(GROUP));
    await h.bot.handleUpdate(photo(GROUP, 'supergroup', 'look at this'));
    assert.deepEqual(downloads, [], 'not for the bot: not downloaded');
    await h.bot.handleUpdate(photo(-100999, 'supergroup', `@${BOT_USERNAME} look`));
    assert.deepEqual(downloads, [], 'not activated: not downloaded');
    await h.bot.handleUpdate({
      ...photo(GROUP, 'supergroup', `@${BOT_USERNAME} look`),
      message: { ...photo(GROUP, 'supergroup', `@${BOT_USERNAME} look`).message!, caption_entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }] },
    } as TelegramUpdate);
    assert.deepEqual(downloads, ['f1']);
    assert.equal(h.turns.length, 1);
  });
});

describe('replyToMessageId on private turns (omadia#2157)', () => {
  it('a reply in a private chat states the replied message id; a group turn does not', async () => {
    const h = harness();
    const reply = privateText('done', 7);
    await h.bot.handleUpdate({
      ...reply,
      message: { ...reply.message!, reply_to_message: { message_id: 42, chat: { id: 7, type: 'private' }, date: 0 } },
    } as TelegramUpdate);
    assert.equal((h.turns[0]?.origin as { replyToMessageId?: string } | undefined)?.replyToMessageId, '42');

    await h.pairingStore.putGroupActivation(activation(GROUP));
    const mention = groupText(`@${BOT_USERNAME} done`, GROUP, 7);
    await h.bot.handleUpdate({
      ...mention,
      message: { ...mention.message!, reply_to_message: { message_id: 43, chat: { id: GROUP, type: 'supergroup' }, date: 0 } },
    } as TelegramUpdate);
    assert.equal(h.turns.length, 2);
    assert.equal((h.turns[1]?.origin as { replyToMessageId?: string } | undefined)?.replyToMessageId, undefined);
  });
});
