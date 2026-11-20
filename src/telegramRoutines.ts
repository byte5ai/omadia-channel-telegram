/**
 * Triggers and routines on Telegram (spec 2042 §5.12, §5.3).
 *
 * Two halves of one delivery path:
 *
 *  - Every turn opens the kernel's routines scope (`beginRoutineTurn`): who
 *    the person is and where a later delivery goes. Only then does the
 *    kernel offer the agent its trigger tools and `manage_routine`. The
 *    delivery ref names the conversation and, on an agent's own bot, that
 *    bot (`asChannelKey`, `tg:<botId>`).
 *  - The proactive send (`publishProactiveSend('telegram', …)`) delivers a
 *    trigger's or routine's message through exactly the bot the ref names:
 *    an agent's own bot without a name line, the installation's own bot with
 *    one (from the message's speaker). A bot that no longer runs here is an
 *    error, never a substitute. The kernel delivers a ref that names a bot
 *    only while that bot is still the agent's.
 */

import { isNoReply } from '@omadia/channel-sdk';
import type { RoutinesIntegration, RoutineTurnRunner } from '@omadia/plugin-api';

import { blockedReason, parseChatId, type TelegramBotLookup } from './telegramSend.js';

export const TELEGRAM_ROUTINE_CHANNEL = 'telegram';

/** The kernel's routines surface (`routinesIntegration@1`, optional_requires). */
export const ROUTINES_INTEGRATION_SERVICE = 'routinesIntegration';

type ProactiveSend = Parameters<RoutinesIntegration['publishProactiveSend']>[1];

/** The delivery ref a Telegram turn files: the generic channel shape. */
export interface TelegramDeliveryRef {
  readonly kind: 'channel';
  readonly channelId: string;
  readonly conversationId: string;
  /** The agent's own bot the conversation runs through; absent = the installation's bot. */
  readonly asChannelKey?: string;
}

/** Opens one turn's routines scope; the runner wraps the turn body. */
export type TelegramRoutineTurn = (info: { readonly userId: string; readonly chatId: number }) => RoutineTurnRunner;

export function createTelegramRoutineTurn(
  routines: Pick<RoutinesIntegration, 'beginRoutineTurn'>,
  channelId: string,
  asChannelKey: string | undefined,
): TelegramRoutineTurn {
  return ({ userId, chatId }) => {
    const conversationRef: TelegramDeliveryRef = {
      kind: 'channel',
      channelId,
      conversationId: String(chatId),
      ...(asChannelKey ? { asChannelKey } : {}),
    };
    // Triggers and routines only: a group or an agent's bot is not where the
    // person's Conductor reminders go (`conductorBinding: false`).
    return routines.beginRoutineTurn({ userId, channel: TELEGRAM_ROUTINE_CHANNEL, conversationRef, conductorBinding: false });
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The chat and bot of a delivery ref, or undefined when it is not one of ours. */
export function parseDeliveryRef(ref: unknown): { chatId: number; asChannelKey: string | undefined } | undefined {
  if (!isRecord(ref) || typeof ref['conversationId'] !== 'string') return undefined;
  const chatId = parseChatId(ref['conversationId']);
  if (chatId === undefined) return undefined;
  const raw = ref['asChannelKey'];
  const asChannelKey = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : undefined;
  return { chatId, asChannelKey };
}

export function createTelegramProactiveSend(lookup: TelegramBotLookup): ProactiveSend {
  return async (conversationRef, message) => {
    const ref = parseDeliveryRef(conversationRef);
    if (!ref) throw new Error('not a Telegram delivery: the ref names no Telegram chat');
    const bot = lookup(ref.asChannelKey);
    if (!bot || (ref.asChannelKey !== undefined && bot.botKey !== ref.asChannelKey)) {
      throw new Error(`no Telegram bot '${ref.asChannelKey ?? 'default'}' runs in this installation; nothing was sent`);
    }
    // "Nothing to report this run": dropped, the run history keeps the turn.
    if (isNoReply(message)) return;
    const blocked = await blockedReason(bot, ref.chatId);
    if (blocked) throw new Error(blocked.message);
    if (message.speaker?.kind === 'agent') {
      await bot.emitter.sendAnswer(ref.chatId, { text: message.text, speaker: message.speaker });
      return;
    }
    // Kernel texts (an approval request, a reminder) name no agent.
    await bot.emitter.sendSystem(ref.chatId, message.text);
  };
}
