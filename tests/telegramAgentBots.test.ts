/**
 * Agents' own Telegram bots (spec 2042 §5.3, §8 item 20).
 *
 * Pinned:
 *  - the identity provider checks a token with Telegram, keeps it in the
 *    plugin vault, starts the bot and returns `tg:<botId>`; it refuses a
 *    malformed or rejected token and the channel's own bot;
 *  - release stops the bot and deletes its token; boot restarts stored bots;
 *  - an agent bot resolves on its own key only and answers only when the
 *    kernel says the key IS an agent's identity (exclusive), never as
 *    another agent; its answers carry no name line;
 *  - a send for `asChannelKey` goes out through exactly that bot, an unknown
 *    key is unreachable;
 *  - each agent bot's webhook checks its own secret.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemorySpeakerHistoryStore } from '@omadia/channel-sdk';
import {
  AGENT_BOT_TOKEN_PREFIX,
  PairingStore,
  TelegramBotFleet,
  TelegramEmitter,
  agentBotWebhookSecret,
  createTelegramAgentIdentityProvider,
  createTelegramConversationSend,
  startStoredAgentBots,
  type AgentBotDeps,
  type TelegramApiClient,
  type TelegramBotRuntime,
} from '@omadia/channel-telegram';

import { fakeResolver, groupText, harness, memoryStore, privateText, recordingApi, speakerA } from './fakes.js';

const DEFAULT_ID = 999;
const MIRA_ID = 7000000001;
const MIRA_TOKEN = `${String(MIRA_ID)}:AAH_mira_secret_token_0123456789`;
const GROUP = -100555;

/** A runtime stand-in: what the fleet and the provider read of one. */
function runtime(botId: number, username: string, api = recordingApi()): TelegramBotRuntime & { stopped: number } {
  const pairingStore = new PairingStore(memoryStore());
  const r = {
    botId,
    botKey: `tg:${String(botId)}`,
    username,
    agentBot: botId !== DEFAULT_ID,
    api: api.client,
    bot: {} as never,
    sendDeps: {
      emitter: new TelegramEmitter({ api: api.client, speakerHistory: new InMemorySpeakerHistoryStore() }),
      pairingStore,
      dmPolicy: 'open' as const,
      botKey: `tg:${String(botId)}`,
    },
    roster: {} as never,
    webhookSecret: 's',
    stopped: 0,
    mode: () => (r.stopped > 0 ? ('stopped' as const) : ('long-poll' as const)),
    start: async () => undefined,
    stop: async () => {
      r.stopped += 1;
    },
  };
  return r as TelegramBotRuntime & { stopped: number };
}

function vault(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k: string) => data.get(k),
    keys: async () => [...data.keys()],
    set: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

function rig(getMe: (token: string) => Promise<{ id: number; is_bot: boolean; first_name: string; username?: string }>) {
  const fleet = new TelegramBotFleet(runtime(DEFAULT_ID, 'ColleagueBot'));
  const secrets = vault();
  const started: number[] = [];
  const logs: string[] = [];
  const deps: AgentBotDeps = {
    fleet,
    secrets,
    apiFor: (token) => ({ getMe: () => getMe(token) }) as unknown as TelegramApiClient,
    startAgentBot: async (_api, me) => {
      started.push(me.id);
      return runtime(me.id, me.username ?? '');
    },
    log: (_l, m) => void logs.push(m),
  };
  return { fleet, secrets, started, logs, deps, provider: createTelegramAgentIdentityProvider(deps) };
}

const mira = async () => ({ id: MIRA_ID, is_bot: true, first_name: 'Mira', username: 'mira_bot' });

