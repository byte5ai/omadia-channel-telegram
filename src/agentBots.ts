/**
 * Agents' own Telegram bots (spec 2042 §5.3, §8 item 20).
 *
 * An operator gives an agent a bot of its own: a token from @BotFather,
 * entered on the agent's page in omadia. The kernel hands it to
 * {@link createTelegramAgentIdentityProvider} once; this plugin checks it with
 * `getMe`, keeps it in its own vault (`agent_bot_token_<botId>`), starts the
 * bot and returns its routing key `tg:<botId>`. The kernel stores (agent,
 * key) and from then on routes every turn through that bot to the agent, and
 * posts the agent's messages through it.
 *
 * {@link TelegramBotFleet} holds every running bot (the installation's own
 * one and the agent bots) and answers the per-identity questions the kernel
 * asks: which bot posts for `asChannelKey`, which bot reads a roster, which
 * agent bots are members of a group.
 */

import type {
  AgentIdentityField,
  AgentIdentityProvider,
  AgentIdentityRefusal,
  ConversationRoster,
  ConversationRosterProvider,
  ConversationRosterRequest,
} from '@omadia/channel-sdk';

import { errorMessage, type TelegramBotRuntime } from './botRuntime.js';
import { telegramBotKey } from './conversationMessages.js';
import { TELEGRAM_CHANNEL_TYPE, TelegramApiClient, type TelegramUser } from './telegramBot.js';
import type { TelegramSendDeps } from './telegramSend.js';

/** Vault key of an agent bot's token. */
export const AGENT_BOT_TOKEN_PREFIX = 'agent_bot_token_';
/** A BotFather token: `<botId>:<secret>`. Checked before any call goes out. */
const BOT_TOKEN_RE = /^(\d{3,20}):[A-Za-z0-9_-]{20,100}$/;
/** How long a group membership answer is trusted (`presentIn`). */
const PRESENCE_TTL_MS = 60_000;

export const AGENT_BOT_FIELDS: readonly AgentIdentityField[] = Object.freeze([
  {
    key: 'bot_token',
    label: { en: 'Bot token', de: 'Bot-Token' },
    help: {
      en: 'Create a bot for this agent with @BotFather (/newbot, named like the agent) and paste the HTTP API token. One bot per agent; not the channel’s own bot.',
      de: 'Lege für diesen Agenten bei @BotFather einen Bot an (/newbot, benannt wie der Agent) und füge den HTTP-API-Token ein. Ein Bot pro Agent, nicht der eigene Bot des Kanals.',
    },
    secret: true,
  },
]);

/** The bots of the installation, by routing key. */
export class TelegramBotFleet {
  private readonly agentBots = new Map<string, TelegramBotRuntime>();
  private readonly presence = new Map<string, { readonly at: number; readonly keys: readonly string[] }>();

  constructor(private readonly defaultBot: TelegramBotRuntime) {}

  get default(): TelegramBotRuntime {
    return this.defaultBot;
  }

  agentBot(botKey: string): TelegramBotRuntime | undefined {
    return this.agentBots.get(botKey);
  }

  agentBotById(botId: number): TelegramBotRuntime | undefined {
    return this.agentBots.get(telegramBotKey(botId));
  }

  agentBotKeys(): readonly string[] {
    return [...this.agentBots.keys()];
  }

  private closed = false;
  /** Bots whose start waits for Telegram to become reachable again (boot). */
  private readonly retrying = new Set<string>();

