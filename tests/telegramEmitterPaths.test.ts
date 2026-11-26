/**
 * Acceptance criterion 5 (spec 2042): every user-visible message carries a
 * speaker (agent or `system`), and a test enumerates every emitter.
 *
 * Two halves. Statically: the Bot API's send methods are called from exactly
 * one module (`telegramEmitter.ts`), so a new emitter path cannot appear
 * without going through the code that stamps the speaker. Dynamically: every
 * path of the bot that talks to a person (answer, notice, failure, pairing,
 * refusal, group activation) is driven and every message it emits is
 * attributed.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { harness, privateText, speakerA, BOT_ID } from './fakes.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SEND_CALL = /\.\s*(sendMessage|sendPhoto|sendDocument)\s*\(/g;

describe('criterion 5 — one emitter, every message attributed', () => {
  it('only telegramEmitter.ts calls the Bot API send methods', () => {
    const callers = new Map<string, number>();
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
      const hits = readFileSync(join(SRC, file), 'utf8').match(SEND_CALL)?.length ?? 0;
      if (hits > 0) callers.set(file, hits);
    }
    assert.deepEqual([...callers.keys()], ['telegramEmitter.ts'], 'a send path outside the emitter has no speaker');
    // The emitter's own paths: system text, answer text (+ its plain fallback),
    // photo, document. A new one is a deliberate change of this number.
    assert.equal(callers.get('telegramEmitter.ts'), 5);
  });

  it('answer, system notice, failure, refusal and pairing emissions all name their speaker', async () => {
    const h = harness({ dmPolicy: 'pairing' });

    // 1. an agent answer
    h.answers.push({ text: 'Hallo', speaker: speakerA });
    await h.bot.handleUpdate(privateText('hi', 7)); // unpaired: refusal notice first
    // 2. refusal under the pairing policy is a system notice
    assert.equal(h.emissions.at(-1)?.speaker, 'system');

    const open = harness();
    open.answers.push({ text: 'Hallo', speaker: speakerA });
    await open.bot.handleUpdate(privateText('hi', 7));
    // 3. a system notice from the kernel (e.g. agent selected)
    open.answers.push({
      text: 'x',
      speaker: { kind: 'system' },
      systemNotice: { code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.', locale: 'de' },
    });
    await open.bot.handleUpdate(privateText('/agent Mira', 7));
    // 4. attachments are the agent's own output
    open.answers.push({
      text: 'Bild',
      speaker: speakerA,
      attachments: [{ url: 'https://example.test/a.png', altText: 'a', kind: 'image' } as never],
    });
    await open.bot.handleUpdate(privateText('zeig', 7));
    // 5. the agent call failing is a system notice
    const failing = harness({
      chatAgent: {
        chat: async () => {
          throw new Error('boom');
        },
      },
    });
    await failing.bot.handleUpdate(privateText('hi', 7));
    // 6. a message type we cannot read (a sticker)
    await failing.bot.handleUpdate({
      update_id: 900,
      message: {
        message_id: 1,
        from: { id: 7, is_bot: false, first_name: 'U' },
        chat: { id: 7, type: 'private' },
        date: 0,
        sticker: { file_id: 'st' },
      },
    });
    // 7. bare /start greeting
    await failing.bot.handleUpdate(privateText('/start ', 7));

    const all = [...h.emissions, ...open.emissions, ...failing.emissions];
    assert.ok(all.length >= 8, `drove ${String(all.length)} emissions`);
    for (const e of all) assert.ok(e.speaker === 'agent' || e.speaker === 'system', `unattributed emission: ${JSON.stringify(e)}`);
    assert.deepEqual(
      open.emissions.map((e) => `${e.speaker}:${e.kind}`),
      ['agent:text', 'system:text', 'agent:text', 'agent:photo'],
    );
    assert.equal(failing.emissions[0]?.speaker, 'system');
  });

  it('every message the Bot API receives is accounted for by one emission', async () => {
    const h = harness();
    h.answers.push({ text: 'a', speaker: speakerA });
    await h.bot.handleUpdate(privateText('hi', 3));
    assert.equal(h.api.sent.length, h.emissions.length);
  });

  it('an answer without a speaker is withheld (fail closed), never posted nameless', async () => {
    const h = harness();
    h.answers.push({ text: 'ohne speaker' });
    await h.bot.handleUpdate(privateText('hi', 4));
    assert.equal(h.api.sent.length, 1);
    assert.doesNotMatch(String(h.api.sent[0]?.params['text']), /ohne speaker/);
    assert.deepEqual(h.emissions.map((e) => e.speaker), ['system']);
  });

  it('the group-activation DM is a system notice', async () => {
    const h = harness();
    await h.pairingStore.putDmBinding({
      telegramUserId: 5,
      harnessIdentityId: 'h1',
      harnessIdentityLabel: 'Anna',
      telegramDisplayName: 'Anna',
      boundAt: new Date().toISOString(),
    });
    await h.bot.handleUpdate({
      update_id: 901,
      my_chat_member: {
        chat: { id: -1001, type: 'supergroup', title: 'Team' },
        from: { id: 5, is_bot: false, first_name: 'Anna' },
        date: 0,
        old_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: 'left' },
        new_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: 'member' },
      },
    });
    assert.deepEqual(h.emissions.map((e) => e.speaker), ['system']);
  });
});
