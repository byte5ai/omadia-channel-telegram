/**
 * One running Telegram bot: the installation's own bot or an agent's own bot
 * (spec 2042 §5.3). Everything that belongs to ONE bot identity is built
 * here, once per bot: the Bot API client, the turn handler, the roster, the
 * group activations, the inbound message events, the poster, and the
 * transport (webhook or long-polling).
 *
 * Shared by every bot of the installation: the routing lookup, the DM
 * bindings (which Telegram user is which harness identity), the group member
 * tracker (who is in a chat), the speaker history and the pairing tokens.
 *
 * Per bot, deliberately: the group activations (a bot speaks only in groups a
 * paired person added THAT bot to), the plugin-local turn history (another
 * agent's answer is not this agent's previous turn), and the webhook secret.
 */

import { createHmac } from 'node:crypto';

import type { MemoryStore, RoutinesIntegration } from '@omadia/plugin-api';
import { InMemoryConversationHistoryStore, type ConversationMessageEvent, type CoreApi } from '@omadia/channel-sdk';

import type { ChannelRouteLookup } from './agentResolution.js';
import { TelegramConversationMessages, telegramBotKey } from './conversationMessages.js';
import { TelegramConversationRosterProvider } from './conversationRoster.js';
import type { DmPolicy } from './dmPolicyGuard.js';
import type { GroupMemberTracker } from './groupMemberTracker.js';
import type { ChatAgent, TurnContextModule } from './kernel-types.js';
import type { TelegramMembershipEvents } from './membershipEvents.js';
import { PairingStore } from './pairingStore.js';
import type { PairingTokenRegistry } from './pairingTokens.js';
import type { PersistentSpeakerHistoryStore } from './speakerHistory.js';
import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_CHANNEL_TYPE,
  TelegramApiClient,
  TelegramBot,
  type TelegramUpdate,
  type TelegramUser,
} from './telegramBot.js';
import { TelegramEmitter } from './telegramEmitter.js';
import { TelegramPollStore } from './telegramPolls.js';
import { createTelegramRoutineTurn } from './telegramRoutines.js';
import { TelegramRosterProvider } from './telegramRoster.js';
import type { TelegramSendDeps } from './telegramSend.js';

export const WEBHOOK_PATH_PREFIX = '/api/telegram';
/** Where an agent bot's webhook lands: `<prefix>/agent-bots/<botId>/webhook`. */
export const AGENT_BOTS_PATH = '/agent-bots';
const LONG_POLL_TIMEOUT_S = 25;
const LONG_POLL_BACKOFF_MS = 5_000;

/** What every bot of the installation shares. */
export interface SharedBotDeps {
  readonly core: CoreApi;
  /** The catalog id of this plugin (`ctx.agentId`). */
  readonly channelId: string;
  readonly chatAgent: ChatAgent;
  readonly turnContext: TurnContextModule;
  readonly memoryStore: MemoryStore;
  readonly channelRoute: ChannelRouteLookup;
  readonly dmPolicy: DmPolicy;
  readonly pairingStore: PairingStore;
  readonly pairingTokens: PairingTokenRegistry;
  readonly speakerHistory: PersistentSpeakerHistoryStore;
  readonly memberTracker: GroupMemberTracker;
  /** Joins and leaves for the kernel; one instance, so a change seen by several bots goes out once. */
  readonly membershipEvents?: TelegramMembershipEvents | undefined;
  /** The installation's webhook secret; agent bots derive theirs from it. */
  readonly webhookSecret: string;
  /** `undefined` = long-polling. */
  readonly publicBaseUrl: string | undefined;
  /** The kernel's routines surface; absent = no triggers or routines here. */
  readonly routines?: Pick<RoutinesIntegration, 'beginRoutineTurn'> | undefined;
}

