/**
 * Membership events for the kernel (spec 2043 §5.5 "membership changes",
 * byte5ai/omadia-channel-telegram#8): a person who joins an activated group
 * becomes a participant, a person who leaves becomes `left`.
 *
 * Sources, as Telegram delivers them:
 *  - `new_chat_members` / `left_chat_member` service messages (every bot in
 *    the group receives them, privacy mode or not);
 *  - `chat_member` updates (only while the bot is an administrator);
 *  - `my_chat_member` for the bot itself (`bot_added`, with who added it).
 *
 * One change usually arrives more than once: as a service message AND a
 * `chat_member` update, and once per bot of the installation in the group.
 * The kernel event carries no id to deduplicate by, so this module drops a
 * repeat of the same change (same chat, same person, same direction) within
 * {@link MEMBERSHIP_DEDUPE_MS}. A real join, leave and re-join in a row are
 * three changes and all go out.
 *
 * Bots are not members in the kernel's sense (agents are not participants),
 * so they are left out of `members_added` / `members_removed`. Emitting is
 * fire-and-forget; a failure never breaks the update that carried it.
 */

import type { ChannelUserRef, ConversationMembershipEvent } from '@omadia/channel-sdk';

import type { TelegramChat, TelegramUser } from './telegramBot.js';

/** How long a repeat of the same membership change is treated as a duplicate. */
export const MEMBERSHIP_DEDUPE_MS = 60_000;
/** Above this many remembered changes the expired ones are dropped. */
const MAX_REMEMBERED = 1_000;
/** Replaced with the catalog id by the plugin; the adapter cannot know it. */
const CHANNEL_ID_PLACEHOLDER = 'de.byte5.channel.telegram';

type Direction = 'joined' | 'left' | 'bot_added';

export type MembershipEventSink = (event: ConversationMembershipEvent) => void;

export class TelegramMembershipEvents {
  private readonly lastEmitted = new Map<string, { readonly direction: Direction; readonly at: number }>();

  constructor(
    private readonly emit: MembershipEventSink,
    private readonly now: () => number = Date.now,
    private readonly dedupeMs: number = MEMBERSHIP_DEDUPE_MS,
  ) {}

  /** People joined (or were added to) the group. `date`: Unix seconds of the platform event. */
  joined(chat: TelegramChat, users: readonly TelegramUser[], date: number): void {
    const members = this.fresh(chat.id, humans(users), 'joined');
    if (members.length > 0) this.send({ kind: 'members_added', ...base(chat, members, date) });
  }

  /** People left (or were removed from) the group. */
  left(chat: TelegramChat, users: readonly TelegramUser[], date: number): void {
    const members = this.fresh(chat.id, humans(users), 'left');
    if (members.length > 0) this.send({ kind: 'members_removed', ...base(chat, members, date) });
  }

  /** This bot was added to the group by `addedBy` (a paired person: the group is activated). */
  botAdded(chat: TelegramChat, bot: TelegramUser, addedBy: TelegramUser, date: number): void {
    if (this.fresh(chat.id, [bot], 'bot_added').length === 0) return;
    this.send({ kind: 'bot_added', ...base(chat, [userRef(bot)], date), addedBy: userRef(addedBy) });
  }

  /** The users whose change is not a repeat; remembers them as emitted. */
  private fresh(chatId: number, users: readonly TelegramUser[], direction: Direction): ChannelUserRef[] {
    const now = this.now();
    this.prune(now);
    return users
      .filter((user) => {
        const key = `${String(chatId)}:${String(user.id)}`;
        const last = this.lastEmitted.get(key);
        if (last && last.direction === direction && now - last.at < this.dedupeMs) return false;
        this.lastEmitted.set(key, { direction, at: now });
        return true;
      })
      .map(userRef);
  }

  private prune(now: number): void {
    if (this.lastEmitted.size < MAX_REMEMBERED) return;
    for (const [key, entry] of this.lastEmitted) {
      if (now - entry.at >= this.dedupeMs) this.lastEmitted.delete(key);
    }
  }

  private send(event: ConversationMembershipEvent): void {
    try {
      this.emit(event);
    } catch (err) {
      console.error('[telegram] membership event emit failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

function humans(users: readonly TelegramUser[]): TelegramUser[] {
  return users.filter((u) => !u.is_bot);
}

function userRef(user: TelegramUser): ChannelUserRef {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return { kind: 'telegram-chat', id: String(user.id), ...(name ? { displayName: name } : {}) };
}

function base(chat: TelegramChat, members: readonly ChannelUserRef[], date: number) {
  return {
    channelId: CHANNEL_ID_PLACEHOLDER,
    channelType: 'telegram',
    conversationId: String(chat.id),
    conversationType: 'group' as const,
    members,
    occurredAt: new Date(date * 1000).toISOString(),
  };
}
