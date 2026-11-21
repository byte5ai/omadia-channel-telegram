/**
 * Native facilitators in Telegram (byte5ai/omadia-channel-telegram#8, spec
 * 2043 §5.3, §5.5, §6.4), on a simulated Bot API:
 *  - readiness per bot and group, and the group's capability snapshot;
 *  - join / leave / bot_added events to the kernel, deduplicated;
 *  - native polls: posted non-anonymous, votes back as `card_answer`;
 *  - delivery per conversation: the mention gate is lifted only where a
 *    facilitation holds a subscription;
 *  - the fresh roster sees a join inside the cache lifetime.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationMembershipEvent, ConversationMessageEvent } from '@omadia/channel-sdk';
import { InMemorySpeakerHistoryStore } from '@omadia/channel-sdk';
import {
  GroupMemberTracker,
  PairingStore,
  TELEGRAM_ALLOWED_UPDATES,
  TelegramConversationMessages,
  TelegramConversationRosterProvider,
  TelegramEmitter,
  TelegramMembershipEvents,
  TelegramPollStore,
  TelegramRosterProvider,
  createTelegramConversationSend,
  createTelegramMeetingSource,
  createTelegramReadinessProvider,
  type TelegramBotOptions,
  type TelegramReadinessBot,
  type TelegramUpdate,
} from '@omadia/channel-telegram';

import { BOT_ID, BOT_USERNAME, groupText, harness, memoryStore, recordingApi } from './fakes.js';

const GROUP = -100800;
const OTHER_GROUP = -100801;
const BOT_KEY = `tg:${String(BOT_ID)}`;
const activation = (chatId: number) => ({
  chatId, chatTitle: 'Team', chatType: 'supergroup' as const, activatedBy: 'h', activatedVia: 'auto' as const, activatedAt: '2026-11-21T00:00:00Z',
});
const person = (id: number, name = `User${String(id)}`) => ({ id, is_bot: false, first_name: name });
let nextUpdate = 10_000;

describe('allowed_updates', () => {
  it('asks Telegram for poll answers, polling and webhook alike', () => {
    assert.ok(TELEGRAM_ALLOWED_UPDATES.includes('poll_answer'));
    assert.ok(TELEGRAM_ALLOWED_UPDATES.includes('chat_member'));
  });
});

// ── readiness ───────────────────────────────────────────────────────────────

async function readinessRig(opts: {
  status?: string;
  privacyOff?: boolean;
  activated?: boolean;
  canSend?: boolean;
  memberError?: string;
}) {
  const pairingStore = new PairingStore(memoryStore());
  if (opts.activated !== false) await pairingStore.putGroupActivation(activation(GROUP));
  const bot: TelegramReadinessBot = {
    botId: BOT_ID,
    username: BOT_USERNAME,
    pairingStore,
    api: {
      getMe: async () => ({ ...person(BOT_ID), is_bot: true, can_read_all_group_messages: opts.privacyOff === true }),
      getChatMember: async () => {
        if (opts.memberError) throw new Error(opts.memberError);
        return {
          user: { ...person(BOT_ID), is_bot: true },
          status: opts.status ?? 'member',
          ...(opts.status === 'restricted' ? { is_member: true, can_send_messages: opts.canSend === true } : {}),
        };
      },
    } as TelegramReadinessBot['api'],
  };
  const lookup = (key: string | undefined) => (key === undefined || key === BOT_KEY ? bot : undefined);
  return { readiness: createTelegramReadinessProvider(lookup), source: createTelegramMeetingSource(lookup, () => new Date('2026-11-21T10:00:00Z')) };
}

describe('readiness of a bot in a group', () => {
  it('an administrator bot reads every message: ready and verified', async () => {
    const { readiness } = await readinessRig({ status: 'administrator' });
    const report = await readiness.check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(report.ready, true);
    assert.deepEqual(report.missing, []);
    assert.equal(report.verified, undefined);
  });

  it('privacy mode on and no admin: not ready, the message says how to fix it', async () => {
    const { readiness } = await readinessRig({ status: 'member', privacyOff: false });
    const report = await readiness.check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(report.ready, false);
    assert.equal(report.installed, true);
    assert.equal(report.canReadAllMessages, false);
    assert.equal(report.missing[0]?.code, 'consent_missing');
    assert.match(report.missing[0]?.message ?? '', /setprivacy/);
  });

  it('privacy mode off without admin rights: ready, but not verified (re-adding cannot be read)', async () => {
    const { readiness } = await readinessRig({ status: 'member', privacyOff: true });
    const report = await readiness.check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(report.ready, true);
    assert.equal(report.verified, false);
  });

  it('a muted bot cannot post', async () => {
    const { readiness } = await readinessRig({ status: 'restricted', privacyOff: true, canSend: false });
    const report = await readiness.check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(report.ready, false);
    assert.deepEqual(report.missing.map((m) => m.code), ['cannot_post']);
  });

  it('names what is missing: no bot, not activated, gone, a private chat, a platform error', async () => {
    const r = await readinessRig({});
    assert.equal((await r.readiness.check(String(GROUP), { asChannelKey: 'tg:1' })).missing[0]?.code, 'no_identity');
    assert.equal((await r.readiness.check('4711', { asChannelKey: BOT_KEY })).missing[0]?.code, 'unsupported_conversation');
    const off = await readinessRig({ activated: false });
    assert.equal((await off.readiness.check(String(GROUP), { asChannelKey: BOT_KEY })).missing[0]?.code, 'app_not_installed');
    const left = await readinessRig({ status: 'left' });
    assert.equal((await left.readiness.check(String(GROUP), { asChannelKey: BOT_KEY })).missing[0]?.code, 'app_not_installed');
    const failing = await readinessRig({ memberError: 'Too Many Requests (code=429)' });
    const report = await failing.readiness.check(String(GROUP), { asChannelKey: BOT_KEY });
    assert.equal(report.ready, false);
    assert.equal(report.missing[0]?.code, 'graph_error');
  });

  it('an activated group offers text and native polls; other chats get the kernel baseline', async () => {
    const { source } = await readinessRig({});
    const snapshot = await source.snapshot(String(GROUP), { asChannelKey: BOT_KEY });
    assert.deepEqual(snapshot?.inputs, ['text', 'card_answers']);
    assert.deepEqual(snapshot?.outputs, ['text', 'polls']);
    assert.equal(snapshot?.modality, 'chat');
    assert.equal(await source.snapshot('4711', { asChannelKey: BOT_KEY }), undefined);
    const off = await readinessRig({ activated: false });
    assert.equal(await off.source.snapshot(String(GROUP), { asChannelKey: BOT_KEY }), undefined);
  });
});

// ── membership events ───────────────────────────────────────────────────────

async function membershipRig(activated = true) {
  const events: ConversationMembershipEvent[] = [];
  let clock = 0;
  const membershipEvents = new TelegramMembershipEvents((e) => void events.push(e), () => clock);
  const h = harness({ membershipEvents, memberTracker: new GroupMemberTracker(memoryStore()) } as Partial<TelegramBotOptions>);
  if (activated) await h.pairingStore.putGroupActivation(activation(GROUP));
  return { h, events, membershipEvents, tick: (ms: number) => { clock += ms; } };
}

function joinNotice(users: ReturnType<typeof person>[]): TelegramUpdate {
  return {
    update_id: nextUpdate++,
    message: { message_id: nextUpdate, from: users[0], chat: { id: GROUP, type: 'supergroup' }, date: 1_700_000_000, new_chat_members: users },
  };
}

function leaveNotice(user: ReturnType<typeof person>): TelegramUpdate {
  return {
    update_id: nextUpdate++,
    message: { message_id: nextUpdate, from: user, chat: { id: GROUP, type: 'supergroup' }, date: 1_700_000_100, left_chat_member: user },
  };
}

function memberUpdate(user: ReturnType<typeof person>, from: string, to: string): TelegramUpdate {
  return {
    update_id: nextUpdate++,
    chat_member: {
      chat: { id: GROUP, type: 'supergroup' },
      from: user,
      date: 1_700_000_000,
      old_chat_member: { user, status: from as 'member' },
      new_chat_member: { user, status: to as 'member' },
    },
  };
}

describe('membership events to the kernel', () => {
  it('a join is members_added with the person; bots and this bot are left out', async () => {
    const r = await membershipRig();
    await r.h.bot.handleUpdate(joinNotice([person(7, 'Anna'), { id: 50, is_bot: true, first_name: 'Helper' }, { id: BOT_ID, is_bot: true, first_name: 'Me' }]));
    assert.equal(r.events.length, 1);
    const event = r.events[0]!;
    assert.equal(event.kind, 'members_added');
    assert.equal(event.conversationId, String(GROUP));
    assert.equal(event.channelType, 'telegram');
    assert.deepEqual(event.members, [{ kind: 'telegram-chat', id: '7', displayName: 'Anna' }]);
    assert.equal(event.occurredAt, new Date(1_700_000_000 * 1000).toISOString());
    assert.equal(r.h.turns.length, 0, 'a notice is not a turn');
  });

  it('the same join seen twice (service message and chat_member) goes out once', async () => {
    const r = await membershipRig();
    await r.h.bot.handleUpdate(joinNotice([person(7)]));
    await r.h.bot.handleUpdate(memberUpdate(person(7), 'left', 'member'));
    assert.equal(r.events.length, 1);
  });

  it('a leave is members_removed; join, leave and re-join are three changes', async () => {
    const r = await membershipRig();
    await r.h.bot.handleUpdate(joinNotice([person(7)]));
    await r.h.bot.handleUpdate(leaveNotice(person(7)));
    await r.h.bot.handleUpdate(memberUpdate(person(7), 'left', 'member'));
    assert.deepEqual(r.events.map((e) => e.kind), ['members_added', 'members_removed', 'members_added']);
  });

  it('a repeat after the dedupe window is a new change', async () => {
    const r = await membershipRig();
    await r.h.bot.handleUpdate(joinNotice([person(7)]));
    r.tick(61_000);
    await r.h.bot.handleUpdate(joinNotice([person(7)]));
    assert.equal(r.events.length, 2);
  });

  it('a promotion is neither a join nor a leave; a kick is a leave', async () => {
    const r = await membershipRig();
    await r.h.bot.handleUpdate(memberUpdate(person(8), 'member', 'administrator'));
    assert.equal(r.events.length, 0);
    await r.h.bot.handleUpdate(memberUpdate(person(8), 'administrator', 'kicked'));
    assert.deepEqual(r.events.map((e) => e.kind), ['members_removed']);
  });

  it('nothing is reported from a group the bot is not activated in', async () => {
    const r = await membershipRig(false);
    await r.h.bot.handleUpdate(joinNotice([person(7)]));
    assert.equal(r.events.length, 0);
  });

  it('the bot added by a paired person is bot_added with who added it', async () => {
    const r = await membershipRig(false);
    await r.h.pairingStore.putDmBinding({
      telegramUserId: 7, harnessIdentityId: 'u1', harnessIdentityLabel: 'Anna', pairedAt: '2026-11-21T00:00:00Z',
    } as never);
    await r.h.bot.handleUpdate({
      update_id: nextUpdate++,
      my_chat_member: {
        chat: { id: GROUP, type: 'supergroup', title: 'Team' },
        from: person(7, 'Anna'),
        date: 1_700_000_000,
        old_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Me' }, status: 'left' },
        new_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Me' }, status: 'member' },
      },
    });
    const added = r.events.find((e) => e.kind === 'bot_added');
    assert.ok(added, 'bot_added emitted');
    assert.deepEqual(added.kind === 'bot_added' ? added.addedBy : undefined, { kind: 'telegram-chat', id: '7', displayName: 'Anna' });
    assert.equal(added.members[0]?.id, String(BOT_ID));
  });
});

// ── native polls ────────────────────────────────────────────────────────────

type Mode = 'all' | 'addressed' | 'none';

async function pollRig(opts: { sendPollFails?: boolean } = {}) {
  const api = recordingApi();
  const pollCalls: Array<Record<string, unknown>> = [];
  (api.client as unknown as { sendPoll: (p: Record<string, unknown>) => Promise<unknown> }).sendPoll = async (p) => {
    if (opts.sendPollFails) throw new Error('Telegram API sendPoll failed: Bad Request (code=400)');
    pollCalls.push(p);
    return { message_id: 500, chat: { id: GROUP, type: 'supergroup' }, date: 0, poll: { id: 'tg-poll-1' } };
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
  let mode: Mode = 'all';
  const conversationMessages = new TelegramConversationMessages(
    { isAllMessagesSubscribed: () => mode === 'all', conversationDelivery: () => mode, emit: (e) => void events.push(e) },
    BOT_ID,
  );
  // A fresh store over the same files: the vote may come after a restart.
  const h = harness({ conversationMessages, polls: new TelegramPollStore(store, BOT_ID) } as Partial<TelegramBotOptions>, files);
  return { api, pollCalls, files, send, h, events, setMode: (m: Mode) => { mode = m; } };
}

const POLL = {
  pollId: 'step-1:1',
  question: 'Which venue?',
  options: [{ id: 'A', label: 'Berlin' }, { id: 'B', label: 'Hamburg' }, { id: 'C', label: 'Köln' }],
};

/** `user: null` = an anonymous administrator voting as the chat. */
function pollAnswer(optionIds: number[], user: ReturnType<typeof person> | null = person(7, 'Anna'), pollId = 'tg-poll-1'): TelegramUpdate {
  return {
    update_id: nextUpdate++,
    poll_answer: { poll_id: pollId, ...(user ? { user } : { voter_chat: { id: GROUP, type: 'supergroup' } }), option_ids: optionIds },
  };
}

