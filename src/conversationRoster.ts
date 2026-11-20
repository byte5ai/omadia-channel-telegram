/**
 * The Telegram conversation roster for the kernel (`ConversationRosterProvider`,
 * spec 2042 §5.11 audience floor, issue #7).
 *
 * The kernel asks "who is in this conversation?" before it lets an agent use
 * member-scoped memory or reach data a room may not see. The answer has to be
 * honest about how much Telegram let this bot read:
 *
 *  - a private chat is the person and the bot: `complete`;
 *  - a group is `complete` only when `TelegramRosterProvider` proved it (every
 *    tracked member verified present and, with the bot, equal to
 *    `getChatMemberCount`);
 *  - otherwise `partial` when some members are known (the administrators the
 *    Bot API lists, plus the members the bot has seen), because absence of a
 *    name proves nothing;
 *  - `unknown` when nobody could be read at all.
 *
 * A group the bot is not activated in is not resolved (`undefined`): the bot
 * stays invisible there and keeps no list of its members. Each bot (the
 * installation's own bot, every agent's own bot) has its own provider; a
 * request on behalf of another identity is answered with `undefined`, never
 * with this bot's view.
 */

import type {
  ConversationParticipant,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
  ConversationRosterStatus,
} from '@omadia/channel-sdk';

import type { ChatParticipant } from './kernel-types.js';
import type { PairingStore } from './pairingStore.js';
import type { RosterSnapshot, TelegramRosterProvider } from './telegramRoster.js';

const TELEGRAM_USER_KIND = 'telegram-chat';

export interface TelegramConversationRosterDeps {
  readonly roster: Pick<TelegramRosterProvider, 'audience' | 'invalidate'>;
  readonly pairingStore: Pick<PairingStore, 'getGroupActivation'>;
  readonly bot: { readonly id: number; readonly username: string };
  readonly now?: () => Date;
}

export class TelegramConversationRosterProvider implements ConversationRosterProvider {
  readonly channelType = 'telegram';

  constructor(private readonly deps: TelegramConversationRosterDeps) {}

  async getRoster(
    conversationId: string,
    opts?: ConversationRosterRequest,
  ): Promise<ConversationRoster | undefined> {
    if (opts?.asChannelKey !== undefined && !this.isOwnIdentity(opts.asChannelKey)) return undefined;
    const chatId = parseChatId(conversationId);
    if (chatId === undefined) return undefined;
    const self = this.self();

    // A positive chat id is a private chat: the person and this bot.
    if (chatId > 0) {
      return {
        conversationType: 'direct',
        participants: [{ userRef: { kind: TELEGRAM_USER_KIND, id: String(chatId) } }],
        self,
        partial: false,
        status: 'complete',
        readAt: this.nowIso(),
      };
    }

    if (!(await this.deps.pairingStore.getGroupActivation(chatId))) return undefined;
    if (opts?.fresh === true) this.deps.roster.invalidate(chatId);
    const snapshot = await this.deps.roster.audience(chatId);
    return this.groupRoster(snapshot, self);
  }

  private groupRoster(snapshot: RosterSnapshot, self: ConversationParticipant): ConversationRoster {
    const status = statusOf(snapshot);
    return {
      conversationType: 'group',
      participants: snapshot.participants.map(toParticipant),
      self,
      partial: status !== 'complete',
      status,
      readAt: snapshot.readAt ?? this.nowIso(),
      ...(status === 'complete' ? {} : { statusDetail: STATUS_DETAIL[status] }),
    };
  }

  private self(): ConversationParticipant {
    return {
      userRef: {
        kind: TELEGRAM_USER_KIND,
        id: String(this.deps.bot.id),
        ...(this.deps.bot.username ? { displayName: `@${this.deps.bot.username}` } : {}),
      },
      isBot: true,
    };
  }

  /** The bot key `tg:<botId>` (spec 2042 §5.3), the one form the kernel asks with. */
  private isOwnIdentity(channelKey: string): boolean {
    return channelKey.trim().toLowerCase() === `tg:${String(this.deps.bot.id)}`;
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

const STATUS_DETAIL: Readonly<Record<'partial' | 'unknown', string>> = {
  partial:
    'Telegram gives bots no member list: only the administrators and the members the bot has seen are known, and they could not be shown to add up to the chat’s member count.',
  unknown: 'Telegram returned no members this bot could read.',
};

function statusOf(snapshot: RosterSnapshot): ConversationRosterStatus {
  if (snapshot.complete) return 'complete';
  return snapshot.participants.length > 0 ? 'partial' : 'unknown';
}

function toParticipant(p: ChatParticipant): ConversationParticipant {
  const id = p.channelUserId.replace(/^telegram:/, '');
  return {
    userRef: { kind: TELEGRAM_USER_KIND, id, displayName: p.displayName },
    ...(p.kind === 'agent' ? { isBot: true } : {}),
    ...(p.userPrincipalName ? { userPrincipalName: p.userPrincipalName } : {}),
  };
}

/** `-100123` or `telegram:-100123`; anything else is not a Telegram chat. */
function parseChatId(conversationId: string): number | undefined {
  const raw = conversationId.replace(/^telegram:/, '').trim();
  if (!/^-?\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}
