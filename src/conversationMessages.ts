/**
 * Inbound message events for native facilitators (byte5ai/omadia#2043, spec
 * 2042 criterion 30): in a conversation an agent moderates, the kernel needs
 * what people write, with the author as Telegram states it, and the answers to
 * the questions the bot posted as text.
 *
 * HOW MUCH the kernel is handed is its answer per bot and conversation
 * (`conversationDelivery`): `all` (every human message; the engine drives the
 * turns, the adapter starts none), `addressed` (what addresses the bot: a
 * mention, a command, a reply to the bot, a private chat; the ordinary turn
 * still runs), `none`. A kernel without `conversationDelivery` knows `all` and
 * `none` only.
 *
 * Rules: the author is `message.from`, set by Telegram, never read from the
 * text. A bot is never an author. An event is not a turn, and a failure to
 * emit never breaks the message that carried it.
 *
 * Not handled: edits and deletions (Telegram sends `edited_message` only when
 * asked for it, and never tells a bot about a deletion), reactions.
 */

import type { CardAnswerValue } from '@omadia/plugin-api';
import type { ConversationMessageEvent } from '@omadia/channel-sdk';

import type { TelegramMessage, TelegramUser } from './telegramBot.js';

export const TELEGRAM_EVENT_CHANNEL_TYPE = 'telegram';
/** Replaced with the catalog id by plugin.ts; the adapter cannot know it. */
const CHANNEL_ID_PLACEHOLDER = 'de.byte5.channel.telegram';

export type TelegramDeliveryMode = 'all' | 'addressed' | 'none';

/** The kernel calls this module needs, already feature-detected. */
export interface TelegramConversationMessageSink {
  isAllMessagesSubscribed(conversationId: string, channelKey: string): boolean;
  conversationDelivery?(conversationId: string, channelKey: string): TelegramDeliveryMode;
  emit(event: ConversationMessageEvent): void;
}

/** What a card answer carries besides the typed values. */
export interface TelegramCardAnswer {
  readonly cardId: string;
  readonly kind: 'card' | 'poll';
  readonly answers: readonly CardAnswerValue[];
  readonly proposalId?: string;
  readonly proposalVersion?: number;
}

/**
 * The channel key the kernel knows this bot by: the `@bot_username` form the
 * SDK documents for Telegram binding keys (`channelKeyDirectory`).
 */
export function telegramBotKey(username: string): string | undefined {
  const bare = username.trim().replace(/^@/, '');
  return bare ? `@${bare}` : undefined;
}

/** Does `key` name the bot with this username (`@name` or `name`, any case)? */
export function isOwnBotKey(key: string, username: string): boolean {
  const own = username.trim().replace(/^@/, '').toLowerCase();
  return own.length > 0 && key.trim().replace(/^@/, '').toLowerCase() === own;
}

export function telegramAuthor(user: TelegramUser | undefined): ConversationMessageEvent['author'] | undefined {
  if (!user || user.is_bot) return undefined;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return { kind: 'telegram-chat', id: String(user.id), ...(name ? { displayName: name } : {}) };
}

export class TelegramConversationMessages {
  constructor(
    private readonly sink: TelegramConversationMessageSink,
    private readonly botUsername: string,
  ) {}

  /** What the kernel hands this bot of a chat. */
  delivery(chatId: number): TelegramDeliveryMode {
    const key = telegramBotKey(this.botUsername);
    if (!key) return 'none';
    const conversationId = String(chatId);
    try {
      if (this.sink.conversationDelivery) return this.sink.conversationDelivery(conversationId, key);
      return this.sink.isAllMessagesSubscribed(conversationId, key) ? 'all' : 'none';
    } catch (err) {
      console.error('[telegram] delivery lookup failed:', errorMessage(err));
      return 'none';
    }
  }

  /**
   * A human message. In `addressed` mode only when `isAddressed`. Returns
   * whether an event went out.
   */
  emitCreated(message: TelegramMessage, mode: TelegramDeliveryMode, isAddressed: boolean): boolean {
    if (mode === 'none' || (mode === 'addressed' && !isAddressed)) return false;
    const text = (message.text ?? message.caption ?? '').trim();
    if (text.length === 0) return false;
    return this.emit(message, {
      kind: 'created',
      text,
      ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
      ...(isAddressed ? { addressedToBot: true } : {}),
    });
  }

  /** One accepted answer to a question the bot posted as text. */
  emitCardAnswer(message: TelegramMessage, answer: TelegramCardAnswer): boolean {
    const first = answer.answers[0];
    const value =
      answer.kind === 'poll' && first?.kind === 'single_choice'
        ? { optionId: first.optionId }
        : { answers: answer.answers };
    return this.emit(message, {
      kind: 'card_answer',
      // the message the card answers, per the contract
      messageIdOverride: String(message.reply_to_message?.message_id ?? message.message_id),
      cardAnswer: {
        cardId: answer.cardId,
        value,
        // Telegram states who wrote the reply
        answererVerified: true,
        ...(answer.kind === 'card'
          ? {
              answers: answer.answers,
              ...(answer.proposalId !== undefined ? { proposalId: answer.proposalId } : {}),
              ...(answer.proposalVersion !== undefined ? { proposalVersion: answer.proposalVersion } : {}),
            }
          : {}),
      },
    });
  }

  private emit(
    message: TelegramMessage,
    part: Pick<ConversationMessageEvent, 'kind'> &
      Partial<Pick<ConversationMessageEvent, 'text' | 'replyToMessageId' | 'cardAnswer' | 'addressedToBot'>> & {
        messageIdOverride?: string;
      },
  ): boolean {
    try {
      const botKey = telegramBotKey(this.botUsername);
      const author = telegramAuthor(message.from);
      if (!botKey || !author) return false;
      const { messageIdOverride, ...rest } = part;
      this.sink.emit({
        channelId: CHANNEL_ID_PLACEHOLDER,
        channelType: TELEGRAM_EVENT_CHANNEL_TYPE,
        conversationId: String(message.chat.id),
        conversationType: message.chat.type === 'private' ? 'direct' : 'group',
        receivedByChannelKey: botKey,
        messageId: messageIdOverride ?? String(message.message_id),
        revision: 0,
        author,
        occurredAt: new Date(message.date * 1000).toISOString(),
        ...rest,
      });
      return true;
    } catch (err) {
      console.error('[telegram] message event emit failed:', errorMessage(err));
      return false;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
