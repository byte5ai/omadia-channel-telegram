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
  AgentIdentityProvisionOutcome,
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

  add(runtime: TelegramBotRuntime): void {
    this.agentBots.set(runtime.botKey, runtime);
    this.presence.clear();
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
    await Promise.all([...this.agentBots.values()].map((r) => r.stop()));
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

const refuse = (
  code: Extract<AgentIdentityProvisionOutcome, { ok: false }>['code'],
  message: string,
): AgentIdentityProvisionOutcome => ({ ok: false, code, message });

/** Telegram's answer to a bad token is `401 Unauthorized` (or `404 Not Found`). */
function isRejectedToken(err: unknown): boolean {
  return /code=(401|404)/.test(errorMessage(err));
}

export function createTelegramAgentIdentityProvider(deps: AgentBotDeps): AgentIdentityProvider {
  const apiFor = deps.apiFor ?? ((token: string) => new TelegramApiClient(token));
  return {
    channelType: TELEGRAM_CHANNEL_TYPE,
    fields: AGENT_BOT_FIELDS,
    async provision(input) {
      const token = input.credentials['bot_token']?.trim() ?? '';
      const parsed = BOT_TOKEN_RE.exec(token);
      if (!parsed) return refuse('invalid_input', 'this is not a Telegram bot token (expected <botId>:<secret> from @BotFather)');
      const api = apiFor(token);
      let me: TelegramUser;
      try {
        me = await api.getMe();
      } catch (err) {
        return isRejectedToken(err)
          ? refuse('invalid_credentials', 'Telegram rejected this bot token')
          : refuse('unreachable', 'Telegram could not be reached to check the token');
      }
      if (me.id === deps.fleet.default.botId) {
        return refuse('already_in_use', 'this is the Telegram channel’s own bot');
      }
      const botKey = telegramBotKey(me.id);
      const externalRef = me.username ? `@${me.username}` : undefined;
      // The same bot again (a re-entered or rotated token): restart it on the new token.
      await deps.fleet.remove(botKey)?.stop();
      await deps.secrets.set(`${AGENT_BOT_TOKEN_PREFIX}${String(me.id)}`, token);
      try {
        deps.fleet.add(await deps.startAgentBot(api, me));
      } catch (err) {
        await deps.secrets.delete(`${AGENT_BOT_TOKEN_PREFIX}${String(me.id)}`);
        deps.log('error', `agent bot ${botKey} for '${input.agentSlug}' did not start: ${errorMessage(err)}`);
        return refuse('unreachable', 'the bot could not be started');
      }
      deps.log('info', `agent bot ${externalRef ?? botKey} (${botKey}) started for agent '${input.agentSlug}'`);
      return {
        ok: true,
        channelKey: botKey,
        ...(externalRef ? { externalRef } : {}),
        ...(me.first_name ? { displayName: me.first_name } : {}),
      };
    },
    async release(channelKey) {
      const key = channelKey.trim().toLowerCase();
      const runtime = deps.fleet.remove(key);
      if (runtime) await runtime.stop();
      const botId = /^tg:(\d+)$/.exec(key)?.[1];
      if (botId) await deps.secrets.delete(`${AGENT_BOT_TOKEN_PREFIX}${botId}`);
      deps.log('info', `agent bot ${key} stopped and its token removed`);
    },
    async status(channelKey) {
      const runtime = deps.fleet.agentBot(channelKey.trim().toLowerCase());
      if (!runtime) return { state: 'stopped', detail: 'the bot is not running in this installation (token missing or rejected)' };
      return { state: runtime.mode() === 'stopped' ? 'stopped' : 'running', detail: runtime.mode() };
    },
    defaultChannelKey: () => deps.fleet.default.botKey,
    presentIn: (conversationId) => deps.fleet.presentIn(conversationId),
  };
}

/**
 * Start every agent bot whose token is in the vault (boot). A token Telegram
 * rejects stays where it is and the bot stays stopped: the operator sees it
 * on the agent page and replaces or removes it.
 */
export async function startStoredAgentBots(deps: AgentBotDeps): Promise<void> {
  const apiFor = deps.apiFor ?? ((token: string) => new TelegramApiClient(token));
  const keys = (await deps.secrets.keys()).filter((k) => k.startsWith(AGENT_BOT_TOKEN_PREFIX));
  for (const key of keys) {
    const token = await deps.secrets.get(key);
    if (!token) continue;
    try {
      const api = apiFor(token);
      const me = await api.getMe();
      if (me.id === deps.fleet.default.botId || deps.fleet.agentBotById(me.id)) continue;
      deps.fleet.add(await deps.startAgentBot(api, me));
    } catch (err) {
      deps.log('warn', `agent bot from vault key ${key} did not start: ${errorMessage(err)}`);
    }
  }
  deps.log('info', `telegram agent bots running: ${String(deps.fleet.agentBotKeys().length)}`);
}
