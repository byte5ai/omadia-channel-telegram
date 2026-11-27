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

import { randomBytes } from 'node:crypto';
import { ensureAdminToken } from './adminToken.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';
import type { PluginContext, MemoryStore, RoutinesIntegration } from '@omadia/plugin-api';
import { createTelegramProactiveSend, ROUTINES_INTEGRATION_SERVICE, TELEGRAM_ROUTINE_CHANNEL } from './telegramRoutines.js';
import {
  CHANNEL_RESOLVER_SERVICE,
  resolveChannelRoute,
  type ChannelHandle,
  type CoreApi,
} from '@omadia/channel-sdk';
import type { ChatAgentBundle } from '@omadia/orchestrator';

import type { TurnContextModule } from './kernel-types.js';
import { accountLinksOf } from './accountLinks.js';
import { createTelegramAdminRouter } from './adminRouter.js';
import {
  createTelegramAgentIdentityProvider,
  startStoredAgentBots,
  TelegramBotFleet,
  type AgentBotDeps,
} from './agentBots.js';
import {
  AGENT_BOTS_PATH,
  createBotRuntime,
  WEBHOOK_PATH_PREFIX,
  type SharedBotDeps,
} from './botRuntime.js';
import { parseDmPolicy, type DmPolicy } from './dmPolicyGuard.js';
import { parseSystemName } from './systemTexts.js';
import { createTelegramAgentBotsRouter, createTelegramWebhookRouter } from './messagesRouter.js';
import { PairingStore } from './pairingStore.js';
import { PairingTokenRegistry } from './pairingTokens.js';
import { GroupMemberTracker } from './groupMemberTracker.js';
import { registerBotCommands } from './botCommands.js';
import { PersistentSpeakerHistoryStore } from './speakerHistory.js';
import type { ChannelRouteLookup } from './agentResolution.js';
import { createTelegramConversationSend, createTelegramTargetedSend } from './telegramSend.js';
import { TELEGRAM_CHANNEL_TYPE, TelegramApiClient } from './telegramBot.js';
import { createTelegramChannelDirectory } from './channelKeyDirectory.js';
import type { ChannelKeyDirectory } from '@omadia/channel-sdk';

/** Kernel service that aggregates every channel's `ChannelKeyDirectory` (#2001). */
const CHANNEL_DIRECTORY_SERVICE = 'channelDirectoryRegistry';

