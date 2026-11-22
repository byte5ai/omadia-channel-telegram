/**
 * Readiness and the meeting source for native facilitators (#2043, #2091,
 * byte5ai/omadia-channel-telegram#8).
 *
 * Readiness: can the bot `asChannelKey` moderate this group: is it there, may
 * it read messages that do not mention it, can it post? The kernel refuses a
 * facilitation (and a linked session going live) until the answer is
 * `ready`, and the facilitator says in the chat what is missing, so every
 * message here is written for the people who have to fix it.
 *
 * Telegram facts this rests on (https://core.telegram.org/bots/features#privacy-mode):
 *  - with privacy mode ON a bot gets only commands, mentions, replies to it
 *    and service messages; an ADMINISTRATOR bot gets every message anyway;
 *  - privacy mode is a per-bot BotFather setting (`getMe` →
 *    `can_read_all_group_messages`), and it applies to a group only from the
 *    moment the bot is (re-)added after the change. The Bot API cannot tell
 *    whether that happened, so a non-admin bot with privacy off is reported
 *    ready with `verified: false` until it has read a message in the group
 *    that did not address it (which proves it gets every message);
 *  - the bot speaks only in groups a paired person activated it in.
 *
 * Meeting source: a Telegram group is a chat, never a meeting. It takes text
 * and native poll answers and gives text and native polls; without this
 * snapshot the kernel would report the text-only baseline and the
 * facilitator would never post a poll here.
 */

import type { ChannelReadinessProvider, MeetingSourceProvider } from '@omadia/channel-sdk';
import type { ChannelReadinessIssue, ChannelReadinessReport, SessionCapabilitySnapshot } from '@omadia/plugin-api';

import type { PairingStore } from './pairingStore.js';
import { TELEGRAM_CHANNEL_TYPE, type TelegramApiClient } from './telegramBot.js';
import { parseChatId } from './telegramSend.js';

/** One bot the checks can be asked for. */
export interface TelegramReadinessBot {
  readonly botId: number;
  readonly username: string;
  readonly api: Pick<TelegramApiClient, 'getMe' | 'getChatMember'>;
  readonly pairingStore: Pick<PairingStore, 'getGroupActivation'>;
  /**
   * Has this bot read a message in the group that did not address it? Only
   * a bot that gets every message does, so privacy off is then proven
   * (`verified` is not set to false). Absent = no such proof is kept.
   */
  hasReadUnaddressedMessage?(chatId: number): boolean;
}

/** The bot with exactly this key (`tg:<botId>`); no key = the installation's own bot. */
export type TelegramReadinessLookup = (channelKey: string | undefined) => TelegramReadinessBot | undefined;

const PRESENT_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);
const ADMIN_STATUSES = new Set(['creator', 'administrator']);

export function createTelegramReadinessProvider(lookup: TelegramReadinessLookup): ChannelReadinessProvider {
  return {
    channelType: TELEGRAM_CHANNEL_TYPE,
    check: (conversationId, opts) => checkReadiness(lookup, conversationId, opts.asChannelKey),
  };
}

