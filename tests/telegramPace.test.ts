/**
 * Spec 2042 §5.8 "Pace": typing from the start, exactly one acknowledgement
 * when work takes clearly longer, no progress chatter, and the answer as an
 * ordinary message (Telegram has no reply window). Driven with the SDK's
 * `PaceClock` seam.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { paceAckText, type PaceClock } from '@omadia/channel-sdk';
import { TELEGRAM_PACE_PROFILE } from '@omadia/channel-telegram';

import { harness, privateText, speakerA } from './fakes.js';

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

function slowAgent() {
  let release: (text: string) => void = () => undefined;
  const chat = () =>
    new Promise((resolve) => {
      release = (text) => resolve({ text, speaker: speakerA });
    });
  return { chat, release: (text: string) => release(text) };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('pace in the Telegram channel', () => {
  it('has no reply window and renews typing every 4 s', () => {
    assert.equal(TELEGRAM_PACE_PROFILE.replyWindowMs, undefined);
    assert.equal(TELEGRAM_PACE_PROFILE.typingIntervalMs, 4_000);
    assert.equal(TELEGRAM_PACE_PROFILE.ackThresholdMs, 8_000);
  });

  it('a fast answer: typing, no acknowledgement, one message', async () => {
    const { clock } = manualClock();
    const h = harness({ paceClock: clock });
    await h.bot.handleUpdate(privateText('schnell'));
    assert.deepEqual(h.api.actions, ['typing']);
    assert.equal(h.api.sent.length, 1);
  });

  it('long work: typing renewed, exactly one acknowledgement, then the answer as a normal message', async () => {
    const { clock, advance } = manualClock();
    const agent = slowAgent();
    const h = harness({ paceClock: clock, chatAgent: { chat: agent.chat } as never });
    const turn = h.bot.handleUpdate(privateText('lang', 11));
    await settle();
    assert.equal(h.api.actions.length, 1, 'typing at the start');

    await advance(7_999);
    assert.equal(h.api.sent.length, 0, 'no acknowledgement before the threshold');
    assert.equal(h.api.actions.length, 2, 'typing renewed at 4 s');

    await advance(2);
    await settle();
    assert.deepEqual(h.api.sent.map((s) => s.params['text']), [paceAckText('de')]);

    await advance(120_000);
    await settle();
    assert.equal(h.api.sent.length, 1, 'no progress chatter, still one acknowledgement');
    assert.ok(h.api.actions.length >= 30, 'typing keeps being renewed');

    agent.release('Fertig.');
    await turn;
    assert.deepEqual(h.api.sent.map((s) => s.params['text']), [paceAckText('de'), 'Fertig.']);
    assert.deepEqual(h.emissions.map((e) => e.speaker), ['system', 'agent']);

    const typingAfter = h.api.actions.length;
    await advance(60_000);
    assert.equal(h.api.actions.length, typingAfter, 'typing stops when the answer is out');
  });

  it('a failing typing call never fails the turn', async () => {
    const { clock } = manualClock();
    const h = harness({ paceClock: clock });
    (h.api.client as unknown as { sendChatAction: () => Promise<never> }).sendChatAction = async () => {
      throw new Error('429');
    };
    h.answers.push({ text: 'ok', speaker: speakerA });
    await h.bot.handleUpdate(privateText('hi'));
    assert.deepEqual(h.api.sent.map((s) => s.params['text']), ['ok']);
  });

  it('a failing agent call still ends in one system notice and stops the pace timers', async () => {
    const { clock, advance } = manualClock();
    const h = harness({
      paceClock: clock,
      chatAgent: { chat: async () => { throw new Error('boom'); } } as never,
    });
    await h.bot.handleUpdate(privateText('hi'));
    await advance(30_000);
    assert.equal(h.api.sent.length, 1);
    assert.match(String(h.api.sent[0]?.params['text']), /Fehler aufgetreten: boom/);
  });
});