describe('native polls', () => {
  it('the text goes out first, then a non-anonymous single-choice poll; the poll is the card', async () => {
    const r = await pollRig();
    const out = await r.send.sendToConversation(String(GROUP), { text: 'Which venue?\nVote in the poll or write A, B or C.', poll: POLL }, { asChannelKey: BOT_KEY });
    assert.deepEqual(out, { outcome: 'delivered', messageId: '1', cardMessageId: '500', conversationId: String(GROUP) });
    assert.equal(r.api.sent.length, 1, 'the text');
    assert.deepEqual(r.pollCalls[0], {
      chat_id: GROUP,
      question: 'Which venue?',
      options: [{ text: 'Berlin' }, { text: 'Hamburg' }, { text: 'Köln' }],
      is_anonymous: false,
      allows_multiple_answers: false,
    });
  });

  it('a vote reaches the kernel as card_answer with the kernel ids, also after a restart', async () => {
    const r = await pollRig();
    await r.send.sendToConversation(String(GROUP), { text: 'Vote', poll: POLL }, { asChannelKey: BOT_KEY });
    await r.h.bot.handleUpdate(pollAnswer([1]));
    assert.equal(r.events.length, 1);
    const event = r.events[0]!;
    assert.equal(event.kind, 'card_answer');
    assert.equal(event.messageId, '500');
    assert.equal(event.conversationId, String(GROUP));
    assert.equal(event.receivedByChannelKey, BOT_KEY);
    assert.deepEqual(event.author, { kind: 'telegram-chat', id: '7', displayName: 'Anna' });
    assert.deepEqual(event.cardAnswer, { cardId: 'step-1:1', value: { optionId: 'B' }, answererVerified: true });
    assert.equal(r.h.turns.length, 0, 'a vote is not a turn');
  });

  it('a retracted vote, an anonymous admin, an unknown option or poll, and an unsubscribed chat report nothing', async () => {
    const r = await pollRig();
    await r.send.sendToConversation(String(GROUP), { text: 'Vote', poll: POLL }, { asChannelKey: BOT_KEY });
    await r.h.bot.handleUpdate(pollAnswer([]));
    await r.h.bot.handleUpdate(pollAnswer([0], null));
    await r.h.bot.handleUpdate(pollAnswer([7]));
    await r.h.bot.handleUpdate(pollAnswer([0], person(7), 'someone-elses-poll'));
    r.setMode('none');
    await r.h.bot.handleUpdate(pollAnswer([0]));
    assert.equal(r.events.length, 0);
  });

  it('an invalid poll is refused and nothing is posted', async () => {
    const r = await pollRig();
    const options = Array.from({ length: 11 }, (_, i) => ({ id: `o${String(i)}`, label: `Option ${String(i)}` }));
    const out = await r.send.sendToConversation(String(GROUP), { text: 'x', poll: { pollId: 'p', question: 'q', options } });
    assert.equal(out.outcome === 'unreachable' && out.code, 'channel_error');
    assert.equal(r.api.sent.length + r.pollCalls.length, 0);
  });

  it('long labels are clipped to Telegram limits (options are matched by index)', async () => {
    const r = await pollRig();
    await r.send.sendToConversation(String(GROUP), {
      text: 'x',
      poll: { pollId: 'p', question: 'q'.repeat(400), options: [{ id: 'a', label: 'a'.repeat(150) }, { id: 'b', label: 'B' }] },
    });
    const call = r.pollCalls[0] as { question: string; options: Array<{ text: string }> };
    assert.equal(call.question.length, 300);
    assert.equal(call.options[0]?.text.length, 100);
  });

  it('a poll Telegram refuses leaves the text, which still takes written ballots', async () => {
    const r = await pollRig({ sendPollFails: true });
    const out = await r.send.sendToConversation(String(GROUP), { text: 'Vote: write A, B or C', poll: POLL });
    assert.deepEqual(out, { outcome: 'delivered', messageId: '1', conversationId: String(GROUP) });
  });
});

