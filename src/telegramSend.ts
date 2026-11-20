/**
 * What this plugin hands the kernel to post on an agent's behalf (spec 2042
 * criterion 30, byte5ai/omadia#2043): a conversation send (post INTO a chat)
 * and a targeted send (a DM to one person).
 *
 * The kernel takes no provider's word for granted: it sends as a named
 * identity, as a poll or as a card only to a provider that DECLARES it
 * (`supports`). What is declared here is what is done:
 *
 *  - `asChannelKey`: the provider posts as exactly the bot it runs, whose key
 *    is `@<bot_username>` (the SDK's Telegram key), or returns `unreachable`.
 *    It never posts as another identity. A Telegram installation is ONE bot,
 *    so only an agent whose identity IS this bot can post through it.
 *  - `card` / `poll`: Telegram renders neither, so both go out as numbered text
 *    (`renderCardAsText`) and come back as the typed answer a card would have
 *    carried (`parseCardReply`, see `TelegramBot.handleCardReply`). One question per
 *    card, and only kinds a typed reply can answer without ambiguity. No
 *    `update`: a posted text cannot be turned into a result card.
 *  - no `mentions` (the kernel then leaves the text plain), no `aiLabel`
 *    (the kernel puts the disclosure line into the text itself).
 *
 * Unreachability is RETURNED, never thrown.
 */

import { evaluateDmPolicy, type DmPolicy } from './dmPolicyGuard.js';
import type {
  ConversationSendProvider,
  SendProviderCapabilities,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendProvider,
} from '@omadia/channel-sdk';
import { renderCardAsText } from '@omadia/channel-sdk';
import type { CardQuestion, CardQuestionKind, QuestionCard } from '@omadia/plugin-api';

import { DEFAULT_OPEN_MS, type OpenCardStore } from './openCards.js';
import { isOwnBotKey } from './conversationMessages.js';
import type { PairingStore } from './pairingStore.js';
import type { TelegramEmitter } from './telegramEmitter.js';

export const TELEGRAM_SEND_CHANNEL_TYPE = 'telegram';

/** Kinds a typed reply answers unambiguously. `text` would swallow every message, `assignment` needs a member list. */
export const TELEGRAM_CARD_KINDS: readonly CardQuestionKind[] = Object.freeze([
  'single_choice',
  'multiple_choice',
  'ranking',
  'consent',
  'number',
  'date',
]);

/**
 * What the providers declare. Polls and cards need the inbound side that turns
 * a typed reply into a `card_answer` event; a kernel without it gets plain
 * text posts only, and the kernel falls back to a chat ballot.
 */
export function telegramSendCapabilities(canCollectAnswers: boolean): SendProviderCapabilities {
  return Object.freeze({
    asChannelKey: true,
    ...(canCollectAnswers
      ? { poll: true, card: Object.freeze({ kinds: TELEGRAM_CARD_KINDS, maxQuestions: 1, update: false }) }
      : {}),
  });
}

/** How a person is told to answer; appended to every posted question. */
export const ANSWER_HINT = 'Antworte direkt auf diese Nachricht.';

export interface TelegramSendDeps {
  readonly emitter: Pick<TelegramEmitter, 'sendPosted'>;
  readonly openCards: Pick<OpenCardStore, 'add'>;
  readonly pairingStore: PairingStore;
  readonly dmPolicy: DmPolicy;
  readonly botUsername: string;
  /** The inbound side that collects typed answers is wired (`conversationMessages`). */
  readonly canCollectAnswers: boolean;
  readonly now?: () => number;
}

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

/** The card a poll is posted as: one single-choice question. */
export function pollAsCard(poll: NonNullable<TargetedMessage['poll']>): QuestionCard {
  return {
    cardId: poll.pollId,
    title: poll.question,
    ...(poll.hint ? { intro: poll.hint } : {}),
    questions: [{ id: 'poll', kind: 'single_choice', label: 'Wähle eine Option:', options: poll.options }],
  };
}