describe('identity provider', () => {
  it('declares one secret field and the channel’s own bot as default key', () => {
    const r = rig(mira);
    assert.deepEqual(r.provider.fields.map((f) => [f.key, f.secret]), [['bot_token', true]]);
    assert.equal(r.provider.defaultChannelKey?.(), `tg:${String(DEFAULT_ID)}`);
  });

  it('identify names the bot without a side effect; provision keeps the token and starts it', async () => {
    const r = rig(mira);
    const input = { agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: MIRA_TOKEN } };
    const named = await r.provider.identify(input);
    assert.deepEqual(named, { ok: true, channelKey: `tg:${String(MIRA_ID)}`, externalRef: '@mira_bot', displayName: 'Mira' });
    assert.equal(r.secrets.data.size, 0, 'identify stores nothing');
    assert.deepEqual(r.started, [], 'identify starts nothing');
    const out = await r.provider.provision(input, `tg:${String(MIRA_ID)}`);
    assert.deepEqual(out, { ok: true });
    assert.equal(r.secrets.data.get(`${AGENT_BOT_TOKEN_PREFIX}${String(MIRA_ID)}`), MIRA_TOKEN);
    assert.deepEqual(r.started, [MIRA_ID]);
    assert.ok(r.fleet.agentBot(`tg:${String(MIRA_ID)}`));
    assert.equal(r.logs.join('\n').includes(MIRA_TOKEN), false, 'the token is never logged');
  });

  it('refuses a malformed token without calling Telegram', async () => {
    let called = 0;
    const r = rig(async () => (called++, mira()));
    const out = await r.provider.identify({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: 'nope' } });
    assert.equal(out.ok === false && out.code, 'invalid_input');
    assert.equal(called, 0);
  });

  it('a token Telegram rejects is invalid_credentials, a network failure unreachable; nothing is stored', async () => {
    const rejected = rig(async () => {
      throw new Error('Telegram API getMe failed: Unauthorized (code=401)');
    });
    const a = await rejected.provider.identify({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: MIRA_TOKEN } });
    assert.equal(a.ok === false && a.code, 'invalid_credentials');
    assert.equal(rejected.secrets.data.size, 0);
    const down = rig(async () => {
      throw new Error('fetch failed');
    });
    const b = await down.provider.identify({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: MIRA_TOKEN } });
    assert.equal(b.ok === false && b.code, 'unreachable');
  });

  it('refuses the channel’s own bot', async () => {
    const r = rig(async () => ({ id: DEFAULT_ID, is_bot: true, first_name: 'Colleague', username: 'ColleagueBot' }));
    const out = await r.provider.identify({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: `${String(DEFAULT_ID)}:AAH_default_secret_token_012345` } });
    assert.equal(out.ok === false && out.code, 'already_in_use');
    assert.equal(r.started.length, 0);
  });

  it('a bot that still ran under the key (nobody owns it) is stopped when it starts again: never two loops', async () => {
    const r = rig(mira);
    const key = `tg:${String(MIRA_ID)}`;
    await r.provider.provision({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: MIRA_TOKEN } }, key);
    const first = r.fleet.agentBot(key) as TelegramBotRuntime & { stopped: number };
    const rotated = `${String(MIRA_ID)}:AAH_rotated_secret_token_0123456`;
    await r.provider.provision({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: rotated } }, key);
    assert.equal(first.stopped, 1);
    assert.equal(r.secrets.data.get(`${AGENT_BOT_TOKEN_PREFIX}${String(MIRA_ID)}`), rotated);
  });

  it('provision refuses a token for another bot than the key named, and after the channel closed', async () => {
    const r = rig(mira);
    const input = { agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: MIRA_TOKEN } };
    const other = await r.provider.provision(input, 'tg:1');
    assert.equal(other.ok === false && other.code, 'invalid_input');
    await r.fleet.stopAll();
    const late = await r.provider.provision(input, `tg:${String(MIRA_ID)}`);
    assert.equal(late.ok, false);
    assert.equal(r.started.length, 0);
  });

  it('release stops the bot and deletes its token; status says so', async () => {
    const r = rig(mira);
    await r.provider.provision({ agentSlug: 'mira', agentDisplayName: 'Mira', credentials: { bot_token: MIRA_TOKEN } }, `tg:${String(MIRA_ID)}`);
    const running = r.fleet.agentBot(`tg:${String(MIRA_ID)}`) as TelegramBotRuntime & { stopped: number };
    assert.equal((await r.provider.status!(`tg:${String(MIRA_ID)}`)).state, 'running');
    await r.provider.release(`TG:${String(MIRA_ID)}`);
    assert.equal(running.stopped, 1);
    assert.equal(r.secrets.data.size, 0);
    assert.equal((await r.provider.status!(`tg:${String(MIRA_ID)}`)).state, 'stopped');
  });

  it('boot restarts every stored agent bot; a rejected token stays stored, its bot stopped', async () => {
    const r = rig(async (token) => {
      if (token.startsWith('7000000002')) throw new Error('Telegram API getMe failed: Unauthorized (code=401)');
      return mira();
    });
    r.secrets.data.set(`${AGENT_BOT_TOKEN_PREFIX}${String(MIRA_ID)}`, MIRA_TOKEN);
    r.secrets.data.set(`${AGENT_BOT_TOKEN_PREFIX}7000000002`, '7000000002:AAH_revoked_secret_token_01234');
    r.secrets.data.set('telegram_bot_token', 'not an agent bot');
    await startStoredAgentBots(r.deps, async () => undefined);
    assert.deepEqual(r.fleet.agentBotKeys(), [`tg:${String(MIRA_ID)}`]);
    assert.equal(r.secrets.data.size, 3);
  });

  it('boot retries a bot while Telegram is unreachable, and says so in the status', async () => {
    let calls = 0;
    const r = rig(async () => {
      calls += 1;
      if (calls < 3) throw new Error('fetch failed');
      return mira();
    });
    r.secrets.data.set(`${AGENT_BOT_TOKEN_PREFIX}${String(MIRA_ID)}`, MIRA_TOKEN);
    const statuses: string[] = [];
    await startStoredAgentBots(r.deps, async () => {
      statuses.push((await r.provider.status!(`tg:${String(MIRA_ID)}`)).state);
    });
    assert.deepEqual(statuses, ['unknown', 'unknown']);
    assert.deepEqual(r.fleet.agentBotKeys(), [`tg:${String(MIRA_ID)}`]);
    assert.equal((await r.provider.status!(`tg:${String(MIRA_ID)}`)).state, 'running');
  });
});

