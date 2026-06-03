/**
 * Telegram channel plugin entry point. Implements the SDK's
 * `ChannelPlugin.activate(ctx, core)` contract — instantiates the Bot API
 * client, mounts the webhook router, and (when configured) registers the
 * webhook URL with Telegram. Falls back to long-polling getUpdates when the
 * webhook URL is missing — useful for local dev without ngrok.
 *
 * Self-contained: no `depends_on` integration. Bot token + webhook secret
 * live in the plugin's own vault entry; webhook public base URL lives in
 * the registry config.
 *
 * Phase 5B: standalone activate() shape — no constructor, no Deps
 * interface. Every kernel-side resource is sourced from `ctx.services`
 * (turnContext, memoryStore) or constructed in-package
 * (InMemoryConversationHistoryStore). This is the contract the plugin-
 * store flow needs: the resolver dynamic-imports `dist/plugin.js` and
 * calls `activate(ctx, core)` directly with no knowledge of plugin-
 * specific Deps shapes.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';
import type { PluginContext, MemoryStore } from '@omadia/plugin-api';
import {
  CHANNEL_RESOLVER_SERVICE,
  InMemoryConversationHistoryStore,
  type ChannelBindingResolver,
  type ChannelHandle,
  type CoreApi,
} from '@omadia/channel-sdk';
import type { ChatAgentBundle } from '@omadia/orchestrator';

import type { TurnContextModule } from './kernel-types.js';
import { createTelegramAdminRouter } from './adminRouter.js';
import { parseDmPolicy, type DmPolicy } from './dmPolicyGuard.js';
import { createTelegramWebhookRouter } from './messagesRouter.js';
import { PairingStore } from './pairingStore.js';
import { PairingTokenRegistry } from './pairingTokens.js';
import { TelegramRosterProvider } from './telegramRoster.js';
import {
  TelegramApiClient,
  TelegramBot,
  type TelegramUpdate,
} from './telegramBot.js';

const WEBHOOK_PATH_PREFIX = '/api/telegram';
const LONG_POLL_TIMEOUT_S = 25;
const LONG_POLL_BACKOFF_MS = 5_000;

export async function activate(
  ctx: PluginContext,
  core: CoreApi,
): Promise<ChannelHandle> {
  // chatAgent — late-resolved via capability registry (S+10-4b). Manifest
  // declares `requires: ["chatAgent@^1"]`, so the resolver guards activation
  // order. The undefined-check is a defensive type-narrow guard.
  const chatAgentBundle = ctx.services.get<ChatAgentBundle>('chatAgent');
  if (!chatAgentBundle) {
    throw new Error(
      'chatAgent@^1 capability not resolved — manifest declares it as required but ServicesAccessor returned undefined. Check that the harness-orchestrator plugin published the capability before channel activation.',
    );
  }
  const chatAgent = chatAgentBundle.agent;

  // Phase 5B: kernel-published deps (turnContext, memoryStore) sourced
  // via ctx.services. The kernel publishes 'turnContext' early in main()
  // (its AsyncLocalStorage namespace must be the SAME instance the
  // orchestrator plugin uses); 'memoryStore' is published by the
  // @omadia/memory plugin during tool-runtime activation.
  const turnContext = ctx.services.get<TurnContextModule>('turnContext');
  if (!turnContext) {
    throw new Error(
      'turnContext service not published — kernel must publish it before channel activation (see middleware/src/index.ts).',
    );
  }
  const memoryStore = ctx.services.get<MemoryStore>('memoryStore');
  if (!memoryStore) {
    throw new Error(
      "memoryStore service not published — @omadia/memory must be active before this channel (declare 'memoryStore@1' in requires).",
    );
  }
  const krokiBaseUrl = process.env['KROKI_BASE_URL'];

  // Per-channel in-memory history. Channel-prefixed scopes (`telegram:<id>`)
  // make sharing safe in principle, but per-channel instances mean a
  // history wipe on one channel never touches another's state.
  const conversationHistoryStore = new InMemoryConversationHistoryStore();

  const botToken = await ctx.secrets.require('telegram_bot_token');
  const webhookSecret = await ctx.secrets.require(
    'telegram_webhook_secret',
  );
  const publicBaseUrl = ctx.config.get<string>('telegram_public_base_url');
  // dmPolicy is the default-pairing safety knob (S+7.6).
  //
  // Fallback semantics: 'open' for backward-compat. Pre-S+7.6 installs
  // have no dm_policy field in their registry config; reading absent →
  // 'open' preserves the original behaviour ("anyone with the bot
  // username can DM"). New installs after S+7.6 get an explicit
  // dm_policy='pairing' written by bootstrapTelegramFromEnv on first
  // boot, so this fallback only matters for legacy entries.
  const dmPolicy: DmPolicy = parseDmPolicy(
    ctx.config.get<string>('dm_policy'),
    'open',
  );
  core.log('info', `telegram dm policy = ${dmPolicy}`);

  const api = new TelegramApiClient(botToken);
  const me = await api.getMe();
  core.log(
    'info',
    `Telegram bot identity: @${me.username ?? '<unknown>'} (id=${String(me.id)})`,
  );

  const rosterProvider = new TelegramRosterProvider(api);
  core.log('info', 'telegram roster provider ready (ttl=5min)');

  // Pairing infrastructure (S+7.6) — token registry is in-memory ephemeral
  // (120s TTL, single-use), pairing store is backed by the memoryStore
  // capability for persistent telegram_user_id → harness_identity bindings.
  const pairingTokens = new PairingTokenRegistry();
  const pairingStore = new PairingStore(memoryStore);
  core.log('info', 'telegram pairing store ready (memoryStore-backed)');

  // --- Per-turn Agent resolution (US7) ---------------------------------
  // Late-resolved channelResolver@1: when the multi-orchestrator registry is
  // active AND the operator bound this Telegram bot (or a specific chat) to an
  // Agent in /operator/channels, each inbound turn routes to that scoped
  // Agent. Without the resolver service the bot falls back to the default
  // chatAgent@1 (the `chatAgent` constant captured above).
  const channelResolver = ctx.services.get<ChannelBindingResolver>(
    CHANNEL_RESOLVER_SERVICE,
  );
  const resolveChatAgentForActivity = channelResolver
    ? (input: { channelType: 'telegram'; channelKey: string }) =>
        channelResolver.resolve(input.channelType, input.channelKey)
    : undefined;
  core.log(
    'info',
    resolveChatAgentForActivity
      ? 'Telegram per-turn Agent resolution active via channelResolver@1'
      : 'channelResolver@1 not published — Telegram routes all turns to default chatAgent',
  );

  const bot = new TelegramBot({
    api,
    chatAgent,
    ...(resolveChatAgentForActivity ? { resolveChatAgentForActivity } : {}),
    history: conversationHistoryStore,
    turnContext,
    rosterProvider: (chatId) => rosterProvider.forChat(chatId),
    pairingStore,
    pairingTokens,
    dmPolicy,
    // S+7.7+: identity drives the in-group mention/reply filter (so the
    // bot only answers when explicitly addressed once privacy-mode is
    // off). Requires bot username — when empty, fall back to id-only
    // matching via text_mention entities + reply detection.
    botIdentity: { id: me.id, username: me.username ?? '' },
  });

  // Mount the webhook router unconditionally — even when running in LP
  // mode, a future operator update can flip TELEGRAM_PUBLIC_BASE_URL +
  // re-activate without restart.
  const router = createTelegramWebhookRouter({ bot, webhookSecret });
  core.registerRouter(ctx.agentId, WEBHOOK_PATH_PREFIX, router);
  core.log(
    'info',
    `Telegram webhook router mounted at ${WEBHOOK_PATH_PREFIX}/webhook`,
  );

  // Webhook vs. long-polling decision
  let lpHandle: { stop(): void } | undefined;
  if (publicBaseUrl) {
    const webhookUrl = joinUrl(publicBaseUrl, `${WEBHOOK_PATH_PREFIX}/webhook`);
    try {
      await api.setWebhook({
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        drop_pending_updates: false,
      });
      core.log(
        'info',
        `Telegram webhook registered: ${webhookUrl} (allowed=message,callback_query)`,
      );
    } catch (err) {
      core.log(
        'error',
        `setWebhook failed: ${err instanceof Error ? err.message : String(err)} — falling back to long-polling`,
      );
      lpHandle = startLongPolling(api, bot, core);
    }
  } else {
    core.log(
      'info',
      'telegram_public_base_url not set — using long-polling (getUpdates) for local dev',
    );
    // Defensive: clear any pre-existing webhook the bot might still have
    // registered from a previous environment, otherwise getUpdates returns
    // 409 Conflict.
    try {
      await api.deleteWebhook({ drop_pending_updates: false });
    } catch (err) {
      core.log(
        'warn',
        `deleteWebhook (defensive) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    lpHandle = startLongPolling(api, bot, core);
  }

  // Self-contained operator-admin surface (S+7.7). Plugin owns the
  // /api/telegram/admin/* routes itself — no kernel route file, no
  // ServiceRegistry capability. Auth via plugin-vault `telegram_admin_token`
  // (auto-generated by bootstrapTelegramFromEnv on first install). When
  // the token is missing OR the bot has no username (deeplinks impossible),
  // the admin router is NOT mounted and operator gets a clear log hint.
  const webhookMode: 'webhook' | 'long-poll' =
    lpHandle ? 'long-poll' : 'webhook';
  const adminToken = await ctx.secrets.get('telegram_admin_token');
  if (adminToken && me.username) {
    // Mount UI router FIRST (more specific prefix). Express's route
    // registry is first-match-wins per prefix; if the broader admin
    // router (`/api/telegram/admin`) registered first, every request
    // to `/api/telegram/admin/ui/...` would hit its bearer-auth gate
    // and 401 before reaching the static UI.
    const uiRouter = Router();
    const uiAssetsPath = join(
      dirname(fileURLToPath(import.meta.url)),
      'ui',
    );
    uiRouter.use(
      express.static(uiAssetsPath, {
        fallthrough: true,
        index: 'index.html',
        // S+7.7 fix: disable directory-redirect (301 to trailing slash)
        // which would surface to the browser as an absolute /api/...
        // Location, leaking out of the iframe's /bot-api proxy prefix
        // and triggering a Next 404 page. Manifest's admin_ui_path
        // points directly at index.html so this redirect would be
        // wrong anyway.
        redirect: false,
        // Long-term cache for static assets — cache-bust by file-name
        // changes if the UI ever splits into chunks.
        maxAge: '1h',
      }),
    );
    core.registerRouter(
      ctx.agentId,
      `${WEBHOOK_PATH_PREFIX}/admin/ui`,
      uiRouter,
    );
    core.log(
      'info',
      `Telegram admin UI mounted at ${WEBHOOK_PATH_PREFIX}/admin/ui/ (assets: ${uiAssetsPath})`,
    );

    const adminRouter = createTelegramAdminRouter({
      pairingStore,
      pairingTokens,
      identity: { username: me.username, id: me.id },
      adminToken,
      ...(krokiBaseUrl ? { krokiBaseUrl } : {}),
      webhookMode,
      dmPolicy,
    });
    core.registerRouter(
      ctx.agentId,
      `${WEBHOOK_PATH_PREFIX}/admin`,
      adminRouter,
    );
    core.log(
      'info',
      `Telegram admin router mounted at ${WEBHOOK_PATH_PREFIX}/admin/* (auth: bearer=telegram_admin_token, mode=${webhookMode}, qr=${krokiBaseUrl ? 'on' : 'off'})`,
    );
    core.log(
      'info',
      `telegram admin token: read once via vault (key=telegram_admin_token under plugin @omadia/channel-telegram); paste into the UI login at ${WEBHOOK_PATH_PREFIX}/admin/ui/`,
    );
  } else if (!adminToken) {
    core.log(
      'warn',
      'telegram_admin_token missing in vault — admin router NOT mounted. Set the secret via vault or re-run bootstrap to auto-generate.',
    );
  } else {
    core.log(
      'warn',
      'bot has no username (BotFather setup incomplete?) — admin router NOT mounted because pairing deeplinks would be malformed.',
    );
  }

  return {
    close: async () => {
      if (lpHandle) {
        lpHandle.stop();
        core.log('info', 'telegram long-polling stopped');
      }
      if (publicBaseUrl) {
        try {
          await api.deleteWebhook({ drop_pending_updates: false });
          core.log('info', 'telegram webhook removed');
        } catch (err) {
          core.log(
            'warn',
            `deleteWebhook on shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      core.log('info', 'Telegram channel closed (routes now 503)');
    },
  };
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}

function startLongPolling(
  api: TelegramApiClient,
  bot: TelegramBot,
  core: CoreApi,
): { stop(): void } {
  let stopped = false;
  let offset: number | undefined;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const updates: TelegramUpdate[] = await api.getUpdates({
          ...(offset !== undefined ? { offset } : {}),
          timeout: LONG_POLL_TIMEOUT_S,
          allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          // Fire-and-forget: don't let one slow turn block the polling loop.
          void bot.handleUpdate(update).catch((err: unknown) => {
            core.log(
              'error',
              `handleUpdate failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      } catch (err) {
        if (stopped) break;
        core.log(
          'warn',
          `long-poll cycle failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${String(LONG_POLL_BACKOFF_MS)}ms`,
        );
        await sleep(LONG_POLL_BACKOFF_MS);
      }
    }
  };

  void loop();
  core.log('info', `telegram long-polling active (timeout=${String(LONG_POLL_TIMEOUT_S)}s)`);
  return {
    stop: () => {
      stopped = true;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
