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
 *  - `poll` (conversation send only, #8): a native, non-anonymous Telegram
 *    poll (`sendPoll`) after the message text, so the hint for a written
 *    ballot stays readable. Single choice unless the kernel's poll says
 *    `multipleAnswers` (an approval vote). Votes come back as `card_answer`
 *    events (`poll_answer`, conversationMessages.ts). An invalid poll is
 *    refused and nothing is posted. A poll Telegram refuses after the text
 *    went out is replaced by the options as text, which take written ballots.
 *    A new poll for the same step (a runoff round) stops the older one first.
 *  - no `card`: Telegram shows none. The KERNEL then posts the question itself
 *    as numbered text (`renderCardAsText`), keeps it open and turns a typed
 *    reply into the typed `card_answer` event. This plugin has no card code.
 *    For that the plugin reports the Telegram `message_id` of the posted
 *    message as `messageId` (the question a reply points at) and, in its
 *    `created` events, `replyToMessageId` and `addressedToBot`.
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
import {
  TELEGRAM_POLL_OPTIONS_MAX,
  TELEGRAM_POLL_OPTIONS_MIN,
  TELEGRAM_POLL_OPTION_MAX,
  TELEGRAM_POLL_QUESTION_MAX,
  clip,
  supersedes,
  type TelegramPollStore,
} from './telegramPolls.js';

export const TELEGRAM_SEND_CHANNEL_TYPE = 'telegram';

/** What the targeted send declares: the own identity, nothing else. */
export const TELEGRAM_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({ asChannelKey: true });

/** What the conversation send declares: the own identity, reactions and native polls. */
export const TELEGRAM_CONVERSATION_SEND_CAPABILITIES: SendProviderCapabilities = Object.freeze({
  asChannelKey: true,
  reactions: true,
  poll: true,
});

/** The platform form of each kernel reaction: Telegram's thumbs-up. */
export const TELEGRAM_REACTION_EMOJI: Readonly<Record<ConversationReaction, string>> = Object.freeze({
  acknowledge: '👍',
});

/** One bot the providers can post as. */
export interface TelegramSendDeps {
  readonly emitter: Pick<TelegramEmitter, 'sendPosted' | 'sendAnswer' | 'sendSystem'>;
  /** This bot's Bot API client, for what is not a message (reactions, polls). */
  readonly api: Pick<TelegramApiClient, 'setMessageReaction'> &
    Partial<Pick<TelegramApiClient, 'sendPoll' | 'stopPoll'>>;
  /** Where this bot remembers its polls, so a vote maps back to the kernel's ids. Absent = no polls. */
  readonly polls?: Pick<TelegramPollStore, 'remember' | 'openInChat' | 'forget'>;
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

  async post(
    chatId: number,
    message: TargetedMessage,
    isDirect: boolean,
    allowPoll = false,
  ): Promise<TargetedDeliveryOutcome> {
    // The kernel turns a card into text before it gets here, because none is
    // declared; a poll only the conversation send declares. One that arrives
    // anyway is refused, not half posted.
    if (message.card || (message.poll && !allowPoll)) {
      return unreachable('channel_error', 'this Telegram send declares no card and no poll — nothing was posted');
    }
    if (message.poll) return this.postPoll(chatId, message, message.poll);
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

  /**
   * The text (with the hint for a written ballot), then the native poll. An
   * older open poll of the same step is stopped first. When Telegram refuses
   * the poll, the options follow as text so the hint does not point at a
   * poll nobody can see; the send is then delivered without `cardMessageId`.
   */
  private async postPoll(
    chatId: number,
    message: TargetedMessage,
    poll: NonNullable<TargetedMessage['poll']>,
  ): Promise<TargetedDeliveryOutcome> {
    const { polls } = this.deps;
    const sendPoll = this.deps.api.sendPoll?.bind(this.deps.api);
    if (!polls || !sendPoll) return unreachable('channel_error', 'this Telegram bot cannot post polls — nothing was posted');
    const refusal = pollRefusal(poll);
    if (refusal) return unreachable('channel_error', `${refusal} — nothing was posted`);
    const isDirect = chatId > 0;
    let textId: number | undefined;
    try {
      textId = await this.deps.emitter.sendPosted(chatId, {
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
      });
    } catch (err) {
      return classifyPostError(err, isDirect);
    }
    await this.stopSuperseded(chatId, poll.pollId);
    const multipleAnswers = isMultipleAnswers(poll);
    try {
      const posted = await sendPoll({
        chat_id: chatId,
        question: clip(poll.question, TELEGRAM_POLL_QUESTION_MAX),
        options: poll.options.map((o) => ({ text: clip(o.label, TELEGRAM_POLL_OPTION_MAX) })),
        // Only a non-anonymous poll reports who voted.
        is_anonymous: false,
        allows_multiple_answers: multipleAnswers,
      });
      if (posted.poll?.id) {
        await polls.remember({
          telegramPollId: posted.poll.id,
          pollId: poll.pollId,
          chatId,
          messageId: posted.message_id,
          optionIds: poll.options.map((o) => o.id),
          postedAt: new Date().toISOString(),
          ...(multipleAnswers ? { multipleAnswers: true } : {}),
        });
      } else {
        console.warn(`[telegram] sendPoll for ${poll.pollId} returned no poll id — its votes cannot be reported`);
      }
      return {
        outcome: 'delivered',
        messageId: String(textId ?? posted.message_id),
        cardMessageId: String(posted.message_id),
        conversationId: String(chatId),
      };
    } catch (err) {
      console.warn(
        `[telegram] sendPoll for ${poll.pollId} in chat ${String(chatId)} failed: ${errorMessage(err)} — the options follow as text`,
      );
      await this.postOptionsAsText(chatId, poll);
      return {
        outcome: 'delivered',
        ...(textId !== undefined ? { messageId: String(textId) } : {}),
        conversationId: String(chatId),
      };
    }
  }

  /**
   * Stop this chat's open polls for the same step (an earlier round): their
   * votes would no longer count. Best-effort: a failure is logged, never fails
   * the send, and the old record is dropped either way.
   */
  private async stopSuperseded(chatId: number, pollId: string): Promise<void> {
    const { polls } = this.deps;
    if (!polls) return;
    let open: Awaited<ReturnType<typeof polls.openInChat>>;
    try {
      open = (await polls.openInChat(chatId)).filter((p) => supersedes(pollId, p.pollId));
    } catch (err) {
      console.warn(`[telegram] open polls of chat ${String(chatId)} unreadable: ${errorMessage(err)}`);
      return;
    }
    for (const old of open) {
      try {
        if (!this.deps.api.stopPoll) throw new Error('this client cannot stop polls');
        await this.deps.api.stopPoll({ chat_id: chatId, message_id: old.messageId });
        console.log(`[telegram] poll ${old.pollId} stopped: replaced by ${pollId} in chat ${String(chatId)}`);
      } catch (err) {
        console.warn(`[telegram] poll ${old.pollId} in chat ${String(chatId)} not stopped: ${errorMessage(err)}`);
      }
      await polls.forget(old);
    }
  }

  /** The options as text, for written ballots, when the native poll did not go out. */
  private async postOptionsAsText(chatId: number, poll: NonNullable<TargetedMessage['poll']>): Promise<void> {
    try {
      await this.deps.emitter.sendPosted(chatId, { text: optionsAsText(poll) });
    } catch (err) {
      console.warn(`[telegram] options of ${poll.pollId} not posted as text either: ${errorMessage(err)}`);
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

/**
 * Several options may be chosen (an approval vote). Read structurally: the
 * field is in `TargetedPoll` only since plugin-api 1.84.0 / channel-sdk 0.3.10
 * (omadia#2155); an older kernel never sets it and every poll stays single
 * choice.
 */
export function isMultipleAnswers(poll: NonNullable<TargetedMessage['poll']>): boolean {
  return (poll as { readonly multipleAnswers?: unknown }).multipleAnswers === true;
}

/** The question and each option with its id, the form a written ballot names. */
export function optionsAsText(poll: NonNullable<TargetedMessage['poll']>): string {
  return [`✍️ ${poll.question.trim()}`, ...poll.options.map((o) => `${o.id} — ${o.label.trim()}`)].join('\n');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why Telegram cannot show this poll, or undefined. Labels are clipped, not refused. */
function pollRefusal(poll: NonNullable<TargetedMessage['poll']>): string | undefined {
  const count = poll.options.length;
  if (count < TELEGRAM_POLL_OPTIONS_MIN || count > TELEGRAM_POLL_OPTIONS_MAX) {
    return `a Telegram poll takes ${String(TELEGRAM_POLL_OPTIONS_MIN)} to ${String(TELEGRAM_POLL_OPTIONS_MAX)} options, not ${String(count)}`;
  }
  if (new Set(poll.options.map((o) => o.id)).size !== count) return 'the poll option ids are not unique';
  if (poll.question.trim() === '' || poll.options.some((o) => o.label.trim() === '')) {
    return 'a poll needs a question and a label for every option';
  }
  return undefined;
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
      return poster.post(chatId, message, chatId > 0, true);
    },
    async react(conversationId, messageId, reaction, opts) {
      // As exactly the bot the key names. The key is required: a missing one
      // never falls back to the installation's own bot.
      const key = opts?.asChannelKey;
      if (typeof key !== 'string' || key.trim() === '') {
        return unreachable('not_permitted', 'a reaction needs the identity it is set as (asChannelKey); nothing was set');
      }
      const poster = posterFor(lookup, key);
      if (!(poster instanceof TelegramPoster)) return poster;
      const chatId = parseChatId(conversationId);
      if (chatId === undefined) return unreachable('no_binding', `'${conversationId}' is not a Telegram chat id`);
      const telegramMessageId = parseMessageId(messageId);
      if (telegramMessageId === undefined) {
        return unreachable('no_binding', `'${messageId}' is not a Telegram message id`);
      }
      const emoji = Object.hasOwn(TELEGRAM_REACTION_EMOJI, reaction) ? (TELEGRAM_REACTION_EMOJI[reaction] as string) : undefined;
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