// ── delivery per conversation ───────────────────────────────────────────────

describe('delivery per conversation (acceptance: a vote without a mention)', () => {
  it('is recorded in the facilitated group; in another group the mention rules stay', async () => {
    const events: ConversationMessageEvent[] = [];
    const conversationMessages = new TelegramConversationMessages(
      {
        isAllMessagesSubscribed: (conversationId) => conversationId === String(GROUP),
        conversationDelivery: (conversationId) => (conversationId === String(GROUP) ? 'all' : 'none'),
        emit: (e) => void events.push(e),
      },
      BOT_ID,
    );
    const h = harness({ conversationMessages } as Partial<TelegramBotOptions>);
    await h.pairingStore.putGroupActivation(activation(GROUP));
    await h.pairingStore.putGroupActivation(activation(OTHER_GROUP));

    await h.bot.handleUpdate(groupText('A > C > B', GROUP, 41));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.text, 'A > C > B');
    assert.equal(events[0]?.addressedToBot, undefined);
    assert.equal(h.turns.length, 0, 'the engine drives, no turn');

    await h.bot.handleUpdate(groupText('A > C > B', OTHER_GROUP, 41));
    assert.equal(events.length, 1, 'not facilitated: nothing recorded');
    assert.equal(h.turns.length, 0, 'not addressed: ignored');

    await h.bot.handleUpdate(groupText(`@${BOT_USERNAME} wie ist der Stand?`, OTHER_GROUP, 41));
    assert.equal(h.turns.length, 1, 'a mention there still starts a turn');
  });
});