  /**
   * Hold a started bot. A bot that runs under the key already is stopped
   * first (never two loops for one bot), and after {@link stopAll} nothing is
   * held any more: a late start is stopped at once. `false` = not added.
   */
  async add(runtime: TelegramBotRuntime): Promise<boolean> {
    if (this.closed) {
      await runtime.stop();
      return false;
    }
    const previous = this.agentBots.get(runtime.botKey);
    this.agentBots.set(runtime.botKey, runtime);
    this.retrying.delete(runtime.botKey);
    this.presence.clear();
    if (previous && previous !== runtime) await previous.stop();
    return true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  markRetrying(botKey: string, retrying: boolean): void {
    if (retrying) this.retrying.add(botKey);
    else this.retrying.delete(botKey);
  }

  isRetrying(botKey: string): boolean {
    return this.retrying.has(botKey);
  }

  /** Removes and returns the runtime; the caller stops it. */
  remove(botKey: string): TelegramBotRuntime | undefined {
    const runtime = this.agentBots.get(botKey);
    this.agentBots.delete(botKey);
    this.presence.clear();
    return runtime;
  }

  /** The bot a send goes out as: no key = the installation's own bot. */
  sendDepsFor(asChannelKey: string | undefined): TelegramSendDeps | undefined {
    if (asChannelKey === undefined || asChannelKey === this.defaultBot.botKey) return this.defaultBot.sendDeps;
    return this.agentBots.get(asChannelKey)?.sendDeps;
  }

  /** The roster as the bot `asChannelKey` sees it; no key = the installation's own bot. */
  rosterProvider(): ConversationRosterProvider {
    return {
      channelType: TELEGRAM_CHANNEL_TYPE,
      getRoster: (conversationId: string, opts?: ConversationRosterRequest): Promise<ConversationRoster | undefined> => {
        const key = opts?.asChannelKey?.trim().toLowerCase();
        const runtime = key === undefined || key === this.defaultBot.botKey ? this.defaultBot : this.agentBots.get(key);
        return runtime ? runtime.roster.getRoster(conversationId, opts) : Promise.resolve(undefined);
      },
    };
  }

  /** The agent bots that are members of this chat, cached for a minute. */
  async presentIn(conversationId: string): Promise<readonly string[]> {
    const chatId = Number(conversationId.replace(/^telegram:/, ''));
    if (!Number.isSafeInteger(chatId)) return [];
    const cached = this.presence.get(conversationId);
    if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) return cached.keys;
    const checks = await Promise.all(
      [...this.agentBots.values()].map(async (runtime) => {
        try {
          const member = await runtime.api.getChatMember({ chat_id: chatId, user_id: runtime.botId });
          return ['member', 'administrator', 'restricted', 'creator'].includes(member.status) ? runtime.botKey : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const keys = checks.filter((k): k is string => k !== undefined);
    this.presence.set(conversationId, { at: Date.now(), keys });
    return keys;
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    const running = [...this.agentBots.values()];
    this.agentBots.clear();
    this.retrying.clear();
    await Promise.all(running.map((r) => r.stop()));
  }
}

export interface AgentBotSecrets {
  get(key: string): Promise<string | undefined>;
  keys(): Promise<string[]>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AgentBotDeps {
  readonly fleet: TelegramBotFleet;
  readonly secrets: AgentBotSecrets;
  /** Builds and starts the runtime of an agent bot. */
  readonly startAgentBot: (api: TelegramApiClient, me: TelegramUser) => Promise<TelegramBotRuntime>;
  /** Seam for tests: a Bot API client for a token. */
  readonly apiFor?: (token: string) => TelegramApiClient;
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const refuse = (code: AgentIdentityRefusal['code'], message: string): AgentIdentityRefusal => ({ ok: false, code, message });

/** Telegram's answer to a bad token is `401 Unauthorized` (or `404 Not Found`). */
function isRejectedToken(err: unknown): boolean {
  return /code=(401|404)/.test(errorMessage(err));
}

/** Who a token is, as Telegram says; a refusal for a malformed or rejected token. */
async function botOf(
  apiFor: (token: string) => TelegramApiClient,
  credentials: Readonly<Record<string, string>>,
): Promise<{ api: TelegramApiClient; me: TelegramUser; token: string } | AgentIdentityRefusal> {
  const token = credentials['bot_token']?.trim() ?? '';
  if (!BOT_TOKEN_RE.test(token)) {
    return refuse('invalid_input', 'this is not a Telegram bot token (expected <botId>:<secret> from @BotFather)');
  }
  const api = apiFor(token);
  try {
    return { api, me: await api.getMe(), token };
  } catch (err) {
    return isRejectedToken(err)
      ? refuse('invalid_credentials', 'Telegram rejected this bot token')
      : refuse('unreachable', 'Telegram could not be reached to check the token');
  }
}

const isRefusal = (value: object): value is AgentIdentityRefusal => (value as { ok?: unknown }).ok === false;

export function createTelegramAgentIdentityProvider(deps: AgentBotDeps): AgentIdentityProvider {
  const apiFor = deps.apiFor ?? ((token: string) => new TelegramApiClient(token));
  return {
    channelType: TELEGRAM_CHANNEL_TYPE,
    fields: AGENT_BOT_FIELDS,
    // No side effect: the kernel decides whether this bot is free.
    async identify(input) {
      const bot = await botOf(apiFor, input.credentials);
      if (isRefusal(bot)) return bot;
      if (bot.me.id === deps.fleet.default.botId) return refuse('already_in_use', 'this is the Telegram channel’s own bot');
      return {
        ok: true,
        channelKey: telegramBotKey(bot.me.id),
        ...(bot.me.username ? { externalRef: `@${bot.me.username}` } : {}),
        ...(bot.me.first_name ? { displayName: bot.me.first_name } : {}),
      };
    },
    // Called only for a bot no agent owns (the kernel checked).
    async provision(input, channelKey) {
      const bot = await botOf(apiFor, input.credentials);
      if (isRefusal(bot)) return bot;
      const botKey = telegramBotKey(bot.me.id);
      if (botKey !== channelKey.trim().toLowerCase() || bot.me.id === deps.fleet.default.botId) {
        return refuse('invalid_input', 'the token names another bot than the one checked');
      }
      if (deps.fleet.isClosed) return refuse('unreachable', 'the Telegram channel is shutting down');
      const vaultKey = `${AGENT_BOT_TOKEN_PREFIX}${String(bot.me.id)}`;
      await deps.secrets.set(vaultKey, bot.token);
      try {
        // `add` stops a bot that still ran under this key (nobody owned it).
        if (!(await deps.fleet.add(await deps.startAgentBot(bot.api, bot.me)))) {
          return refuse('unreachable', 'the Telegram channel is shutting down');
        }
      } catch (err) {
        await deps.secrets.delete(vaultKey);
        deps.log('error', `agent bot ${botKey} for '${input.agentSlug}' did not start: ${errorMessage(err)}`);
        return refuse('unreachable', 'the bot could not be started');
      }
      deps.log('info', `agent bot ${bot.me.username ? `@${bot.me.username}` : botKey} (${botKey}) started for agent '${input.agentSlug}'`);
      return { ok: true };
    },
    async release(channelKey) {
      const key = channelKey.trim().toLowerCase();
      deps.fleet.markRetrying(key, false);
      await deps.fleet.remove(key)?.stop();
      const botId = /^tg:(\d+)$/.exec(key)?.[1];
      if (botId) await deps.secrets.delete(`${AGENT_BOT_TOKEN_PREFIX}${botId}`);
      deps.log('info', `agent bot ${key} stopped and its token removed`);
    },
    async status(channelKey) {
      const key = channelKey.trim().toLowerCase();
      const runtime = deps.fleet.agentBot(key);
      if (runtime) return { state: runtime.mode() === 'stopped' ? 'stopped' : 'running', detail: runtime.mode() };
      if (deps.fleet.isRetrying(key)) return { state: 'unknown', detail: 'Telegram is not reachable; the bot starts as soon as it is' };
      return { state: 'stopped', detail: 'the bot is not running in this installation (token missing or rejected)' };
    },
    defaultChannelKey: () => deps.fleet.default.botKey,
    presentIn: (conversationId) => deps.fleet.presentIn(conversationId),
  };
}

/** Backoff of a stored bot whose start failed because Telegram was not reachable. */
export const BOOT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000];

/**
 * Start every agent bot whose token is in the vault (boot), all at once and
 * without holding up activation. A token Telegram REJECTS stays where it is
 * and the bot stays stopped: the operator sees it on the agent page and
 * replaces or removes it. Any other failure (Telegram unreachable during a
 * deploy) is retried with backoff, the last delay repeating.
 */
export async function startStoredAgentBots(
  deps: AgentBotDeps,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const apiFor = deps.apiFor ?? ((token: string) => new TelegramApiClient(token));
  const keys = (await deps.secrets.keys()).filter((k) => k.startsWith(AGENT_BOT_TOKEN_PREFIX));
  const startOne = async (key: string): Promise<void> => {
    const botKey = `tg:${key.slice(AGENT_BOT_TOKEN_PREFIX.length)}`;
    for (let attempt = 0; !deps.fleet.isClosed; attempt++) {
      const token = await deps.secrets.get(key);
      if (!token) return;
      try {
        const api = apiFor(token);
        const me = await api.getMe();
        if (me.id === deps.fleet.default.botId || deps.fleet.agentBotById(me.id)) return;
        await deps.fleet.add(await deps.startAgentBot(api, me));
        return;
      } catch (err) {
        if (isRejectedToken(err)) {
          deps.log('warn', `agent bot from vault key ${key} not started: Telegram rejects its token`);
          return;
        }
        const delay = BOOT_RETRY_DELAYS_MS[Math.min(attempt, BOOT_RETRY_DELAYS_MS.length - 1)] ?? 300_000;
        deps.fleet.markRetrying(botKey, true);
        deps.log('warn', `agent bot from vault key ${key} did not start (${errorMessage(err)}); retrying in ${String(delay)} ms`);
        await sleep(delay);
      }
    }
  };
  await Promise.all(keys.map(startOne));
  deps.log('info', `telegram agent bots running: ${String(deps.fleet.agentBotKeys().length)}`);
}