export interface TelegramBotRuntime {
  readonly botId: number;
  /** `tg:<botId>`. */
  readonly botKey: string;
  readonly username: string;
  readonly agentBot: boolean;
  readonly api: TelegramApiClient;
  readonly bot: TelegramBot;
  readonly sendDeps: TelegramSendDeps;
  readonly roster: TelegramConversationRosterProvider;
  /** This bot's group activations (the installation's own, or the agent bot's). */
  readonly pairingStore: PairingStore;
  readonly webhookSecret: string;
  /** `webhook` or `long-poll`, once started. */
  mode(): 'webhook' | 'long-poll' | 'stopped';
  /** Register the webhook, or start long-polling. */
  start(): Promise<void>;
  /** Stop receiving updates (long-poll stop / webhook removal). */
  stop(): Promise<void>;
}

/** An agent bot's webhook secret: derived, so nothing more is stored. */
export function agentBotWebhookSecret(installationSecret: string, botId: number): string {
  return createHmac('sha256', installationSecret).update(`agent-bot:${String(botId)}`).digest('hex');
}

function webhookPath(agentBot: boolean, botId: number): string {
  return agentBot ? `${AGENT_BOTS_PATH}/${String(botId)}/webhook` : '/webhook';
}

export function createBotRuntime(
  shared: SharedBotDeps,
  api: TelegramApiClient,
  me: TelegramUser,
  options: { readonly agentBot: boolean },
): TelegramBotRuntime {
  const { core, agentBot } = { core: shared.core, agentBot: options.agentBot };
  const username = me.username ?? '';
  const botKey = telegramBotKey(me.id);
  const pairingStore = agentBot ? new PairingStore(shared.memoryStore, { agentBotId: me.id }) : shared.pairingStore;
  const rosterProvider = new TelegramRosterProvider(api, shared.memberTracker, me.id);
  const conversationMessages = conversationMessagesFor(shared, me.id);
  // Per bot: Telegram's poll ids are the sending bot's, and only it gets the votes.
  const polls = new TelegramPollStore(shared.memoryStore, me.id);
  const bot = new TelegramBot({
    api,
    chatAgent: shared.chatAgent,
    channelResolver: shared.channelRoute,
    ...(conversationMessages ? { conversationMessages } : {}),
    ...(shared.membershipEvents ? { membershipEvents: shared.membershipEvents } : {}),
    polls,
    history: new InMemoryConversationHistoryStore(),
    turnContext: shared.turnContext,
    rosterProvider: (chatId) => rosterProvider.forChat(chatId),
    memberTracker: shared.memberTracker,
    invalidateRoster: (chatId) => rosterProvider.invalidate(chatId),
    pairingStore,
    pairingTokens: shared.pairingTokens,
    speakerHistory: shared.speakerHistory,
    dmPolicy: shared.dmPolicy,
    botIdentity: { id: me.id, username },
    agentBot,
    // A delivery the agent sets here goes out through this bot later.
    ...(shared.routines
      ? { routineTurn: createTelegramRoutineTurn(shared.routines, shared.channelId, agentBot ? botKey : undefined) }
      : {}),
  });
  const sendDeps: TelegramSendDeps = {
    emitter: new TelegramEmitter({ api, speakerHistory: shared.speakerHistory, nativeIdentity: agentBot }),
    api,
    polls,
    pairingStore,
    dmPolicy: shared.dmPolicy,
    botKey,
  };
  const roster = new TelegramConversationRosterProvider({
    roster: rosterProvider,
    pairingStore,
    bot: { id: me.id, username },
  });
  const webhookSecret = agentBot ? agentBotWebhookSecret(shared.webhookSecret, me.id) : shared.webhookSecret;
  const label = `${agentBot ? 'agent bot' : 'bot'} @${username || '<unknown>'} (${botKey})`;
  let lp: { stop(): void } | undefined;
  let mode: 'webhook' | 'long-poll' | 'stopped' = 'stopped';

  return {
    botId: me.id,
    botKey,
    username,
    agentBot,
    api,
    bot,
    sendDeps,
    roster,
    pairingStore,
    webhookSecret,
    mode: () => mode,
    async start() {
      if (shared.publicBaseUrl) {
        const url = joinUrl(shared.publicBaseUrl, `${WEBHOOK_PATH_PREFIX}${webhookPath(agentBot, me.id)}`);
        try {
          await api.setWebhook({
            url,
            secret_token: webhookSecret,
            allowed_updates: TELEGRAM_ALLOWED_UPDATES,
            drop_pending_updates: false,
          });
          mode = 'webhook';
          core.log('info', `Telegram ${label} webhook registered: ${url}`);
          return;
        } catch (err) {
          core.log('error', `setWebhook for ${label} failed: ${errorMessage(err)} — falling back to long-polling`);
        }
      } else {
        // A webhook left from another environment makes getUpdates answer 409.
        await api.deleteWebhook({ drop_pending_updates: false }).catch((err: unknown) => {
          core.log('warn', `deleteWebhook (defensive) for ${label} failed: ${errorMessage(err)}`);
        });
      }
      lp = startLongPolling(api, bot, core, label);
      mode = 'long-poll';
    },
    async stop() {
      if (lp) {
        lp.stop();
        lp = undefined;
        core.log('info', `telegram long-polling stopped for ${label}`);
      }
      if (mode === 'webhook') {
        await api.deleteWebhook({ drop_pending_updates: false }).catch((err: unknown) => {
          core.log('warn', `deleteWebhook for ${label} failed: ${errorMessage(err)}`);
        });
      }
      mode = 'stopped';
    },
  };
}

