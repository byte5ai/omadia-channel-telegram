/**
 * Roster provider for group / supergroup chats. Uses Bot API
 * `getChatAdministrators` because there is no public membership listing —
 * non-admin members stay invisible to the orchestrator's
 * `get_chat_participants` tool. This is a Bot-API limitation, not a bug:
 * Telegram exposes member listings only to user accounts, not bots.
 *
 * Cache: 5min TTL per chat, mirrors the Teams roster provider's window.
 * Invalidated implicitly by TTL — we never see member-add/remove events,
 * so a TTL is the only honest invalidation strategy.
 */

import type {
  ChatParticipant,
  ChatParticipantsProvider,
} from './kernel-types.js';
import type { TelegramApiClient } from './telegramBot.js';

interface CacheEntry {
  participants: ChatParticipant[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class TelegramRosterProvider {
  private readonly cache = new Map<number, CacheEntry>();

  constructor(
    private readonly api: TelegramApiClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /**
   * Returns a one-shot ChatParticipantsProvider bound to a specific chat.
   * Used by the bot to install per-turn into the AsyncLocalStorage namespace
   * so the orchestrator's get_chat_participants tool sees the right chat.
   */
  forChat(chatId: number): ChatParticipantsProvider {
    return async () => await this.list(chatId);
  }

  async list(chatId: number): Promise<ChatParticipant[]> {
    const now = Date.now();
    const cached = this.cache.get(chatId);
    if (cached && cached.expiresAt > now) return cached.participants;
    try {
      const admins = await this.api.getChatAdministrators({
        chat_id: chatId,
      });
      const participants: ChatParticipant[] = admins
        .filter((entry) => !entry.user.is_bot)
        .map((entry) => ({
          channelUserId: `telegram:${String(entry.user.id)}`,
          aadObjectId: null,
          displayName: telegramDisplayName(entry.user),
          email: null,
          userPrincipalName: entry.user.username
            ? `@${entry.user.username}`
            : null,
        }));
      this.cache.set(chatId, {
        participants,
        expiresAt: now + this.ttlMs,
      });
      return participants;
    } catch (err) {
      // Graceful: in private chats `getChatAdministrators` 400s. Caller can
      // omit the roster from the turn-context and proceed.
      console.warn(
        `[telegram] getChatAdministrators(${String(chatId)}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }
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
