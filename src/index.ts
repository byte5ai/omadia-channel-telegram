// ---------------------------------------------------------------------------
// @omadia/channel-telegram — barrel
// ---------------------------------------------------------------------------
// Second ChannelPlugin consumer of @omadia/channel-sdk (first: Teams).
// Self-contained: no depends_on chain. Bot token + webhook secret live in
// the plugin's own vault entry; webhook public base URL is plugin config.

export { TelegramChannelPlugin } from './plugin.js';
export type { TelegramChannelPluginDeps } from './plugin.js';

export {
  TelegramApiClient,
  TelegramBot,
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

export { TelegramRosterProvider } from './telegramRoster.js';

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