/** The registry surface used here; the kernel class is not importable from a plugin. */
interface ChannelDirectoryRegistryLike {
  register(directory: ChannelKeyDirectory): void;
  unregister(channelType: string): void;
}
import { TelegramMembershipEvents } from './membershipEvents.js';
import { createTelegramMeetingSource, createTelegramReadinessProvider } from './telegramReadiness.js';

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
  // Triggers and routines (spec 2042 §5.12): published by the kernel only
  // with a database. Absent = agents cannot set triggers or routines here.
  const routines = ctx.services.get<RoutinesIntegration>(ROUTINES_INTEGRATION_SERVICE);
  const krokiBaseUrl = process.env['KROKI_BASE_URL'];

  const botToken = await ctx.secrets.require('telegram_bot_token');
  // Webhook secret guards the webhook endpoint — Telegram echoes it in the
  // X-Telegram-Bot-Api-Secret-Token header so the router can reject spoofed
  // calls. Unlike the bot token it is NOT issued externally (BotFather has
  // nothing to do with it); it's a purely internal shared secret. The env
  // bootstrap path seeds it from TELEGRAM_WEBHOOK_SECRET, but store-form
  // installs supply no value — so auto-generate and persist one on first
  // activation, mirroring the admin-token pattern in bootstrap. Needs
  // permissions.secrets.runtime_write in the manifest (gates ctx.secrets.set).
  let webhookSecret = await ctx.secrets.get('telegram_webhook_secret');
  if (!webhookSecret) {
    if (!ctx.secrets.set) {
      throw new Error(
        'telegram_webhook_secret is absent and ctx.secrets.set is unavailable — declare permissions.secrets.runtime_write in manifest.yaml so the channel can auto-generate one on first activation.',
      );
    }
    webhookSecret = randomBytes(32).toString('hex');
    await ctx.secrets.set('telegram_webhook_secret', webhookSecret);
    core.log(
      'info',
      'telegram_webhook_secret auto-generated and persisted to vault (first activation)',
    );
  }
  const publicBaseUrl = ctx.config.get<string>('telegram_public_base_url');
  // dmPolicy is the default-pairing safety knob (S+7.6). A missing, blank or
  // unknown value fails closed to 'pairing' (#1998): an install from before
  // the field existed, or a typo, never opens the bot to everyone.
  const dmPolicy: DmPolicy = parseDmPolicy(ctx.config.get<string>('dm_policy'), (raw) =>
    core.log('warn', `telegram dm_policy "${raw}" is not open, pairing or disabled; using pairing`),
  );
  core.log('info', `telegram dm policy = ${dmPolicy}`);

  const api = new TelegramApiClient(botToken);
  const me = await api.getMe();
  core.log(
    'info',
    `Telegram bot identity: @${me.username ?? '<unknown>'} (id=${String(me.id)})`,
  );

  // Shared by every bot of the installation (see botRuntime.ts): group
  // members seen, DM bindings, pairing tokens, who spoke where.
  const memberTracker = new GroupMemberTracker(memoryStore);
  const pairingTokens = new PairingTokenRegistry();
  // ADR-0225 — the kernel links a paired Telegram account to an omadia
  // account; an older kernel leaves pairing an allow-list.
  const accountLinks = accountLinksOf(core);
  core.log(
    'info',
    accountLinks
      ? 'telegram pairing links accounts through the kernel (channelIdentityLinks)'
      : 'kernel has no channelIdentityLinks — pairing only allows a Telegram account to chat',
  );
  const pairingStore = new PairingStore(memoryStore);
  const speakerHistory = new PersistentSpeakerHistoryStore(memoryStore);
  core.log('info', 'telegram pairing store ready (memoryStore-backed)');
  // Joins and leaves for the kernel (#330 B2, spec 2043 §5.5). One instance
  // for every bot: a change several bots see goes out once.
  const emitConversationEvent = core.emitConversationEvent?.bind(core);
  const membershipEvents = emitConversationEvent
    ? new TelegramMembershipEvents((event) => emitConversationEvent({ ...event, channelId: ctx.agentId }))
    : undefined;

  // --- Per-turn agent resolution (S1 contract) --------------------------
  // The SDK's `resolveChannelRoute` asks `channelResolver@1` on every turn:
  // `bound` (agent plus speaker) or `reject` (agent for `/agent`, plus the
  // notice). It returns `undefined` on a host without the registry, and only
  // then does a turn go to the default chatAgent@1. With a registry that
  // singleton is a refuser and is never a fallback.
  const channelRoute: ChannelRouteLookup = (channelType, channelKey, context) =>
    resolveChannelRoute(ctx, channelType, channelKey, context);
  core.log(
    'info',
    ctx.services.get(CHANNEL_RESOLVER_SERVICE)
      ? 'Telegram per-turn agent resolution active via channelResolver@1'
      : 'channelResolver@1 not published — Telegram routes all turns to the default chatAgent (host without registry)',
  );

  const shared: SharedBotDeps = {
    core,
    channelId: ctx.agentId,
    chatAgent,
    turnContext,
    memoryStore,
    channelRoute,
    dmPolicy,
    systemName: parseSystemName(ctx.config.get<string>('system_name')),
    pairingStore,
    pairingTokens,
    ...(accountLinks ? { accountLinks } : {}),
    speakerHistory,
    memberTracker,
    membershipEvents,
    webhookSecret,
    publicBaseUrl: publicBaseUrl || undefined,
    ...(routines ? { routines } : {}),
  };
  const defaultBot = createBotRuntime(shared, api, me, { agentBot: false });
  const fleet = new TelegramBotFleet(defaultBot);
  const bot = defaultBot.bot;

  // The room's membership for the kernel's audience floor (spec 2042 §5.11),
  // as the bot `asChannelKey` sees it. Feature-detected: older kernels have
  // no roster registry.
  if (typeof core.registerRosterProvider === 'function') {
    core.registerRosterProvider(ctx.agentId, fleet.rosterProvider());
    core.log('info', 'telegram conversation roster registered with the kernel');
  } else {
    core.log('info', 'kernel has no roster registry — conversation roster not registered');
  }

  // Native facilitators (#2043, issue #8): can the bot `asChannelKey` moderate
  // a group (activated, reads every message, may post), and what a group
  // offers (text and native polls). Without a readiness provider the kernel
  // refuses every facilitation on Telegram.
  const runtimeFor = (key: string | undefined) => fleet.runtimeFor(key);
  if (typeof core.registerReadinessProvider === 'function') {
    core.registerReadinessProvider(ctx.agentId, createTelegramReadinessProvider(runtimeFor));
  }
  core.registerMeetingSourceProvider?.(ctx.agentId, createTelegramMeetingSource(runtimeFor));
  core.log(
    'info',
    `native facilitators: readiness=${typeof core.registerReadinessProvider === 'function' ? 'on' : 'kernel<2043'}, meetingSource=${typeof core.registerMeetingSourceProvider === 'function' ? 'on' : 'kernel<2043'}, membershipEvents=${membershipEvents ? 'on' : 'kernel<B1'}`,
  );

  // Native "/" menu of the installation's own bot: /agent, /agents. The
  // agent behind the resolver carries them out; the channel passes the text
  // on unchanged. Agents' own bots get no menu: there is nothing to choose.
  await registerBotCommands(api, (level, message) => core.log(level, message));

  // --- Posting for agents and collecting answers (spec 2042 criterion 30) ---
  // Every send names the bot it goes out as (`asChannelKey` = `tg:<botId>`):
  // the installation's own bot or an agent's own bot, never a substitute.
  if (core.registerConversationSendProvider || core.registerTargetedSendProvider) {
    const lookup = (asChannelKey: string | undefined) => fleet.sendDepsFor(asChannelKey);
    core.registerConversationSendProvider?.(ctx.agentId, createTelegramConversationSend(lookup));
    core.registerTargetedSendProvider?.(ctx.agentId, createTelegramTargetedSend(lookup));
    core.log(
      'info',
      `telegram send providers registered (posts as ${defaultBot.botKey} or an agent's own bot; native polls; cards are posted as text by the kernel)`,
    );
  } else {
    core.log('info', 'kernel has no send providers — agents cannot post through Telegram');
  }


  // Webhooks: agents' own bots under /api/telegram/agent-bots/<botId>/webhook,
  // the installation's own bot at /api/telegram/webhook. Mounted even in
  // long-poll mode, so a later public base URL needs no restart.
  //
  // Through `ctx.routes` with `auth: 'custom'`, at exactly the two prefixes
  // the manifest declares in `permissions.public_paths`: Telegram sends no
  // omadia session, so the kernel serves these only as granted public paths,
  // and only a prefix registered through `ctx.routes` can be one. Each
  // handler checks Telegram's secret header before it reads an update.
  const disposeWebhookRoutes = [
    ctx.routes.register(
      `${WEBHOOK_PATH_PREFIX}${AGENT_BOTS_PATH}`,
      createTelegramAgentBotsRouter((botId) => {
        const runtime = fleet.agentBotById(botId);
        return runtime ? { bot: runtime.bot, webhookSecret: runtime.webhookSecret } : undefined;
      }),
      { auth: 'custom' },
    ),
    ctx.routes.register(
      `${WEBHOOK_PATH_PREFIX}/webhook`,
      createTelegramWebhookRouter({ bot, webhookSecret, path: '/' }),
      { auth: 'custom' },
    ),
  ];
  core.log('info', `Telegram webhook routes registered at ${WEBHOOK_PATH_PREFIX}/webhook and ${WEBHOOK_PATH_PREFIX}${AGENT_BOTS_PATH}`);
  await defaultBot.start();

  // Trigger and routine deliveries go out through the bot the conversation
  // came through: an agent's own bot, or the installation's with a name line.
  // Registered once the bot runs, removed again on close.
  const disposeProactiveSend = routines?.publishProactiveSend(
    TELEGRAM_ROUTINE_CHANNEL,
    createTelegramProactiveSend((asChannelKey) => fleet.sendDepsFor(asChannelKey)),
  );
  if (routines) core.log('info', 'telegram proactive send registered (triggers and routines deliver through the bot they were set on)');

  // --- Agents' own bots (spec 2042 §5.3) --------------------------------
  // Needs the vault write permission (tokens are stored per bot) and a kernel
  // that takes agent identities; without either, agents keep `/agent`.
  const secrets = ctx.secrets;
  if (secrets.set && secrets.delete) {
    const agentBotDeps: AgentBotDeps = {
      fleet,
      secrets: {
        get: (key) => secrets.get(key),
        keys: () => secrets.keys(),
        set: (key, value) => secrets.set!(key, value),
        delete: (key) => secrets.delete!(key),
      },
      startAgentBot: async (agentApi, agentMe) => {
        const runtime = createBotRuntime(shared, agentApi, agentMe, { agentBot: true });
        await runtime.start();
        return runtime;
      },
      log: (level, message) => core.log(level, message),
    };
    // In the background, all at once: a slow or unreachable Telegram must not
    // hold up activation; unreachable bots are retried (startStoredAgentBots).
    void startStoredAgentBots(agentBotDeps).catch((err: unknown) =>
      core.log('warn', `telegram agent bots could not be started: ${err instanceof Error ? err.message : String(err)}`),
    );
    if (typeof core.registerAgentIdentityProvider === 'function') {
      core.registerAgentIdentityProvider(ctx.agentId, createTelegramAgentIdentityProvider(agentBotDeps));
      core.log('info', 'telegram agent bots: identity provider registered (one bot per agent)');
    } else {
      core.log('info', 'kernel takes no agent identities — agents are reached through the shared bot only');
    }
  }

  // Self-contained operator-admin surface (S+7.7). Plugin owns the
  // /api/telegram/admin/* routes itself — no kernel route file, no
  // ServiceRegistry capability. Auth via plugin-vault `telegram_admin_token`
  // (auto-generated by bootstrapTelegramFromEnv on first install). When
  // the token is missing OR the bot has no username (deeplinks impossible),
  // the admin router is NOT mounted and operator gets a clear log hint.
  const webhookMode: 'webhook' | 'long-poll' =
    defaultBot.mode() === 'webhook' ? 'webhook' : 'long-poll';
  // Admin token gates the operator-admin surface (the Bearer the admin UI's
  // login form sends). It is the secret setup field "Admin-Token" (vault key
  // telegram_admin_token); without one a random token is generated and kept
  // in the vault. It is never logged (live finding 2026-11-23): an operator
  // sets their own in the plugin settings to reach the admin UI or rotate it.
  // omadia#2355 — on a kernel that resolves operator sessions for plugins the
  // admin surface uses the operator's omadia session; the bearer token is only
  // the fallback for older kernels (and is then generated as before).
  const sessionPrincipal = ctx.operatorAuth?.sessionPrincipal?.bind(ctx.operatorAuth);
  const operatorOf = sessionPrincipal
    ? async (cookie: string | undefined) => {
        const operator = await sessionPrincipal(cookie);
        return operator ? { email: operator.email } : null;
      }
    : undefined;
  const adminToken = operatorOf
    ? undefined
    : await ensureAdminToken(ctx.secrets, (line) => core.log('info', line));
  if ((operatorOf || adminToken) && me.username) {
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
      ...(operatorOf ? { operatorOf } : {}),
      ...(adminToken ? { adminToken } : {}),
      ...(krokiBaseUrl ? { krokiBaseUrl } : {}),
      webhookMode,
      dmPolicy,
      ...(accountLinks ? { accountLinks } : {}),
    });
    core.registerRouter(
      ctx.agentId,
      `${WEBHOOK_PATH_PREFIX}/admin`,
      adminRouter,
    );
    core.log(
      'info',
      `Telegram admin router mounted at ${WEBHOOK_PATH_PREFIX}/admin/* (auth: ${operatorOf ? 'operator session' : 'bearer=telegram_admin_token'}, mode=${webhookMode}, qr=${krokiBaseUrl ? 'on' : 'off'})`,
    );
    core.log(
      'info',
      operatorOf
        ? `telegram admin UI at ${WEBHOOK_PATH_PREFIX}/admin/ui/ — uses the operator's omadia session (omadia#2355).`
        : `telegram admin UI login at ${WEBHOOK_PATH_PREFIX}/admin/ui/ — the token is the "Admin-Token" setup field (vault key telegram_admin_token); set or rotate it in the plugin settings.`,
    );
  } else if (!operatorOf && !adminToken) {
    core.log(
      'warn',
      'telegram_admin_token could not be generated — ctx.secrets.set is unavailable. Declare permissions.secrets.runtime_write in the manifest so the channel can auto-generate and persist one on first activation. Admin router NOT mounted.',
    );
  } else {
    core.log(
      'warn',
      'bot has no username (BotFather setup incomplete?) — admin router NOT mounted because pairing deeplinks would be malformed.',
    );
  }

  // byte5ai/omadia#2001 — list the routable keys on /operator/channels, so an
  // agent can be bound to a Telegram chat from the UI. Optional: a kernel
  // without the registry still routes, the page just shows no Telegram row.
  const directoryRegistry = ctx.services.get<ChannelDirectoryRegistryLike>(CHANNEL_DIRECTORY_SERVICE);
  let unregisterDirectory: (() => void) | undefined;
  if (directoryRegistry && me.username) {
    directoryRegistry.register(
      createTelegramChannelDirectory({
        channelType: TELEGRAM_CHANNEL_TYPE,
        originPluginId: ctx.agentId,
        botUsername: me.username,
        pairingStore,
        onError: (what, err) =>
          core.log('warn', `telegram channel directory: reading ${what} failed: ${err instanceof Error ? err.message : String(err)}`),
      }),
    );
    unregisterDirectory = () => directoryRegistry.unregister(TELEGRAM_CHANNEL_TYPE);
    core.log('info', 'telegram contributed its channel keys to /operator/channels');
  } else {
    core.log('info', 'channelDirectoryRegistry@1 not published — Telegram keys are not listed on /operator/channels');
  }

  return {
    close: async () => {
      unregisterDirectory?.();
      for (const dispose of disposeWebhookRoutes) dispose();
      if (typeof disposeProactiveSend === 'function') disposeProactiveSend();
      await fleet.stopAll();
      await defaultBot.stop();
      core.log('info', 'Telegram channel closed (routes now 503)');
    },
  };
}

