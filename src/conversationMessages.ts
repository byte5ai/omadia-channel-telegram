/**
 * Inbound message events for native facilitators (byte5ai/omadia#2043, spec
 * 2042 criterion 30): in a conversation an agent moderates, the kernel needs
 * what people write, with the author as Telegram states it. The kernel also
 * matches a typed answer to a question it posted as text by these events, so
 * each carries `replyToMessageId` (the Telegram `message_id` of the message
 * replied to) and `addressedToBot` (a mention, a command, a reply to the bot,
 * or a private chat).
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
  /**
   * Like `emit`, but the kernel says whether it consumed the message as the
   * typed answer to an open question (`answeredCard`). Absent on a kernel
   * without `reportConversationMessage`: then the message is emitted and the
   * turn runs as before.
   */
  report?(event: ConversationMessageEvent): Promise<{ answeredCard: boolean }>;
}

/**
 * How long a turn waits for the kernel's verdict on a message. The report never
 * delays the turn longer: after this the turn starts as if the answer were `false`.
 */
export const REPORT_TIMEOUT_MS = 1_500;

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
    private readonly reportTimeoutMs: number = REPORT_TIMEOUT_MS,
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
   * A human message the engine drives (`all` mode) or that only needs recording.
   * In `addressed` mode only when `isAddressed`. `said` is the text without the
   * bot's own mention. Fire-and-forget; returns whether an event went out.
   */
  emitCreated(
    message: TelegramMessage,
    mode: TelegramDeliveryMode,
    isAddressed: boolean,
    said?: string,
  ): boolean {
    const event = this.createdEvent(message, mode, isAddressed, said);
    return event ? this.send(event) : false;
  }

  /**
   * A message the channel would otherwise start a turn for (the addressed path,
   * a private chat): reported to the kernel BEFORE the turn. Returns true when
   * the kernel consumed it as the typed answer to an open question, in which
   * case the channel starts no turn. A slow or failing report returns false
   * (never throws, never delays the turn past the timeout), and a kernel
   * without the verdict gets a plain event.
   */
  async reportCreated(
    message: TelegramMessage,
    mode: TelegramDeliveryMode,
    isAddressed: boolean,
    said?: string,
  ): Promise<boolean> {
    const event = this.createdEvent(message, mode, isAddressed, said);
    if (!event) return false;
    const report = this.sink.report;
    if (!report) {
      this.send(event);
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verdict = await Promise.race([
        report.call(this.sink, event),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.reportTimeoutMs);
        }),
      ]);
      if (verdict === undefined) {
        console.warn(`[telegram] report of message ${event.messageId} took over ${String(this.reportTimeoutMs)} ms — the turn starts without the verdict`);
      }
      return verdict?.answeredCard === true;
    } catch (err) {
      console.error('[telegram] message report failed:', errorMessage(err));
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private send(event: ConversationMessageEvent): boolean {
    try {
      this.sink.emit(event);
      return true;
    } catch (err) {
      console.error('[telegram] message event emit failed:', errorMessage(err));
      return false;
    }
  }

  private createdEvent(
    message: TelegramMessage,
    mode: TelegramDeliveryMode,
    isAddressed: boolean,
    said?: string,
  ): ConversationMessageEvent | undefined {
    if (mode === 'none' || (mode === 'addressed' && !isAddressed)) return undefined;
    const text = (said ?? message.text ?? message.caption ?? '').trim();
    if (text.length === 0) return undefined;
    return this.build(message, {
      kind: 'created',
      text,
      ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
      ...(isAddressed ? { addressedToBot: true } : {}),
    });
  }

  private build(
    message: TelegramMessage,
    part: Pick<ConversationMessageEvent, 'kind'> &
      Partial<Pick<ConversationMessageEvent, 'text' | 'replyToMessageId' | 'addressedToBot'>>,
  ): ConversationMessageEvent | undefined {
    const botKey = telegramBotKey(this.botUsername);
    const author = telegramAuthor(message.from);
    if (!botKey || !author) return undefined;
    return {
      channelId: CHANNEL_ID_PLACEHOLDER,
      channelType: TELEGRAM_EVENT_CHANNEL_TYPE,
      conversationId: String(message.chat.id),
      conversationType: message.chat.type === 'private' ? 'direct' : 'group',
      receivedByChannelKey: botKey,
      messageId: String(message.message_id),
      revision: 0,
      author,
      occurredAt: new Date(message.date * 1000).toISOString(),
      ...part,
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
