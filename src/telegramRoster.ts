/**
 * Roster provider for group / supergroup chats.
 *
 * Telegram gives bots no member listing, so the roster is the union of the
 * administrators (`getChatAdministrators`) and everyone the
 * `GroupMemberTracker` has seen in the chat.
 *
 * The kernel's member-scoped memory reads the roster as the room's audience,
 * and only a complete roster may serve as one: someone missing from it would
 * read knowledge that is not theirs. Completeness is therefore proven, never
 * assumed. Each candidate is checked with `getChatMember` (a leaver drops out)
 * and the verified set is compared with `getChatMemberCount`. Verified members
 * are a subset of the real ones; equal size means equal sets, so only then
 * does the provider carry `completeRoster: true`.
 *
 * Cache: 10 s per chat. Every group turn reads the audience, and a newcomer
 * must not stay invisible behind a long TTL.
 */

import type {
  ChatParticipant,
  ChatParticipantsProvider,
} from './kernel-types.js';
import type { GroupMemberTracker, TrackedMember } from './groupMemberTracker.js';
import type { TelegramApiClient, TelegramUser } from './telegramBot.js';

/** Statuses of someone currently in the chat (`restricted` needs `is_member`). */
const PRESENT = new Set(['creator', 'administrator', 'member']);

const DEFAULT_TTL_MS = 10_000;

/** Above this size the roster stays unverified: one `getChatMember` per member. */
export const MAX_VERIFIED_MEMBERS = 50;

export interface RosterSnapshot {
  /** Everyone known to be in the chat except this bot; other bots marked `kind: 'agent'`. */
  participants: ChatParticipant[];
  /** True only when `participants` + this bot is provably the whole chat. */
  complete: boolean;
}

interface CacheEntry {
  snapshot: RosterSnapshot;
  expiresAt: number;
}

export class TelegramRosterProvider {
  private readonly cache = new Map<number, CacheEntry>();

  constructor(
    private readonly api: TelegramApiClient,
    private readonly tracker: GroupMemberTracker,
    private readonly botId: number,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /**
   * A per-turn ChatParticipantsProvider bound to a chat, flagged complete
   * only when the roster is proven complete.
   */
  async forChat(chatId: number): Promise<ChatParticipantsProvider> {
    const snapshot = await this.audience(chatId);
    return Object.assign(async () => snapshot.participants, {
      completeRoster: snapshot.complete,
    });
  }

  async audience(chatId: number): Promise<RosterSnapshot> {
    const now = Date.now();
    const cached = this.cache.get(chatId);
    if (cached && cached.expiresAt > now) return cached.snapshot;
    const snapshot = await this.build(chatId);
    this.cache.set(chatId, { snapshot, expiresAt: now + this.ttlMs });
    return snapshot;
  }

  /** Drop the cached roster, e.g. after a membership change was observed. */
  invalidate(chatId: number): void {
    this.cache.delete(chatId);
  }

  private async build(chatId: number): Promise<RosterSnapshot> {
    const candidates = new Map<number, TelegramUser>();
    for (const m of await this.tracker.members(chatId)) candidates.set(m.id, fromTracked(m));
    try {
      const admins = await this.api.getChatAdministrators({ chat_id: chatId });
      for (const a of admins) candidates.set(a.user.id, a.user);
    } catch (err) {
      warn(`getChatAdministrators(${String(chatId)})`, err);
    }

    const unverified = (): RosterSnapshot => ({
      participants: participantsOf([...candidates.values()], this.botId),
      complete: false,
    });

    let count: number;
    try {
      count = await this.api.getChatMemberCount({ chat_id: chatId });
    } catch (err) {
      warn(`getChatMemberCount(${String(chatId)})`, err);
      return unverified();
    }
    candidates.delete(this.botId);
    // This bot is one of `count`. Too few candidates cannot add up; too many
    // members would cost one call each.
    if (count > MAX_VERIFIED_MEMBERS || candidates.size + 1 < count) return unverified();

    const checked = await Promise.all(
      [...candidates.values()].map(async (user) => {
        try {
          const m = await this.api.getChatMember({ chat_id: chatId, user_id: user.id });
          const present = PRESENT.has(m.status) || (m.status === 'restricted' && m.is_member === true);
          return { user: m.user ?? user, present, failed: false };
        } catch (err) {
          warn(`getChatMember(${String(chatId)}, ${String(user.id)})`, err);
          return { user, present: false, failed: true };
        }
      }),
    );
    const gone = checked.filter((c) => !c.present && !c.failed).map((c) => c.user.id);
    if (gone.length > 0) await this.tracker.forget(chatId, gone);

    const verified = checked.filter((c) => c.present).map((c) => c.user);
    return {
      participants: participantsOf(verified, this.botId),
      complete: !checked.some((c) => c.failed) && verified.length + 1 === count,
    };
  }
}

function participantsOf(users: readonly TelegramUser[], botId: number): ChatParticipant[] {
  return users
    .filter((u) => u.id !== botId)
    .map((u) => ({
      channelUserId: `telegram:${String(u.id)}`,
      aadObjectId: null,
      displayName: telegramDisplayName(u),
      email: null,
      userPrincipalName: u.username ? `@${u.username}` : null,
      ...(u.is_bot ? { kind: 'agent' as const } : {}),
    }));
}

function fromTracked(m: TrackedMember): TelegramUser {
  return {
    id: m.id,
    is_bot: m.isBot,
    first_name: m.firstName,
    ...(m.lastName ? { last_name: m.lastName } : {}),
    ...(m.username ? { username: m.username } : {}),
  };
}

function warn(call: string, err: unknown): void {
  console.warn(`[telegram] ${call} failed: ${err instanceof Error ? err.message : String(err)}`);
}

function telegramDisplayName(user: {
  first_name: string;
  last_name?: string;
  username?: string;
}): string {
  const composed = [user.first_name, user.last_name]
    .filter((s): s is string => Boolean(s))
    .join(' ')
    .trim();
  if (composed.length > 0) return composed;
  return user.username ? `@${user.username}` : 'Telegram User';
}