function cardProblem(card: QuestionCard): string | undefined {
  if (card.questions.length !== 1) return `Telegram posts one question per card, this one has ${String(card.questions.length)}`;
  const question = card.questions[0] as CardQuestion;
  if (!TELEGRAM_CARD_KINDS.includes(question.kind)) return `Telegram answers no '${question.kind}' question by typed reply`;
  return undefined;
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

class TelegramPoster {
  constructor(private readonly deps: TelegramSendDeps) {}

  /** `undefined` = this bot may post as that identity. */
  identityRefusal(asChannelKey: string | undefined): Unreachable | undefined {
    if (asChannelKey === undefined || isOwnBotKey(asChannelKey, this.deps.botUsername)) return undefined;
    return unreachable(
      'not_permitted',
      `this Telegram installation is the bot @${this.deps.botUsername.replace(/^@/, '')}; it does not post as '${asChannelKey}'`,
    );
  }

  async canPostTo(chatId: number): Promise<Unreachable | undefined> {
    if (chatId < 0) {
      return (await this.deps.pairingStore.getGroupActivation(chatId))
        ? undefined
        : unreachable('not_permitted', `the bot is not activated in chat ${String(chatId)}`);
    }
    const decision = await evaluateDmPolicy({
      policy: this.deps.dmPolicy,
      telegramUserId: chatId,
      store: this.deps.pairingStore,
    });
    return decision.allow ? undefined : unreachable('not_permitted', `chat ${String(chatId)} may not DM the bot (policy ${this.deps.dmPolicy})`);
  }

  async post(chatId: number, message: TargetedMessage, isDirect: boolean): Promise<TargetedDeliveryOutcome> {
    if (message.poll && message.card) return unreachable('channel_error', 'a message is a poll or a question card, not both');
    const poll = message.poll;
    if (poll && (poll.options.length < 2 || poll.options.length > 6)) {
      return unreachable('channel_error', 'a poll has 2 to 6 options');
    }
    const card = message.card ?? (poll ? pollAsCard(poll) : undefined);
    if (card && !this.deps.canCollectAnswers) {
      return unreachable('channel_error', 'this kernel gives the Telegram channel no way to collect answers — nothing was posted');
    }
    const problem = card ? cardProblem(card) : undefined;
    if (problem) return unreachable('channel_error', `${problem} — nothing was posted`);

    const text = card
      ? [message.text.trim(), renderCardAsText(card), ANSWER_HINT].filter(Boolean).join('\n\n')
      : message.text;
    try {
      const messageId = await this.deps.emitter.sendPosted(chatId, {
        text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
      });
      if (card && messageId !== undefined) {
        const now = (this.deps.now ?? Date.now)();
        await this.deps.openCards.add({
          cardId: card.cardId,
          kind: poll ? 'poll' : 'card',
          chatId,
          messageId,
          question: card.questions[0] as CardQuestion,
          ...(card.proposalId !== undefined ? { proposalId: card.proposalId } : {}),
          ...(card.proposalVersion !== undefined ? { proposalVersion: card.proposalVersion } : {}),
          closesAt: card.closesAt ?? new Date(now + DEFAULT_OPEN_MS).toISOString(),
          changeable: card.changeable !== false,
        });
      }
      return {
        outcome: 'delivered',
        ...(messageId !== undefined ? { messageId: String(messageId) } : {}),
        ...(card && messageId !== undefined ? { cardMessageId: String(messageId) } : {}),
        conversationId: String(chatId),
      };
    } catch (err) {
      return classifyPostError(err, isDirect);
    }
  }
}

/** Post INTO a conversation (a group or the bot's own chat with a person). */
export function createTelegramConversationSend(deps: TelegramSendDeps): ConversationSendProvider {
  const poster = new TelegramPoster(deps);
  return {
    channelType: TELEGRAM_SEND_CHANNEL_TYPE,
    supports: telegramSendCapabilities(deps.canCollectAnswers),
    async sendToConversation(conversationId, message, opts) {
      const refusal = poster.identityRefusal(opts?.asChannelKey);
      if (refusal) return refusal;
      const chatId = parseChatId(conversationId);
      if (chatId === undefined) return unreachable('no_binding', `'${conversationId}' is not a Telegram chat id`);
      const blocked = await poster.canPostTo(chatId);
      if (blocked) return blocked;
      return poster.post(chatId, message, chatId > 0);
    },
  };
}

/** DM one already-resolved person. */
export function createTelegramTargetedSend(deps: TelegramSendDeps): TargetedSendProvider {
  const poster = new TelegramPoster(deps);
  return {
    channelType: TELEGRAM_SEND_CHANNEL_TYPE,
    supports: telegramSendCapabilities(deps.canCollectAnswers),
    async sendToUser(target, message, opts) {
      const refusal = poster.identityRefusal(opts?.asChannelKey);
      if (refusal) return refusal;
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
