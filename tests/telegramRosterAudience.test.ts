/**
 * The Telegram roster as the room's audience for member-scoped memory.
 *
 * Telegram gives bots no member listing, so the roster may claim to be
 * complete only when every tracked member is verified present and the
 * verified set adds up to `getChatMemberCount`.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GroupMemberTracker,
  MAX_VERIFIED_MEMBERS,
  TelegramRosterProvider,
} from '@omadia/channel-telegram';

const CHAT = -100123;
const BOT = 999;

interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

const user = (id: number, name: string, isBot = false): User => ({ id, is_bot: isBot, first_name: name });
const anna = user(1, 'Anna');
const ben = user(2, 'Ben');
const carl = user(3, 'Carl');
const helper = user(50, 'HelperBot', true);

function memoryStore(): ConstructorParameters<typeof GroupMemberTracker>[0] {
  const files = new Map<string, string>();
  return {
    list: async () => [],
    fileExists: async (p: string) => files.has(p),
    directoryExists: async () => true,
    readFile: async (p: string) => files.get(p) ?? '',
    createFile: async (p: string, c: string) => void files.set(p, c),
    writeFile: async (p: string, c: string) => void files.set(p, c),
    delete: async (p: string) => void files.delete(p),
    rename: async () => undefined,
  };
}

function api(opts: {
  admins?: User[];
  count: number;
  status?: Record<number, string>;
  failing?: number[];
}): { client: ConstructorParameters<typeof TelegramRosterProvider>[0]; memberCalls: () => number } {
  let memberCalls = 0;
  const client = {
    getChatAdministrators: async () => (opts.admins ?? []).map((u) => ({ user: u, status: 'administrator' })),
    getChatMemberCount: async () => opts.count,
    getChatMember: async ({ user_id }: { user_id: number }) => {
      memberCalls += 1;
      if (opts.failing?.includes(user_id)) throw new Error('Too Many Requests');
      const known = [anna, ben, carl, helper].find((u) => u.id === user_id) ?? user(user_id, 'someone');
      return { user: known, status: opts.status?.[user_id] ?? 'member' };
    },
  } as unknown as ConstructorParameters<typeof TelegramRosterProvider>[0];
  return { client, memberCalls: () => memberCalls };
}

async function tracked(...users: User[]): Promise<GroupMemberTracker> {
  const tracker = new GroupMemberTracker(memoryStore());
  await tracker.observe(CHAT, users);
  return tracker;
}

const ids = (ps: Array<{ channelUserId: string }>): string[] => ps.map((p) => p.channelUserId).sort();

describe('TelegramRosterProvider — proven-complete audience', () => {
  it('complete when the verified members plus the bot are the whole chat', async () => {
    const { client } = api({ admins: [anna], count: 3 });
    const roster = new TelegramRosterProvider(client, await tracked(ben), BOT);
    const snap = await roster.audience(CHAT);
    assert.equal(snap.complete, true);
    assert.deepEqual(ids(snap.participants), ['telegram:1', 'telegram:2']);
  });

  it('incomplete when someone joined unseen (count exceeds what is known)', async () => {
    const { client, memberCalls } = api({ admins: [anna], count: 4 });
    const snap = await new TelegramRosterProvider(client, await tracked(ben), BOT).audience(CHAT);
    assert.equal(snap.complete, false);
    assert.equal(memberCalls(), 0, 'too few candidates cannot add up — no per-member calls');
  });

  it('a leaver and an unseen newcomer do not swap: the leaver is verified out', async () => {
    // Known: Anna, Ben, Carl. Carl left, someone unseen joined: count still 4.
    const { client } = api({ count: 4, status: { 3: 'left' } });
    const tracker = await tracked(anna, ben, carl);
    const snap = await new TelegramRosterProvider(client, tracker, BOT).audience(CHAT);
    assert.equal(snap.complete, false);
    assert.deepEqual(ids(snap.participants), ['telegram:1', 'telegram:2']);
    assert.deepEqual((await tracker.members(CHAT)).map((m) => m.id).sort(), [1, 2], 'leaver forgotten');
  });

  it('a failed verification leaves the roster incomplete', async () => {
    const { client } = api({ count: 3, failing: [2] });
    const snap = await new TelegramRosterProvider(client, await tracked(anna, ben), BOT).audience(CHAT);
    assert.equal(snap.complete, false);
  });

  it('another bot counts toward the chat but is marked as an agent', async () => {
    const { client } = api({ count: 3, status: {} });
    const roster = new TelegramRosterProvider(client, await tracked(anna, helper), BOT);
    const snap = await roster.audience(CHAT);
    assert.equal(snap.complete, true);
    assert.equal(snap.participants.find((p) => p.channelUserId === 'telegram:50')?.kind, 'agent');
    assert.equal(snap.participants.find((p) => p.channelUserId === 'telegram:1')?.kind, undefined);
  });

  it(`stays unverified above ${String(MAX_VERIFIED_MEMBERS)} members`, async () => {
    const { client, memberCalls } = api({ count: MAX_VERIFIED_MEMBERS + 1 });
    const snap = await new TelegramRosterProvider(client, await tracked(anna), BOT).audience(CHAT);
    assert.equal(snap.complete, false);
    assert.equal(memberCalls(), 0);
  });

  it('forChat flags the provider with the proven completeness', async () => {
    const complete = await new TelegramRosterProvider(api({ count: 2 }).client, await tracked(anna), BOT).forChat(CHAT);
    assert.equal(complete.completeRoster, true);
    assert.deepEqual(ids(await complete()), ['telegram:1']);
    const partial = await new TelegramRosterProvider(api({ count: 5 }).client, await tracked(anna), BOT).forChat(CHAT);
    assert.equal(partial.completeRoster, false);
  });

  it('serves the cache for 10 s, and invalidate forces a fresh read', async () => {
    let count = 2;
    const client = {
      getChatAdministrators: async () => [],
      getChatMemberCount: async () => count,
      getChatMember: async ({ user_id }: { user_id: number }) => ({ user: user(user_id, 'x'), status: 'member' }),
    } as unknown as ConstructorParameters<typeof TelegramRosterProvider>[0];
    const roster = new TelegramRosterProvider(client, await tracked(anna), BOT);
    assert.equal((await roster.audience(CHAT)).complete, true);
    count = 3; // someone joined
    assert.equal((await roster.audience(CHAT)).complete, true, 'cached');
    roster.invalidate(CHAT);
    assert.equal((await roster.audience(CHAT)).complete, false);
  });
});

describe('GroupMemberTracker', () => {
  it('persists across instances and reports what changed', async () => {
    const store = memoryStore();
    const first = new GroupMemberTracker(store);
    assert.equal(await first.observe(CHAT, [anna, ben]), true);
    assert.equal(await first.observe(CHAT, [anna]), false, 'nothing new');
    assert.equal(await first.forget(CHAT, [ben.id]), true);
    assert.equal(await first.forget(CHAT, [ben.id]), false);
    const second = new GroupMemberTracker(store);
    assert.deepEqual((await second.members(CHAT)).map((m) => m.id), [1]);
  });
});
