/**
 * Criteria 29, 30 and 31 (spec 2042) for the Telegram channel: a normal answer
 * is plain text, every capability works through text, and nothing undeclared
 * is attached to a message. Plus issue #7's own acceptance points: the speaker
 * name line only where unclear, a consultation attributed in text, `/agent`
 * passed through for the kernel.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  REMOVED_DECORATIONS,
  admitDecorations,
  decorationsFor,
  isDecorationAllowed,
} from '@omadia/channel-sdk';
import {
  PersistentSpeakerHistoryStore,
  TELEGRAM_DECORATIONS,
  TELEGRAM_DECORATION_CHANNEL,
} from '@omadia/channel-telegram';

import { BOT_USERNAME, groupText, harness, memoryStore, privateText, speakerA, speakerB } from './fakes.js';

const texts = (h: ReturnType<typeof harness>): string[] => h.api.sent.map((s) => String(s.params['text']));

describe('criterion 29 — a normal answer is plain text', () => {
  it('sends the text and nothing else: no markup, no reaction, no footer', async () => {
    const h = harness();
    h.answers.push({
      text: 'Die Rechnung ist bezahlt.',
      speaker: speakerA,
      disclaimer: 'Nicht geprüft',
      verifier: { status: 'verified' } as never,
      agentsConsulted: [{ agentId: 'x', displayName: 'X' }] as never,
      followUps: [{ label: 'Mehr', prompt: 'mehr' }],
    });
    await h.bot.handleUpdate(privateText('Status?'));
    assert.equal(h.api.sent.length, 1, 'one message, no follow-up list');
    const only = h.api.sent[0]!;
    assert.equal(only.params['reply_markup'], undefined);
    assert.equal(only.params['text'], 'Die Rechnung ist bezahlt.');
  });

  it('shows no name line while one agent speaks, a name line once two do', async () => {
    const h = harness();
    h.answers.push({ text: 'Eins', speaker: speakerA }, { text: 'Zwei', speaker: speakerA });
    await h.bot.handleUpdate(privateText('a'));
    await h.bot.handleUpdate(privateText('b'));
    assert.deepEqual(texts(h), ['Eins', 'Zwei']);

    h.answers.push({ text: 'Drei', speaker: speakerB }, { text: 'Vier', speaker: speakerA });
    await h.bot.handleUpdate(privateText('c'));
    await h.bot.handleUpdate(privateText('d'));
    assert.deepEqual(texts(h).slice(2), ['Ben: Drei', 'Mira: Vier']);
  });

  it('two agents in one chat stay told apart for users with different selections', async () => {
    const h = harness();
    const chat = -1001;
    await h.pairingStore.putGroupActivation({
      chatId: chat, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z',
    });
    h.answers.push({ text: 'Von Mira', speaker: speakerA }, { text: 'Von Ben', speaker: speakerB });
    await h.bot.handleUpdate(groupText(`@${BOT_USERNAME} Frage U`, chat, 1));
    await h.bot.handleUpdate(groupText(`@${BOT_USERNAME} Frage V`, chat, 2));
    assert.deepEqual(texts(h), ['Von Mira', 'Ben: Von Ben']);
  });

  it('the name line survives a restart (history persisted)', async () => {
    const files = new Map<string, string>();
    const first = harness({ speakerHistory: new PersistentSpeakerHistoryStore(memoryStore(files)) }, files);
    first.answers.push({ text: 'Eins', speaker: speakerA });
    await first.bot.handleUpdate(privateText('a'));
    await new PersistentSpeakerHistoryStore(memoryStore(files)).flush();

    // New process, same memory: the speaker changes, so the line is due.
    const store = new PersistentSpeakerHistoryStore(memoryStore(files));
    const second = harness({ speakerHistory: store }, files);
    second.answers.push({ text: 'Zwei', speaker: speakerB });
    await second.bot.handleUpdate(privateText('b'));
    assert.deepEqual(texts(second), ['Ben: Zwei']);
  });

  it('attributes a consultation to the consulted agent in plain text', async () => {
    const h = harness();
    h.answers.push({
      text: 'Ich habe Ben gefragt.',
      speaker: speakerA,
      contributions: [{ id: 'c1', speaker: speakerB, text: 'Das Budget ist 4.000 EUR.', status: 'delivered' }],
    });
    await h.bot.handleUpdate(privateText('Budget?'));
    assert.deepEqual(texts(h), ['Ich habe Ben gefragt.\n\nBen: Das Budget ist 4.000 EUR.']);
  });

  it('renders a system notice as its own text, never under an agent name', async () => {
    const h = harness();
    h.answers.push({ text: 'Ben', speaker: speakerB }); // Ben spoke before: a name line would be due
    await h.bot.handleUpdate(privateText('x'));
    h.answers.push({
      text: 'ignored',
      speaker: { kind: 'system' },
      systemNotice: { code: 'agent_unknown', text: 'Einen Kollegen „Zed“ gibt es nicht.', locale: 'de' },
    });
    await h.bot.handleUpdate(privateText('/agent Zed'));
    const notice = h.api.sent[1]!;
    assert.equal(notice.params['text'], 'Einen Kollegen „Zed“ gibt es nicht.');
    assert.equal(notice.params['parse_mode'], undefined, 'a notice is sent as plain text');
  });

  it('shows the typing indicator while the agent works', async () => {
    const h = harness();
    await h.bot.handleUpdate(privateText('hi'));
    assert.ok(h.api.actions.includes('typing'));
  });
});

describe('criterion 30 — choosing an agent and answering a question work through text', () => {
  it('passes /agent <Name> to the kernel unchanged and shows its notice, outside the history', async () => {
    const h = harness();
    h.answers.push({
      text: 'x',
      speaker: { kind: 'system' },
      systemNotice: { code: 'agent_selected', text: 'Du sprichst jetzt mit Mira.', locale: 'de' },
    });
    await h.bot.handleUpdate(privateText('/agent Mira', 42));
    assert.equal(h.turns[0]?.userMessage, '/agent Mira');
    assert.equal(h.turns[0]?.userId, 'telegram:42');
    assert.deepEqual(texts(h), ['Du sprichst jetzt mit Mira.']);

    // The next turn carries no priorTurns from the selection exchange.
    await h.bot.handleUpdate(privateText('Hallo', 42));
    assert.equal((h.turns[1] as { priorTurns?: unknown }).priorTurns, undefined);
  });

  it('passes the bare /agent list command and the group form /agent@Bot through', async () => {
    const h = harness();
    await h.bot.handleUpdate(privateText('/agent', 42));
    const chat = -1002;
    await h.pairingStore.putGroupActivation({
      chatId: chat, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z',
    });
    await h.bot.handleUpdate(groupText(`/agent@${BOT_USERNAME} Mira`, chat, 42, true));
    assert.deepEqual(
      h.turns.map((t) => t.userMessage),
      ['/agent', `/agent@${BOT_USERNAME} Mira`],
    );
  });

  it('turns a typed number or label back into the option value of a choice question', async () => {
    const h = harness();
    h.answers.push({
      text: '',
      speaker: speakerA,
      interactive: {
        kind: 'choice',
        question: 'Welche Rechnung?',
        options: [
          { label: 'RE-1', value: 'invoice:1' },
          { label: 'RE-2', value: 'invoice:2' },
        ],
      },
    });
    await h.bot.handleUpdate(privateText('Zeig Rechnung', 9));
    assert.equal(texts(h)[0], 'Welche Rechnung?\n1) RE-1\n2) RE-2');
    assert.equal(h.api.sent[0]!.params['reply_markup'], undefined);

    await h.bot.handleUpdate(privateText('2', 9));
    assert.equal(h.turns[1]?.userMessage, 'invoice:2');

    h.answers.push({
      text: '',
      speaker: speakerA,
      interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'RE-1', value: 'invoice:1' }] },
    });
    await h.bot.handleUpdate(privateText('nochmal', 9));
    await h.bot.handleUpdate(privateText('re-1', 9));
    assert.equal(h.turns[3]?.userMessage, 'invoice:1');
  });

  it('lets a reply that is not a pick through unchanged, and a pick is one-shot', async () => {
    const h = harness();
    h.answers.push({
      text: '',
      speaker: speakerA,
      interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'A', value: 'va' }] },
    });
    await h.bot.handleUpdate(privateText('frage', 9));
    await h.bot.handleUpdate(privateText('eigentlich was anderes', 9));
    assert.equal(h.turns[1]?.userMessage, 'eigentlich was anderes');
    await h.bot.handleUpdate(privateText('1', 9));
    assert.equal(h.turns[2]?.userMessage, '1', 'the question is gone after one reply');
  });

  it('a slot question is numbered text and the pick books the slot', async () => {
    const h = harness();
    h.answers.push({
      text: '',
      speaker: speakerA,
      interactive: {
        kind: 'slots',
        question: 'Wann?',
        slots: [{ slotId: 's1', start: '', end: '', timeZone: 'Europe/Berlin', label: 'Mo 10:00', confidence: 1 }],
      },
    });
    await h.bot.handleUpdate(privateText('Termin', 9));
    assert.equal(texts(h)[0], 'Wann?\n1) Mo 10:00');
    await h.bot.handleUpdate(privateText('1', 9));
    assert.equal(h.turns[1]?.userMessage, 'Bitte buche den Slot s1 (Mo 10:00).');
  });

  it('answers a tap on a button from an older version in words, without a turn', async () => {
    const h = harness();
    await h.bot.handleUpdate({
      update_id: 5000,
      callback_query: { id: 'cb1', from: { id: 1, is_bot: false, first_name: 'U' }, data: 'abcd1234' },
    });
    assert.equal(h.turns.length, 0);
    assert.match(String(h.api.callbackAnswers[0]?.['text']), /Antworte bitte mit einer Nachricht/);
  });
});

describe('criterion 31 — no undeclared decoration', () => {
  it('everything this channel attaches is declared for telegram in the registry', () => {
    const { admitted, refused } = admitDecorations(TELEGRAM_DECORATION_CHANNEL, TELEGRAM_DECORATIONS);
    assert.deepEqual(refused, []);
    assert.deepEqual(admitted.map((d) => d.id), ['ai_disclosure_line']);
  });

  it('the registry declares for telegram only the AI disclosure line', () => {
    assert.deepEqual(decorationsFor('telegram').map((d) => d.id), ['ai_disclosure_line']);
  });

  it('refuses the removed and the undeclared elements this channel used to send', () => {
    for (const id of [...REMOVED_DECORATIONS, 'follow_up_options', 'decision_card', 'answer_details']) {
      assert.equal(isDecorationAllowed(id, 'telegram'), false, id);
    }
    const { admitted } = admitDecorations('telegram', [{ id: 'receipt_reaction' }, { id: 'follow_up_options' }, { id: 'made_up' }]);
    assert.deepEqual(admitted, []);
  });

  it('an answer carrying every optional element still produces text only', async () => {
    const h = harness();
    h.answers.push({
      text: 'Fertig.',
      speaker: speakerA,
      disclaimer: 'd',
      followUps: [{ label: 'a', prompt: 'a' }],
      oauthConsentPending: true,
      memoryUsed: true,
      maskedValues: ['x'],
      interactive: { kind: 'routine_list', routines: [], filter: 'all' } as never,
    });
    await h.bot.handleUpdate(privateText('go'));
    assert.equal(h.api.sent.length, 1);
    assert.deepEqual(Object.keys(h.api.sent[0]!.params).sort(), ['chat_id', 'disable_web_page_preview', 'parse_mode', 'text']);
    assert.deepEqual(h.api.callbackAnswers, []);
  });
});
