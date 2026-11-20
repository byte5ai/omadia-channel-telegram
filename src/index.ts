// ---------------------------------------------------------------------------
// @omadia/channel-telegram — barrel
// ---------------------------------------------------------------------------
// Second ChannelPlugin consumer of @omadia/channel-sdk (first: Teams).
// Self-contained: no depends_on chain. Bot token + webhook secret live in
// the plugin's own vault entry; webhook public base URL is plugin config.

// Phase 5B: standalone activate() shape replaces the legacy class. The
// dynamic-channel-resolver picks `activate` off the module export
// (`mod.activate ?? mod.default?.activate ?? mod.default`).
export { activate } from './plugin.js';

export {
  TELEGRAM_CHANNEL_TYPE,
  TelegramApiClient,
  TelegramBot,
  TELEGRAM_PACE_PROFILE,
  telegramTurnOrigin,
  telegramUserRef,
  type TelegramBotOptions,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramUser,
  type TelegramChat,
  type TelegramCallbackQuery,
} from './telegramBot.js';

export {
  TELEGRAM_DECORATIONS,
  TELEGRAM_DECORATION_CHANNEL,
  TelegramEmitter,
  conversationKeyOf,
  failureNoticeText,
  type EmissionRecord,
  type TelegramEmitterOptions,
} from './telegramEmitter.js';

export { PendingReplyStore, pendingReplyKey } from './pendingReplies.js';
export { PersistentSpeakerHistoryStore } from './speakerHistory.js';
export { BOT_COMMANDS, registerBotCommands } from './botCommands.js';
export { resolveAgentForTurn, type AgentResolution, type ChannelRouteLookup } from './agentResolution.js';
export {
  TelegramConversationMessages,
  isOwnBotKey,
  telegramBotKey,
  type TelegramConversationMessageSink,
} from './conversationMessages.js';
export {
  TELEGRAM_SEND_CAPABILITIES,
  classifyPostError,
  createTelegramConversationSend,
  createTelegramTargetedSend,
  type TelegramSendDeps,
} from './telegramSend.js';
export {
  TelegramConversationRosterProvider,
  type TelegramConversationRosterDeps,
} from './conversationRoster.js';

export {
  createTelegramWebhookRouter,
  type TelegramRouterDeps,
} from './messagesRouter.js';

export {
  MAX_VERIFIED_MEMBERS,
  TelegramRosterProvider,
  type RosterSnapshot,
} from './telegramRoster.js';
export { GroupMemberTracker, type TrackedMember } from './groupMemberTracker.js';

export {
  evaluateDmPolicy,
  parseDmPolicy,
  type DmPolicy,
  type DmPolicyDecision,
} from './dmPolicyGuard.js';

export {
  PairingTokenRegistry,
  type PairingToken,
} from './pairingTokens.js';

export {
  PairingStore,
  type DmBinding,
  type GroupActivation,
} from './pairingStore.js';

export {
  createTelegramAdminRouter,
  type TelegramAdminRouterDeps,
} from './adminRouter.js';
