/**
 * telegram#8 live run: a facilitator's turn posts through this bot itself (the
 * handshake, the ballot) while the turn runs. The pace acknowledgement after
 * that ("Ich kümmere mich darum …") announces work that was already shown, so
 * it is left out once this bot posted into the chat during the turn.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemorySpeakerHistoryStore, paceAckText, type PaceClock } from '@omadia/channel-sdk';
import {
  OwnPosts,
  PairingStore,
  TelegramEmitter,
  createTelegramConversationSend,
} from '@omadia/channel-telegram';

import { BOT_ID, fakeResolver, harness, memoryStore, privateText, recordingApi, speakerA } from './fakes.js';

function manualClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; every?: number; id: number; done?: boolean }[] = [];
  let nextId = 1;
  const cancel = (h: unknown): void => {
    const t = timers.find((x) => x.id === h);
    if (t) t.done = true;
  };
  const clock: PaceClock = {
    now: () => now,
    setTimeout: (fn, ms) => (timers.push({ at: now + ms, fn, id: nextId }), nextId++),
    clearTimeout: cancel,
    setInterval: (fn, ms) => (timers.push({ at: now + ms, fn, every: ms, id: nextId }), nextId++),
    clearInterval: cancel,
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.every !== undefined) due.at += due.every;
      else due.done = true;
      due.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = target;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { clock, advance };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A slow agent that, like a facilitator, posts into the chat itself before it answers. */
function postingAgent(postIntoChat: (chatId: number) => Promise<void>) {
  let release: (text: string) => void = () => undefined;
  const chat = async (input: { origin?: { conversationId?: string } }) => {
    void input;
    await postIntoChat(1);
    return await new Promise((resolve) => {
      release = (text) => resolve({ text, speaker: speakerA });
    });
  };
  return { chat, release: (text: string) => release(text) };
}

describe('no acknowledgement once the bot posted during the turn', () => {
  it('a post into the chat during the turn suppresses the acknowledgement; the answer still comes', async () => {
    const { clock, advance } = manualClock();
    const ownPosts = new OwnPosts();
    const agent = postingAgent(async (chatId) => ownPosts.record(chatId, Date.now()));
    const resolver = fakeResolver(() => ({ decision: 'bound', chatAgent: { chat: agent.chat }, speaker: speakerA }));
    const h = harness({ paceClock: clock, channelResolver: resolver.lookup, ownPosts });
    const turn = h.bot.handleUpdate(privateText('starte eine Abstimmung', 1));
    await settle();
    await advance(30_000);
    await settle();
    assert.equal(h.api.sent.length, 0, 'no acknowledgement after the bot already posted');
    agent.release('Läuft.');
    await turn;
    assert.deepEqual(h.api.sent.map((s) => s.params['text']), ['Läuft.']);
  });

  it('a post before the turn started does not count: the acknowledgement still goes out', async () => {
    const { clock, advance } = manualClock();
    const ownPosts = new OwnPosts();
    ownPosts.record(1, Date.now() - 60_000);
    const agent = postingAgent(async () => undefined);
    const resolver = fakeResolver(() => ({ decision: 'bound', chatAgent: { chat: agent.chat }, speaker: speakerA }));
    const h = harness({ paceClock: clock, channelResolver: resolver.lookup, ownPosts });
    const turn = h.bot.handleUpdate(privateText('lang', 1));
    await settle();
    await advance(8_001);
    await settle();
    assert.deepEqual(h.api.sent.map((s) => s.params['text']), [paceAckText('de')]);
    agent.release('Fertig.');
    await turn;
  });

  it('a post into another chat does not suppress it', () => {
    const ownPosts = new OwnPosts();
    ownPosts.record(-100, 10);
    assert.equal(ownPosts.since(1, 0), false);
    assert.equal(ownPosts.since(-100, 10), true);
    assert.equal(ownPosts.since(-100, 11), false);
  });

  it('the conversation send records what it delivered', async () => {
    const api = recordingApi();
    const pairingStore = new PairingStore(memoryStore(new Map()));
    const ownPosts = new OwnPosts();
    const botKey = `tg:${String(BOT_ID)}`;
    const deps = {
      emitter: new TelegramEmitter({ api: api.client, speakerHistory: new InMemorySpeakerHistoryStore() }),
      api: api.client,
      pairingStore,
      dmPolicy: 'open' as const,
      botKey,
      ownPosts,
    };
    const send = createTelegramConversationSend((key) => (key === undefined || key === botKey ? deps : undefined));
    const before = Date.now();
    const out = await send.sendToConversation('42', { text: 'Handshake' }, { asChannelKey: botKey });
    assert.equal(out.outcome, 'delivered');
    assert.equal(ownPosts.since(42, before), true);
  });
});
