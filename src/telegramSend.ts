/**
 * What this plugin hands the kernel to post on an agent's behalf (spec 2042
 * criterion 30, byte5ai/omadia#2043): a conversation send (post INTO a chat)
 * and a targeted send (a DM to one person).
 *
 * The kernel takes no provider's word for granted: it sends as a named
 * identity only to a provider that DECLARES it (`supports`). What is declared
 * here is what is done:
 *
 *  - `asChannelKey`: the provider posts as exactly the bot that key names,
 *    `tg:<botId>`: the installation's own bot or an agent's own bot (spec
 *    2042 §5.3), or returns `unreachable`. It never posts as another identity.
 *    Without `asChannelKey` the installation's own bot posts.
 *  - no `poll`, no `card`: Telegram shows neither. The KERNEL then posts the
 *    question itself as numbered text (`renderCardAsText`), keeps it open and
 *    turns a typed reply into the typed `card_answer` event. This plugin has no
 *    card code. For that the plugin reports the Telegram `message_id` of the
 *    posted message as `messageId` (the question a reply points at) and, in
 *    its `created` events, `replyToMessageId` and `addressedToBot`.
 *  - no `mentions` (the kernel then leaves the text plain), no `aiLabel`
 *    (the kernel puts the disclosure line into the text itself).
 *  - `reactions` (conversation send only, spec 2043 §5.14): `react` sets the
 *    bot's 👍 on a message via the Bot API `setMessageReaction`
 *    (https://core.telegram.org/bots/api#setmessagereaction), as exactly the
 *    bot `asChannelKey` names. The message is addressed the way the inbound
 *    event reported it: `conversationId` = the chat id, `messageId` = the
 *    Telegram `message_id`. A bot sets at most one reaction per message; a
 *    chat whose available reactions exclude 👍 answers an error, returned as
 *    `channel_error`.
 *
 * Unreachability is RETURNED, never thrown.
 */

import { evaluateDmPolicy, type DmPolicy } from './dmPolicyGuard.js';
import type {
  ConversationReactionOutcome,
  ConversationSendProvider,
  SendProviderCapabilities,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendProvider,
} from '@omadia/channel-sdk';
import type { ConversationReaction } from '@omadia/plugin-api';

import type { PairingStore } from './pairingStore.js';
import type { TelegramApiClient } from './telegramBot.js';
import type { TelegramEmitter } from './telegramEmitter.js';

export const TELEGRAM_SEND_CHANNEL_TYPE = 'telegram';

/** What the targeted send declares: the own identity, nothing else. */
export const TELEGRAM_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({ asChannelKey: true });

/** What the conversation send declares: the own identity and reactions. */
export const TELEGRAM_CONVERSATION_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({
  asChannelKey: true,
  reactions: true,
});

/** The platform form of each kernel reaction: Telegram's thumbs-up. */
export const TELEGRAM_REACTION_EMOJI: Readonly<Record<ConversationReaction, string>> = Object.freeze({
  acknowledge: '👍',
});

/** One bot the providers can post as. */
export interface TelegramSendDeps {
  readonly emitter: Pick<TelegramEmitter, 'sendPosted' | 'sendAnswer' | 'sendSystem'>;
  /** This bot's Bot API client, for what is not a message (reactions). */
  readonly api: Pick<TelegramApiClient, 'setMessageReaction'>;
  readonly pairingStore: PairingStore;
  readonly dmPolicy: DmPolicy;
  /** `tg:<botId>`. */
  readonly botKey: string;
}

/**
 * The bot a send goes out as: `undefined` = the installation's own bot, else
 * the bot with exactly that key. `undefined` back = no such bot runs here.
 */
export type TelegramBotLookup = (asChannelKey: string | undefined) => TelegramSendDeps | undefined;

type Unreachable = Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;

const unreachable = (code: Unreachable['code'], message: string): Unreachable => ({
  outcome: 'unreachable',
  code,
  message,
});

/** A Bot API chat id: `-1001234567890`, `12345` (also the `telegram:`-prefixed scope spelling). */
export function parseChatId(raw: string): number | undefined {
  const bare = raw.trim().replace(/^telegram:/, '');
  return /^-?\d+$/.test(bare) ? Number(bare) : undefined;
}

