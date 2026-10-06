/**
 * Who has been seen in a Telegram group.
 *
 * The Bot API has no member listing for bots, so the roster is assembled from
 * what the bot observes: message senders, `new_chat_members` /
 * `left_chat_member` service messages and `chat_member` updates (delivered
 * only while the bot is an admin). The set is persisted per chat so a restart
 * does not forget everyone who has been quiet since.
 *
 * Nothing here claims the set is complete — `TelegramRosterProvider.audience`
 * verifies it against `getChatMember` / `getChatMemberCount` before the
 * kernel may treat it as the room.
 */

import type { MemoryStoreShim } from './kernel-types.js';
import type { TelegramUser } from './telegramBot.js';

const DIR = '/memories/pairings/group-members';

export interface TrackedMember {
  id: number;
  isBot: boolean;
  firstName: string;
  lastName?: string;
  username?: string;
}

export class GroupMemberTracker {
  private readonly loaded = new Map<number, Map<number, TrackedMember>>();

  constructor(private readonly memory: MemoryStoreShim) {}

  async members(chatId: number): Promise<TrackedMember[]> {
    return [...(await this.load(chatId)).values()];
  }

  /**
   * Record `users` as present. Persists only when something changed; returns
   * whether someone was new.
   */
  async observe(chatId: number, users: readonly TelegramUser[]): Promise<boolean> {
    const current = await this.load(chatId);
    const changed = users.filter((u) => !sameMember(current.get(u.id), toMember(u)));
    if (changed.length === 0) return false;
    const isNew = changed.some((u) => !current.has(u.id));
    const next = new Map(current);
    for (const u of changed) next.set(u.id, toMember(u));
    await this.save(chatId, next);
    return isNew;
  }

  /** Remove `userIds`; returns whether anyone was removed. */
  async forget(chatId: number, userIds: readonly number[]): Promise<boolean> {
    const current = await this.load(chatId);
    if (!userIds.some((id) => current.has(id))) return false;
    const next = new Map(current);
    for (const id of userIds) next.delete(id);
    await this.save(chatId, next);
    return true;
  }

  private async load(chatId: number): Promise<Map<number, TrackedMember>> {
    const hit = this.loaded.get(chatId);
    if (hit) return hit;
    const path = memberPath(chatId);
    let members = new Map<number, TrackedMember>();
    try {
      if (await this.memory.fileExists(path)) {
        const parsed = JSON.parse(await this.memory.readFile(path)) as {
          members?: TrackedMember[];
        };
        members = new Map((parsed.members ?? []).map((m) => [m.id, m]));
      }
    } catch (err) {
      // A corrupt file only costs completeness: the roster stays unverified
      // and the kernel treats the room as unknown.
      console.warn(
        `[telegram] group members of chat=${String(chatId)} unreadable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.loaded.set(chatId, members);
    return members;
  }

  private async save(chatId: number, members: Map<number, TrackedMember>): Promise<void> {
    this.loaded.set(chatId, members);
    const path = memberPath(chatId);
    const body = JSON.stringify({ chatId, members: [...members.values()] }, null, 2);
    try {
      if (await this.memory.fileExists(path)) {
        await this.memory.writeFile(path, body);
      } else {
        await this.memory.createFile(path, body);
      }
    } catch (err) {
      console.warn(
        `[telegram] group members of chat=${String(chatId)} not persisted: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function toMember(u: TelegramUser): TrackedMember {
  return {
    id: u.id,
    isBot: u.is_bot,
    firstName: u.first_name,
    ...(u.last_name ? { lastName: u.last_name } : {}),
    ...(u.username ? { username: u.username } : {}),
  };
}

function sameMember(a: TrackedMember | undefined, b: TrackedMember): boolean {
  return (
    a !== undefined &&
    a.isBot === b.isBot &&
    a.firstName === b.firstName &&
    a.lastName === b.lastName &&
    a.username === b.username
  );
}

function memberPath(chatId: number): string {
  // Group ids are negative; keep the sign readable in the file name.
  const safe = String(chatId).replace(/[^0-9-]/g, '_');
  return `${DIR}/${safe}.json`;
}