// ── fresh roster ────────────────────────────────────────────────────────────

describe('fresh roster (acceptance: a join within the cache lifetime)', () => {
  it('a fresh query sees a join the cache does not, and is complete only when proven', async () => {
    const store = memoryStore();
    const tracker = new GroupMemberTracker(store);
    const anna = person(1, 'Anna');
    const ben = person(2, 'Ben');
    await tracker.observe(GROUP, [anna]);
    let members = [anna];
    let failing = false;
    const api = {
      getChatAdministrators: async () => [],
      getChatMemberCount: async () => members.length + 1,
      getChatMember: async ({ user_id }: { user_id: number }) => {
        if (failing) throw new Error('Too Many Requests (code=429)');
        const user = members.find((u) => u.id === user_id);
        return { user: user ?? person(user_id), status: user ? 'member' : 'left' };
      },
    } as unknown as ConstructorParameters<typeof TelegramRosterProvider>[0];
    const pairingStore = new PairingStore(store);
    await pairingStore.putGroupActivation(activation(GROUP));
    const roster = new TelegramConversationRosterProvider({
      roster: new TelegramRosterProvider(api, tracker, BOT_ID),
      pairingStore,
      bot: { id: BOT_ID, username: BOT_USERNAME },
    });

    assert.equal((await roster.getRoster(String(GROUP)))?.status, 'complete');
    // Ben joins; the bot saw it (tracker) but the cached roster predates it.
    members = [anna, ben];
    await tracker.observe(GROUP, [ben]);
    const cached = await roster.getRoster(String(GROUP));
    assert.deepEqual(cached?.participants.map((p) => p.userRef.id), ['1'], 'cached within 10 s');
    const fresh = await roster.getRoster(String(GROUP), { fresh: true });
    assert.deepEqual(fresh?.participants.map((p) => p.userRef.id).sort(), ['1', '2']);
    assert.equal(fresh?.status, 'complete');
    assert.match(fresh?.readAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    // A failed check is never complete.
    failing = true;
    const failed = await roster.getRoster(String(GROUP), { fresh: true });
    assert.notEqual(failed?.status, 'complete');
    assert.equal(failed?.partial, true);
  });
});
