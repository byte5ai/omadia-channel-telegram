/**
 * Triggers and routines on Telegram (spec 2042 §5.12, §5.3): every turn opens
 * the kernel's routines scope with a delivery ref naming the bot, and a
 * delivery goes out through exactly that bot — an agent's own bot without a
 * name line, the installation's bot with one.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemorySpeakerHistoryStore } from '@omadia/channel-sdk';
import {
  PairingStore,
  TelegramEmitter,
  createTelegramProactiveSend,
  createTelegramRoutineTurn,
  parseDeliveryRef,
  type DmPolicy,
} from '@omadia/channel-telegram';

import { BOT_ID, fakeResolver, harness, memoryStore, privateText, recordingApi, speakerA, speakerB } from './fakes.js';

const SHARED_KEY = `tg:${String(BOT_ID)}`;
const MIRA_KEY = 'tg:7000000001';
const CHANNEL_ID = '@omadia/channel-telegram';

function bot(key: string, nativeIdentity: boolean) {
  const api = recordingApi();
  const deps = {
    emitter: new TelegramEmitter({ api: api.client, speakerHistory: new InMemorySpeakerHistoryStore(), nativeIdentity }),
    pairingStore: new PairingStore(memoryStore(new Map())),
    dmPolicy: 'open' as DmPolicy,
    botKey: key,
  };
  return { api, deps };
}

function fleet() {
  const shared = bot(SHARED_KEY, false);
  const mira = bot(MIRA_KEY, true);
  const lookup = (key: string | undefined) =>
    key === undefined || key === SHARED_KEY ? shared.deps : key === MIRA_KEY ? mira.deps : undefined;
  return { shared, mira, send: createTelegramProactiveSend(lookup) };
}

const texts = (api: ReturnType<typeof recordingApi>): string[] => api.sent.map((s) => String(s.params['text']));

describe('routines scope per turn', () => {
  it("files the conversation and, on an agent's own bot, that bot", () => {
    const seen: unknown[] = [];
    const routines = {
      beginRoutineTurn: (info: unknown) => {
        seen.push(info);
        return <T,>(fn: () => Promise<T>) => fn();
      },
    };
    createTelegramRoutineTurn(routines as never, CHANNEL_ID, MIRA_KEY)({ userId: 'telegram:42', chatId: 42 });
    createTelegramRoutineTurn(routines as never, CHANNEL_ID, undefined)({ userId: 'telegram:42', chatId: -100777 });
    assert.deepEqual(seen, [
      { userId: 'telegram:42', channel: 'telegram', conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: '42', asChannelKey: MIRA_KEY } },
      { userId: 'telegram:42', channel: 'telegram', conversationRef: { kind: 'channel', channelId: CHANNEL_ID, conversationId: '-100777' } },
    ]);
  });

  it('the turn runs inside the scope, with the same user id the agent sees', async () => {
    const scopes: unknown[] = [];
    let inside = false;
    const h = harness({
      channelResolver: fakeResolver(() => ({
        decision: 'bound',
        exclusive: true,
        speaker: speakerA,
        chatAgent: {
          chat: async (input: { userId?: string }) => {
            scopes.push({ inside, userId: input.userId });
            return { text: 'Erledigt.', speaker: speakerA };
          },
        },
      })).lookup,
      agentBot: true,
      botIdentity: { id: 7000000001, username: 'mira_bot' },
      routineTurn: (info) => {
        scopes.push(info);
        return async (fn) => {
          inside = true;
          try {
            return await fn();
          } finally {
            inside = false;
          }
        };
      },
    });
    await h.bot.handleUpdate(privateText('erinnere mich morgen', 42));
    assert.deepEqual(scopes, [{ userId: 'telegram:42', chatId: 42 }, { inside: true, userId: 'telegram:42' }]);
  });
});

describe('proactive send', () => {
  it("goes out through the agent's own bot, without a name line", async () => {
    const f = fleet();
    await f.send({ kind: 'channel', channelId: CHANNEL_ID, conversationId: '42', asChannelKey: MIRA_KEY }, { text: 'Dein Bericht ist fertig.', speaker: speakerA });
    assert.deepEqual(texts(f.mira.api), ['Dein Bericht ist fertig.']);
    assert.equal(f.shared.api.sent.length, 0);
  });

  it("goes out through the installation's bot, named like an answer when the speaker changes", async () => {
    const f = fleet();
    const viaShared = { kind: 'channel', channelId: CHANNEL_ID, conversationId: '42' };
    await f.send(viaShared, { text: 'Dein Bericht ist fertig.', speaker: speakerA });
    await f.send(viaShared, { text: 'Die Rechnung ist raus.', speaker: speakerB });
    assert.equal(f.mira.api.sent.length, 0);
    const [first, second] = texts(f.shared.api);
    assert.match(String(first), /Dein Bericht ist fertig\./);
    assert.match(String(second), /Ben/);
    assert.match(String(second), /Die Rechnung ist raus\./);
  });

  it("an agent's own bot never shows a name line, even when the speaker changes", async () => {
    const f = fleet();
    const viaMira = { kind: 'channel', conversationId: '42', asChannelKey: MIRA_KEY };
    await f.send(viaMira, { text: 'Eins.', speaker: speakerA });
    await f.send(viaMira, { text: 'Zwei.', speaker: speakerB });
    assert.deepEqual(texts(f.mira.api), ['Eins.', 'Zwei.']);
  });

  it('a bot that does not run here is an error, never another bot', async () => {
    const f = fleet();
    await assert.rejects(
      f.send({ kind: 'channel', conversationId: '42', asChannelKey: 'tg:4242' }, { text: 'x', speaker: speakerA }),
      /no Telegram bot 'tg:4242'/,
    );
    assert.equal(f.shared.api.sent.length + f.mira.api.sent.length, 0);
  });

  it('a group that did not activate the bot is not posted to', async () => {
    const f = fleet();
    await assert.rejects(
      f.send({ kind: 'channel', conversationId: '-100777', asChannelKey: MIRA_KEY }, { text: 'x', speaker: speakerA }),
      /not activated/,
    );
  });

  it('"nothing to report" is dropped; a kernel text without a speaker goes out as a notice', async () => {
    const f = fleet();
    await f.send({ kind: 'channel', conversationId: '42', asChannelKey: MIRA_KEY }, { text: 'NO_REPLY', speaker: speakerA });
    assert.equal(f.mira.api.sent.length, 0);
    await f.send({ kind: 'channel', conversationId: '42', asChannelKey: MIRA_KEY }, { text: 'Freigabe nötig.' });
    assert.equal(f.mira.api.sent.length, 1);
  });

  it('reads only Telegram chats from a ref', () => {
    assert.deepEqual(parseDeliveryRef({ conversationId: '42', asChannelKey: ' TG:7 ' }), { chatId: 42, asChannelKey: 'tg:7' });
    assert.equal(parseDeliveryRef({ conversationId: 'C0ABC' }), undefined);
    assert.equal(parseDeliveryRef(undefined), undefined);
  });
});