/** Inbound message events, when the kernel offers them (feature-detected). */
function conversationMessagesFor(shared: SharedBotDeps, botId: number): TelegramConversationMessages | undefined {
  const { core, channelId } = shared;
  const emit = core.emitConversationMessage?.bind(core);
  const isAllMessagesSubscribed = core.isAllMessagesSubscribed?.bind(core);
  if (!emit || !isAllMessagesSubscribed) return undefined;
  const conversationDelivery = core.conversationDelivery?.bind(core);
  const report = core.reportConversationMessage?.bind(core);
  const stamp = (event: ConversationMessageEvent): ConversationMessageEvent => ({
    ...event,
    channelId,
    channelType: TELEGRAM_CHANNEL_TYPE,
  });
  return new TelegramConversationMessages(
    {
      isAllMessagesSubscribed: (conversationId, channelKey) =>
        isAllMessagesSubscribed(TELEGRAM_CHANNEL_TYPE, conversationId, channelKey),
      ...(conversationDelivery
        ? {
            conversationDelivery: (conversationId: string, channelKey: string) =>
              conversationDelivery(TELEGRAM_CHANNEL_TYPE, conversationId, channelKey),
          }
        : {}),
      emit: (event) => emit(stamp(event)),
      ...(report ? { report: (event: ConversationMessageEvent) => report(stamp(event)) } : {}),
    },
    botId,
  );
}

function startLongPolling(api: TelegramApiClient, bot: TelegramBot, core: CoreApi, label: string): { stop(): void } {
  let stopped = false;
  let offset: number | undefined;
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const updates: TelegramUpdate[] = await api.getUpdates({
          ...(offset !== undefined ? { offset } : {}),
          timeout: LONG_POLL_TIMEOUT_S,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          // Fire-and-forget: one slow turn must not block the polling loop.
          void bot.handleUpdate(update).catch((err: unknown) => {
            core.log('error', `handleUpdate (${label}) failed: ${errorMessage(err)}`);
          });
        }
      } catch (err) {
        if (stopped) break;
        core.log('warn', `long-poll cycle for ${label} failed: ${errorMessage(err)} — retrying in ${String(LONG_POLL_BACKOFF_MS)}ms`);
        await sleep(LONG_POLL_BACKOFF_MS);
      }
    }
  };
  void loop();
  core.log('info', `telegram long-polling active for ${label} (timeout=${String(LONG_POLL_TIMEOUT_S)}s)`);
  return {
    stop: () => {
      stopped = true;
    },
  };
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