/** `user:telegram-chat:<id>`, the principal form of a Telegram sender. */
export function chatIdOfPrincipal(principalId: string): number | undefined {
  const match = /^user:telegram-chat:(-?\d+)$/i.exec(principalId.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Why a Bot API failure means the person or chat cannot be reached, as the SDK's code. */
export function classifyPostError(err: unknown, isDirect: boolean): Unreachable {
  const message = err instanceof Error ? err.message : String(err);
  if (/code=403/.test(message)) {
    if (/initiate|never started|start the bot/i.test(message)) return unreachable('app_not_installed', message);
    return unreachable(isDirect ? 'blocked' : 'not_permitted', message);
  }
  if (/code=400/.test(message) && /chat not found|user not found/i.test(message)) {
    return unreachable(isDirect ? 'user_not_found' : 'no_binding', message);
  }
  return unreachable('channel_error', message);
}

/** The poster for `asChannelKey`, or why there is none. Never another bot. */
function posterFor(lookup: TelegramBotLookup, asChannelKey: string | undefined): TelegramPoster | Unreachable {
  const key = asChannelKey === undefined ? undefined : asChannelKey.trim().toLowerCase();
  const bot = lookup(key);
  if (!bot || (key !== undefined && bot.botKey !== key)) {
    return unreachable('not_permitted', `no Telegram bot '${String(asChannelKey)}' runs in this installation; nothing was posted`);
  }
  return new TelegramPoster(bot);
}

/**
 * Why this bot may not post into `chatId`, or undefined: a group must have
 * activated THIS bot, a person must pass the DM policy (pairing is shared).
 */
export async function blockedReason(deps: TelegramSendDeps, chatId: number): Promise<Unreachable | undefined> {
  if (chatId < 0) {
    return (await deps.pairingStore.getGroupActivation(chatId))
      ? undefined
      : unreachable('not_permitted', `the bot is not activated in chat ${String(chatId)}`);
  }
  const decision = await evaluateDmPolicy({
    policy: deps.dmPolicy,
    telegramUserId: chatId,
    store: deps.pairingStore,
  });
  return decision.allow ? undefined : unreachable('not_permitted', `chat ${String(chatId)} may not DM the bot (policy ${deps.dmPolicy})`);
}

class TelegramPoster {
  constructor(private readonly deps: TelegramSendDeps) {}

  canPostTo(chatId: number): Promise<Unreachable | undefined> {
    return blockedReason(this.deps, chatId);
  }

  async post(chatId: number, message: TargetedMessage, isDirect: boolean): Promise<TargetedDeliveryOutcome> {
    // The kernel turns a card or poll into text before it gets here, because
    // none is declared. One that arrives anyway is refused, not half posted.
    if (message.poll || message.card) {
      return unreachable('channel_error', 'the Telegram channel declares no poll and no card — nothing was posted');
    }
    try {
      const messageId = await this.deps.emitter.sendPosted(chatId, {
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
      });
      return {
        outcome: 'delivered',
        // the Telegram message_id: what a reply to the message points at
        ...(messageId !== undefined ? { messageId: String(messageId) } : {}),
        conversationId: String(chatId),
      };
    } catch (err) {
      return classifyPostError(err, isDirect);
    }
  }

  async react(chatId: number, messageId: number, emoji: string): Promise<ConversationReactionOutcome> {
    try {
      await this.deps.api.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      });
      return { outcome: 'reacted' };
    } catch (err) {
      // message gone, reaction not allowed in this chat, rate limit: the
      // platform's own words, never thrown
      return unreachable('channel_error', err instanceof Error ? err.message : String(err));
    }
  }
}

/** A Bot API `message_id`: a positive integer. */
function parseMessageId(raw: string): number | undefined {
  const bare = raw.trim();
  return /^\d+$/.test(bare) && Number(bare) > 0 ? Number(bare) : undefined;
}

/** Post INTO a conversation (a group or the bot's own chat with a person). */
export function createTelegramConversationSend(lookup: TelegramBotLookup): ConversationSendProvider {
  return {
    channelType: TELEGRAM_SEND_CHANNEL_TYPE,
    supports: TELEGRAM_CONVERSATION_SEND_CAPABILITIES,
    async sendToConversation(conversationId, message, opts) {
      const poster = posterFor(lookup, opts?.asChannelKey);
      if (!(poster instanceof TelegramPoster)) return poster;
      const chatId = parseChatId(conversationId);
      if (chatId === undefined) return unreachable('no_binding', `'${conversationId}' is not a Telegram chat id`);
      const blocked = await poster.canPostTo(chatId);
      if (blocked) return blocked;
      return poster.post(chatId, message, chatId > 0);
    },
    async react(conversationId, messageId, reaction, opts) {
      // as exactly the bot the key names: the key is required here, so no
      // key never falls back to the installation's own bot
      const poster = posterFor(lookup, opts.asChannelKey);
      if (!(poster instanceof TelegramPoster)) return poster;
      const chatId = parseChatId(conversationId);
      if (chatId === undefined) return unreachable('no_binding', `'${conversationId}' is not a Telegram chat id`);
      const telegramMessageId = parseMessageId(messageId);
      if (telegramMessageId === undefined) {
        return unreachable('no_binding', `'${messageId}' is not a Telegram message id`);
      }
      const emoji = TELEGRAM_REACTION_EMOJI[reaction] as string | undefined;
      if (emoji === undefined) return unreachable('channel_error', `Telegram has no form for the reaction '${String(reaction)}'`);
      const blocked = await poster.canPostTo(chatId);
      if (blocked) return blocked;
      return poster.react(chatId, telegramMessageId, emoji);
    },
  };
}

/** DM one already-resolved person. */
export function createTelegramTargetedSend(lookup: TelegramBotLookup): TargetedSendProvider {
  return {
    channelType: TELEGRAM_SEND_CHANNEL_TYPE,
    supports: TELEGRAM_SEND_CAPABILITIES,
    async sendToUser(target, message, opts) {
      const poster = posterFor(lookup, opts?.asChannelKey);
      if (!(poster instanceof TelegramPoster)) return poster;
      const chatId =
        target.userRef?.kind === 'telegram-chat' ? parseChatId(target.userRef.id) : chatIdOfPrincipal(target.principalId);
      if (chatId === undefined || chatId < 0) {
        return unreachable('user_not_found', `'${target.principalId}' is not a Telegram user this bot can message`);
      }
      const blocked = await poster.canPostTo(chatId);
      if (blocked) return blocked;
      return poster.post(chatId, message, true);
    },
  };
}