describe('fleet', () => {
  it('a send for an agent bot goes out through exactly that bot; an unknown key is unreachable', async () => {
    const defaultApi = recordingApi();
    const miraApi = recordingApi();
    const fleet = new TelegramBotFleet(runtime(DEFAULT_ID, 'ColleagueBot', defaultApi));
    await fleet.add(runtime(MIRA_ID, 'mira_bot', miraApi));
    const send = createTelegramConversationSend((key) => fleet.sendDepsFor(key));
    const viaMira = await send.sendToConversation('4711', { text: 'Hallo von Mira' }, { asChannelKey: `tg:${String(MIRA_ID)}` });
    assert.equal(viaMira.outcome, 'delivered');
    assert.equal(miraApi.sent.length, 1);
    assert.equal(defaultApi.sent.length, 0);
    const viaDefault = await send.sendToConversation('4711', { text: 'x' });
    assert.equal(viaDefault.outcome, 'delivered');
    assert.equal(defaultApi.sent.length, 1);
    const unknown = await send.sendToConversation('4711', { text: 'x' }, { asChannelKey: 'tg:1' });
    assert.equal(unknown.outcome === 'unreachable' && unknown.code, 'not_permitted');
  });

  it('presentIn lists the agent bots that are members of the chat', async () => {
    const memberApi = { ...recordingApi().client, getChatMember: async () => ({ user: {}, status: 'member' }) } as unknown as TelegramApiClient;
    const goneApi = { ...recordingApi().client, getChatMember: async () => ({ user: {}, status: 'left' }) } as unknown as TelegramApiClient;
    const fleet = new TelegramBotFleet(runtime(DEFAULT_ID, 'ColleagueBot'));
    await fleet.add({ ...runtime(MIRA_ID, 'mira_bot'), api: memberApi });
    await fleet.add({ ...runtime(7000000002, 'otto_bot'), api: goneApi });
    assert.deepEqual(await fleet.presentIn(String(GROUP)), [`tg:${String(MIRA_ID)}`]);
  });
});

