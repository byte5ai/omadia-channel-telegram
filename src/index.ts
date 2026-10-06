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
  telegramTurnOrigin,
  type TelegramBotOptions,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramUser,
  type TelegramChat,
  type TelegramCallbackQuery,
} from './telegramBot.js';

export {
  TelegramRenderer,
  escapeMarkdownV2,
  type PendingCallback,
} from './telegramRenderer.js';

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