async function checkReadiness(
  lookup: TelegramReadinessLookup,
  conversationId: string,
  asChannelKey: string,
): Promise<ChannelReadinessReport> {
  const bot = lookup(asChannelKey.trim().toLowerCase());
  if (!bot) return notReady('no_identity', `no Telegram bot '${asChannelKey}' runs in this installation`);
  const chatId = parseChatId(conversationId);
  if (chatId === undefined) return notReady('unsupported_conversation', `'${conversationId}' is not a Telegram chat id`);
  if (chatId > 0) {
    return notReady('unsupported_conversation', 'a private chat with the bot cannot be moderated; a facilitation runs in a group');
  }
  const name = bot.username ? `@${bot.username}` : `bot ${String(bot.botId)}`;
  let isActivated: boolean;
  try {
    isActivated = Boolean(await bot.pairingStore.getGroupActivation(chatId));
  } catch (err) {
    return notReady('graph_error', `whether ${name} is activated in this group could not be read: ${errorMessage(err)}`);
  }
  if (!isActivated) {
    return notReady(
      'app_not_installed',
      `${name} is not activated in this group: a person paired with omadia has to add ${name} to the group`,
    );
  }

  let member: Awaited<ReturnType<TelegramReadinessBot['api']['getChatMember']>>;
  try {
    member = await bot.api.getChatMember({ chat_id: chatId, user_id: bot.botId });
  } catch (err) {
    const message = errorMessage(err);
    if (/chat not found|kicked|not a member/i.test(message)) {
      return notReady('app_not_installed', `${name} is not a member of this group (${message})`);
    }
    return notReady('graph_error', `Telegram did not say whether ${name} is in this group: ${message}`);
  }
  const installed = PRESENT_STATUSES.has(member.status) && (member.status !== 'restricted' || member.is_member === true);
  if (!installed) return notReady('app_not_installed', `${name} is not a member of this group (status ${member.status})`);

  const isAdmin = ADMIN_STATUSES.has(member.status);
  const canPost = member.status !== 'restricted' || member.can_send_messages === true;
  let privacyOff = false;
  if (!isAdmin) {
    try {
      privacyOff = (await bot.api.getMe()).can_read_all_group_messages === true;
    } catch (err) {
      return {
        ...notReady('graph_error', `Telegram did not say whether ${name} may read all group messages: ${errorMessage(err)}`),
        installed: true,
        canPost,
      };
    }
  }
  const canReadAllMessages = isAdmin || privacyOff;
  const missing: ChannelReadinessIssue[] = [
    ...(canReadAllMessages
      ? []
      : [
          {
            code: 'consent_missing',
            message: `${name} has privacy mode on and is no administrator here, so Telegram hands it only messages that mention it or reply to it. Make ${name} an administrator of this group, or turn privacy mode off in @BotFather (/setprivacy → Disable) and then remove and re-add ${name} to the group.`,
          },
        ]),
    ...(canPost ? [] : [{ code: 'cannot_post', message: `${name} may not send messages in this group` }]),
  ];
  return {
    ready: missing.length === 0,
    installed: true,
    canReadAllMessages,
    canPost,
    missing,
    // Privacy off without admin rights: whether the bot was re-added after the
    // change cannot be read, so this is the absence of a known obstacle,
    // unless the bot already read a message here that did not address it.
    ...(!isAdmin && privacyOff && bot.hasReadUnaddressedMessage?.(chatId) !== true ? { verified: false } : {}),
  };
}

/** Chat inputs and outputs of an activated group: text and native polls. */
export function createTelegramMeetingSource(
  lookup: TelegramReadinessLookup,
  now: () => Date = () => new Date(),
): MeetingSourceProvider {
  return {
    channelType: TELEGRAM_CHANNEL_TYPE,
    async snapshot(conversationId, opts): Promise<SessionCapabilitySnapshot | undefined> {
      const bot = lookup(opts.asChannelKey?.trim().toLowerCase());
      const chatId = parseChatId(conversationId);
      if (!bot || chatId === undefined || chatId > 0) return undefined;
      try {
        if (!(await bot.pairingStore.getGroupActivation(chatId))) return undefined;
      } catch (err) {
        // No snapshot: the kernel keeps its text-only baseline until the next one.
        console.warn(`[telegram] activation of chat ${String(chatId)} unreadable, no capability snapshot: ${errorMessage(err)}`);
        return undefined;
      }
      return {
        channelType: TELEGRAM_CHANNEL_TYPE,
        conversationId,
        ...(opts.sessionRef !== undefined ? { sessionRef: opts.sessionRef } : {}),
        modality: 'chat',
        inputs: ['text', 'card_answers'],
        outputs: ['text', 'polls'],
        capturedAt: now().toISOString(),
      };
    },
  };
}

function notReady(code: string, message: string): ChannelReadinessReport {
  return { ready: false, installed: false, canReadAllMessages: false, canPost: false, missing: [{ code, message }] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