describe('an agent bot routes only to its own agent', () => {
  const exclusive = { decision: 'bound', exclusive: true, speaker: speakerA };

  it('resolves on its bot key alone and answers without a name line', async () => {
    const resolver = fakeResolver(() => ({ ...exclusive, chatAgent: { chat: async () => ({ text: 'Hier ist Mira.', speaker: speakerA }) } }));
    const h = harness({ channelResolver: resolver.lookup, agentBot: true, botIdentity: { id: MIRA_ID, username: 'mira_bot' } });
    await h.bot.handleUpdate(privateText('hallo', 42));
    assert.deepEqual(resolver.calls.map((c) => c.key), [`tg:${String(MIRA_ID)}`]);
    assert.deepEqual(h.api.sent.map((s) => String(s.params['text'])), ['Hier ist Mira.']);
  });

  it('a key the kernel does not know as an identity is refused — no other agent answers', async () => {
    let asked = 0;
    const resolver = fakeResolver(() => ({
      decision: 'bound',
      match: 'default',
      speaker: speakerA,
      chatAgent: { chat: async () => (asked++, { text: 'Ich bin der Standard-Agent.', speaker: speakerA }) },
    }));
    const h = harness({ channelResolver: resolver.lookup, agentBot: true, botIdentity: { id: MIRA_ID, username: 'mira_bot' } });
    await h.bot.handleUpdate(privateText('hallo', 42));
    assert.equal(asked, 0);
    assert.equal(h.emissions.at(-1)?.speaker, 'system');
    assert.match(String(h.api.sent[0]?.params['text']), /keinem Agenten zugeordnet/);
  });

  it('the installation’s own bot keeps probing the chat first', async () => {
    const resolver = fakeResolver(() => ({ decision: 'bound', chatAgent: { chat: async () => ({ text: 'ok', speaker: speakerA }) }, speaker: speakerA }));
    const h = harness({ channelResolver: resolver.lookup });
    await h.pairingStore.putGroupActivation({ chatId: GROUP, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z' });
    await h.bot.handleUpdate(groupText('@ColleagueBot hallo', GROUP, 7));
    assert.equal(resolver.calls[0]?.key, String(GROUP));
  });
});

describe('agent bot group activations and webhook secrets', () => {
  it('an agent bot keeps its own group activations, the DM bindings are shared', async () => {
    const files = new Map<string, string>();
    const own = new PairingStore(memoryStore(files));
    const agent = new PairingStore(memoryStore(files), { agentBotId: MIRA_ID });
    await own.putGroupActivation({ chatId: GROUP, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z' });
    assert.ok(await own.getGroupActivation(GROUP));
    assert.equal(await agent.getGroupActivation(GROUP), undefined);
    await own.putDmBinding({ telegramUserId: 9, harnessIdentityId: 'h', harnessIdentityLabel: 'A', telegramDisplayName: 'A', boundAt: '2026-11-20T00:00:00Z' });
    assert.ok(await agent.getDmBinding(9));
  });

  it('each agent bot has its own webhook secret, derived from the installation secret', () => {
    const a = agentBotWebhookSecret('installation', MIRA_ID);
    assert.notEqual(a, agentBotWebhookSecret('installation', 7000000002));
    assert.notEqual(a, agentBotWebhookSecret('other', MIRA_ID));
    assert.equal(a, agentBotWebhookSecret('installation', MIRA_ID));
    assert.notEqual(a, 'installation');
  });
});
