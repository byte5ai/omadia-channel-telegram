/**
 * The roster the kernel reads for its audience floor must say honestly how
 * much Telegram let the bot see: `complete` only when proven, `partial` for
 * administrators plus seen members, `unknown` when nothing was readable.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GroupMemberTracker,
  PairingStore,
  TelegramConversationRosterProvider,
  TelegramRosterProvider,
} from '@omadia/channel-telegram';

import { memoryStore } from './fakes.js';

const CHAT = -100500;
const BOT = { id: 999, username: 'ColleagueBot' };
const NOW = new Date('2026-11-20T10:00:00Z');

const user = (id: number, name: string, isBot = false) => ({ id, is_bot: isBot, first_name: name });

async function provider(opts: {
  admins?: ReturnType<typeof user>[];
  count: number | 'fail';
  tracked?: ReturnType<typeof user>[];
  activated?: boolean;
}): Promise<TelegramConversationRosterProvider> {
  const store = memoryStore();
  const tracker = new GroupMemberTracker(store);
  await tracker.observe(CHAT, opts.tracked ?? []);
  const known = [...(opts.admins ?? []), ...(opts.tracked ?? [])];
  const api = {
    getChatAdministrators: async () => (opts.admins ?? []).map((u) => ({ user: u, status: 'administrator' })),
    getChatMemberCount: async () => {
      if (opts.count === 'fail') throw new Error('nope');
      return opts.count;
    },
    getChatMember: async ({ user_id }: { user_id: number }) => ({
      user: known.find((u) => u.id === user_id) ?? user(user_id, 'x'),
      status: 'member',
    }),
  } as unknown as ConstructorParameters<typeof TelegramRosterProvider>[0];
  const pairingStore = new PairingStore(store);
  if (opts.activated !== false) {
    await pairingStore.putGroupActivation({
      chatId: CHAT, chatTitle: 'T', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: NOW.toISOString(),
    });
  }
  return new TelegramConversationRosterProvider({
    roster: new TelegramRosterProvider(api, tracker, BOT.id),
    pairingStore,
    bot: BOT,
    now: () => NOW,
  });
}

describe('TelegramConversationRosterProvider', () => {
  it('declares its channel type', async () => {
    assert.equal((await provider({ count: 2 })).channelType, 'telegram');
  });

  it('a group proven complete is complete', async () => {
    const r = await (await provider({ admins: [user(1, 'Anna')], tracked: [user(2, 'Ben')], count: 3 })).getRoster(String(CHAT));
    assert.equal(r?.status, 'complete');
    assert.equal(r?.partial, false);
    assert.equal(r?.conversationType, 'group');
    assert.deepEqual(r?.participants.map((p) => p.userRef.id).sort(), ['1', '2']);
    assert.equal(r?.self?.userRef.id, '999');
    assert.equal(r?.self?.isBot, true);
  });

  it('administrators only, with more members than known, is partial and says so', async () => {
    const r = await (await provider({ admins: [user(1, 'Anna')], count: 40 })).getRoster(String(CHAT));
    assert.equal(r?.status, 'partial');
    assert.equal(r?.partial, true);
    assert.match(r?.statusDetail ?? '', /administrators/);
    assert.deepEqual(r?.participants.map((p) => p.userRef.id), ['1']);
  });

  it('is unknown when no member could be read', async () => {
    const r = await (await provider({ count: 'fail' })).getRoster(String(CHAT));
    assert.equal(r?.status, 'unknown');
    assert.equal(r?.partial, true);
    assert.deepEqual(r?.participants, []);
  });

  it('marks other bots and carries the @username', async () => {
    const r = await (await provider({ admins: [{ ...user(50, 'Helper', true), username: 'helper_bot' }], count: 2 })).getRoster(String(CHAT));
    assert.equal(r?.participants[0]?.isBot, true);
    assert.equal(r?.participants[0]?.userPrincipalName, '@helper_bot');
  });

  it('does not resolve a group the bot is not activated in', async () => {
    assert.equal(await (await provider({ count: 2, activated: false })).getRoster(String(CHAT)), undefined);
  });

  it('a private chat is the person and the bot', async () => {
    const r = await (await provider({ count: 2 })).getRoster('4711');
    assert.equal(r?.conversationType, 'direct');
    assert.equal(r?.status, 'complete');
    assert.deepEqual(r?.participants.map((p) => p.userRef.id), ['4711']);
  });

  it('does not resolve anything that is not a Telegram chat id', async () => {
    assert.equal(await (await provider({ count: 2 })).getRoster('19:abc@thread.v2'), undefined);
  });

  it('answers for its own identity only, never another bot’s view', async () => {
    const p = await provider({ admins: [user(1, 'Anna')], count: 2 });
    assert.ok(await p.getRoster(String(CHAT), { asChannelKey: 'tg:999' }));
    assert.ok(await p.getRoster(String(CHAT), { asChannelKey: 'TG:999' }));
    assert.equal(await p.getRoster(String(CHAT), { asChannelKey: '@ColleagueBot' }), undefined);
    assert.equal(await p.getRoster(String(CHAT), { asChannelKey: 'tg:1000' }), undefined);
    assert.equal(await p.getRoster(String(CHAT), { asChannelKey: '28:app-id' }), undefined);
  });

  it('`fresh` re-reads and the answer carries when the platform was asked', async () => {
    const p = await provider({ admins: [user(1, 'Anna')], count: 2 });
    const r = await p.getRoster(String(CHAT), { fresh: true });
    assert.match(r?.readAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});
