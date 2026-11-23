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
  TELEGRAM_ALLOWED_UPDATES,
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
  type TelegramPollAnswer,
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
export { OwnPosts } from './ownPosts.js';
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
  TELEGRAM_CONVERSATION_SEND_CAPABILITIES,
  TELEGRAM_REACTION_EMOJI,
  TELEGRAM_SEND_CAPABILITIES,
  classifyPostError,
  createTelegramConversationSend,
  createTelegramTargetedSend,
  type TelegramBotLookup,
  type TelegramSendDeps,
} from './telegramSend.js';
export {
  TELEGRAM_ROUTINE_CHANNEL,
  createTelegramProactiveSend,
  createTelegramRoutineTurn,
  parseDeliveryRef,
  type TelegramDeliveryRef,
  type TelegramRoutineTurn,
} from './telegramRoutines.js';
export {
  TelegramConversationRosterProvider,
  type TelegramConversationRosterDeps,
} from './conversationRoster.js';

export {
  createTelegramAgentBotsRouter,
  createTelegramWebhookRouter,
  type TelegramRouterDeps,
} from './messagesRouter.js';
export {
  AGENT_BOT_FIELDS,
  AGENT_BOT_TOKEN_PREFIX,
  TelegramBotFleet,
  createTelegramAgentIdentityProvider,
  startStoredAgentBots,
  type AgentBotDeps,
  type AgentBotSecrets,
} from './agentBots.js';
export { agentBotWebhookSecret, type TelegramBotRuntime } from './botRuntime.js';

export {
  MAX_VERIFIED_MEMBERS,
  TelegramRosterProvider,
  type RosterSnapshot,
} from './telegramRoster.js';
export { GroupMemberTracker, type TrackedMember } from './groupMemberTracker.js';
export {
  MEMBERSHIP_DEDUPE_MS,
  TelegramMembershipEvents,
  type MembershipEventSink,
} from './membershipEvents.js';
export { TelegramPollStore, chosenOptionIds, type PostedPoll } from './telegramPolls.js';
export {
  createTelegramMeetingSource,
  createTelegramReadinessProvider,
  type TelegramReadinessBot,
  type TelegramReadinessLookup,
} from './telegramReadiness.js';

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
