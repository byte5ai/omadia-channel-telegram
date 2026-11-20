/**
 * S1 contract in the Telegram channel (spec 2042 §5.3, INV-7, criteria 10, 30):
 * the resolver decides (`bound` / `reject`), the channel passes text through
 * (`/agent`, `/agents`), the sender is one SDK principal, and a rejected turn
 * is answered by `system` only.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { channelUserPrincipal } from '@omadia/channel-sdk';

import { BOT_USERNAME, fakeResolver, groupText, harness, privateText, speakerA, speakerB } from './fakes.js';

const texts = (h: ReturnType<typeof harness>): string[] => h.api.sent.map((s) => String(s.params['text']));

const notice = (code: string, text: string) => ({ code, text, locale: 'de' });

function agentThatSays(answer: Record<string, unknown>, seen: string[] = []) {
  return { chat: async (input: { userMessage: string }) => (seen.push(input.userMessage), answer) };
}

describe('resolver decisions', () => {
  it('a bound agent answers and is called with the SDK principal', async () => {
    const agent = agentThatSays({ text: 'Hallo', speaker: speakerA });
    const resolver = fakeResolver(() => ({ decision: 'bound', chatAgent: agent, speaker: speakerA }));
    const h = harness({ channelResolver: resolver.lookup });
    await h.bot.handleUpdate(privateText('hi', 4242));
    assert.deepEqual(texts(h), ['Hallo']);
    // chat id first, then the bot's own keys; `bound` on the first key ends it
    assert.deepEqual(resolver.calls.map((c) => c.key), ['4242']);
    assert.equal(resolver.calls[0]?.type, 'telegram');
    assert.equal(resolver.calls[0]?.context?.principal, 'user:telegram-chat:4242');
    assert.equal(resolver.calls[0]?.context?.principal, channelUserPrincipal({ kind: 'telegram-chat', id: '4242' }));
    assert.equal(resolver.calls[0]?.context?.locale, 'de');
  });

  it('probes the chat id, then @bot, then the bare name, and a later bound key wins over an earlier reject', async () => {
    const agent = agentThatSays({ text: 'Bot-Ebene', speaker: speakerA });
    const resolver = fakeResolver((key) =>
      key === `@${BOT_USERNAME}`
        ? { decision: 'bound', chatAgent: agent, speaker: speakerA }
        : { decision: 'reject', chatAgent: agentThatSays({ text: 'nein', speaker: { kind: 'system' } }), notice: notice('no_agent', 'x') },
    );
    const h = harness({ channelResolver: resolver.lookup });
    await h.bot.handleUpdate(privateText('hi', 5));
    assert.deepEqual(resolver.calls.map((c) => c.key), ['5', `@${BOT_USERNAME}`]);
    assert.deepEqual(texts(h), ['Bot-Ebene']);
  });

  it('a reject with a notice: the notice is posted as `system`, the history stays clean', async () => {
    const seen: string[] = [];
    const rejecting = agentThatSays(
      { text: 'ignored', speaker: speakerA, systemNotice: undefined },
      seen,
    );
    const resolver = fakeResolver(() => ({
      decision: 'reject',
      chatAgent: rejecting,
      notice: notice('agent_disabled', 'Mira ist deaktiviert.'),
    }));
    const h = harness({ channelResolver: resolver.lookup });
    await h.bot.handleUpdate(privateText('hallo', 6));
    // the agent behind a rejection answered AS AN AGENT: replaced by the notice
    assert.deepEqual(texts(h), ['Mira ist deaktiviert.']);
    assert.deepEqual(h.emissions.map((e) => e.speaker), ['system']);
  });

  it('a reject without a chat agent posts the notice directly; without a notice, the plugin\'s own', async () => {
    const withNotice = fakeResolver(() => ({ decision: 'reject', notice: notice('no_agent', 'Kein Agent hier.') }));
    const a = harness({ channelResolver: withNotice.lookup });
    await a.bot.handleUpdate(privateText('hi', 7));
    assert.deepEqual(texts(a), ['Kein Agent hier.']);

    const bare = fakeResolver(() => ({ decision: 'reject' }));
    const b = harness({ channelResolver: bare.lookup });
    await b.bot.handleUpdate(privateText('hi', 7));
    assert.match(texts(b)[0] ?? '', /kein Agent eingerichtet/);
    assert.equal(b.turns.length, 0, 'no agent was called');
  });

  it('a rejected turn still reaches the agent behind it for /agent, answered from system', async () => {
    const seen: string[] = [];
    const selecting = agentThatSays(
      { text: 'x', speaker: { kind: 'system' }, systemNotice: notice('agent_selected', 'Du sprichst jetzt mit Mira.') },
      seen,
    );
    const resolver = fakeResolver(() => ({ decision: 'reject', chatAgent: selecting, notice: notice('no_agent', 'Kein Agent.') }));
    const h = harness({ channelResolver: resolver.lookup });
    await h.bot.handleUpdate(privateText('/agent Mira', 8));
    assert.deepEqual(seen, ['/agent Mira']);
    assert.deepEqual(texts(h), ['Du sprichst jetzt mit Mira.']);
  });

  it('a throwing resolver is not a rejection: the default agent answers', async () => {
    const h = harness({
      channelResolver: () => ({ resolve: () => { throw new Error('db down'); } }) as never,
    });
    h.answers.push({ text: 'trotzdem', speaker: speakerA });
    await h.bot.handleUpdate(privateText('hi', 9));
    assert.deepEqual(texts(h), ['trotzdem']);
  });

  it('there is no fallback decision any more: an unknown decision is not served by another agent', async () => {
    const other = agentThatSays({ text: 'falscher Agent', speaker: speakerB });
    const resolver = fakeResolver(() => ({ decision: 'fallback', chatAgent: other }));
    const h = harness({ channelResolver: resolver.lookup });
    h.answers.push({ text: 'x', speaker: { kind: 'system' } as never });
    await h.bot.handleUpdate(privateText('hi', 10));
    assert.ok(!texts(h).includes('falscher Agent'));
  });

  it('anonymous sender: no principal is sent, so only agents for everyone can answer', async () => {
    const agent = agentThatSays({ text: 'ok', speaker: speakerA });
    const resolver = fakeResolver(() => ({ decision: 'bound', chatAgent: agent, speaker: speakerA }));
    const h = harness({ channelResolver: resolver.lookup });
    const update = privateText('hi', 11);
    delete update.message!.from;
    await h.bot.handleUpdate(update);
    assert.equal(resolver.calls[0]?.context?.principal, undefined);
  });
});

describe('the turn origin states who and where in the SDK\'s terms', () => {
  it('private: principal, direct, conversation id, message id and speaker', async () => {
    const h = harness();
    const update = privateText('hi', 77);
    await h.bot.handleUpdate(update);
    const origin = h.turns[0]?.origin as Record<string, unknown>;
    assert.deepEqual(origin['principal'], { kind: 'user', userId: 'telegram-chat:77' });
    assert.equal(origin['conversationType'], 'direct');
    assert.equal(origin['channelConversationId'], '77');
    assert.equal(origin['messageId'], String(update.message?.message_id));
    assert.deepEqual(origin['speaker'], { kind: 'telegram-chat', id: '77', displayName: 'User77' });
  });
});

describe('criterion 30 — choosing an agent works through plain text, the channel only passes it on', () => {
  for (const command of ['/agent Mira', '/agent', '/agents', '/agent@ColleagueBot Mira']) {
    it(`"${command}" reaches the agent unchanged and the kernel's notice comes back as system`, async () => {
      const h = harness();
      h.answers.push({
        text: 'x',
        speaker: { kind: 'system' },
        systemNotice: notice('agent_directory', 'Verfügbar: Mira, Ben'),
      });
      await h.bot.handleUpdate(privateText(command, 21));
      assert.equal(h.turns[0]?.userMessage, command);
      assert.deepEqual(texts(h), ['Verfügbar: Mira, Ben']);
      assert.deepEqual(h.emissions.map((e) => e.speaker), ['system']);
    });
  }

  it('selection exchanges are not part of the conversation history', async () => {
    const h = harness();
    h.answers.push({ text: 'x', speaker: { kind: 'system' }, systemNotice: notice('agent_selected', 'Ok.') });
    await h.bot.handleUpdate(privateText('/agent Mira', 22));
    h.answers.push({ text: 'Hallo', speaker: speakerA });
    await h.bot.handleUpdate(privateText('hi', 22));
    // chat() was given no prior turn for the second message
    assert.equal((h.turns[1] as { priorTurns?: unknown }).priorTurns, undefined);
  });
});

describe('/agent and /agents in groups', () => {
  const activate = (h: ReturnType<typeof harness>, chat: number) =>
    h.pairingStore.putGroupActivation({
      chatId: chat, chatTitle: 'Team', chatType: 'supergroup', activatedBy: 'h', activatedVia: 'auto', activatedAt: '2026-11-20T00:00:00Z',
    });

  it('a bare /agent and /agents (single-bot group, no suffix) are let through', async () => {
    const h = harness();
    await activate(h, -500);
    await h.bot.handleUpdate(groupText('/agent Mira', -500, 1, true));
    await h.bot.handleUpdate(groupText('/agents', -500, 1, true));
    assert.deepEqual(h.turns.map((t) => t.userMessage), ['/agent Mira', '/agents']);
  });

  it('the suffixed form for this bot is let through, for another bot ignored', async () => {
    const h = harness();
    await activate(h, -501);
    await h.bot.handleUpdate(groupText(`/agent@${BOT_USERNAME} Mira`, -501, 1, true));
    await h.bot.handleUpdate(groupText('/agent@OtherBot Mira', -501, 1, true));
    assert.deepEqual(h.turns.map((t) => t.userMessage), [`/agent@${BOT_USERNAME} Mira`]);
  });

  it('every other command without suffix stays ignored; so does /agentx and a mid-text /agent', async () => {
    const h = harness();
    await activate(h, -502);
    await h.bot.handleUpdate(groupText('/start', -502, 1, true));
    await h.bot.handleUpdate(groupText('/agentx foo', -502, 1, true));
    await h.bot.handleUpdate(groupText('wir sollten /agent nutzen', -502, 1, false));
    assert.equal(h.turns.length, 0);
  });

  it('the group sender is routed by their own principal, not the group', async () => {
    const agent = agentThatSays({ text: 'ok', speaker: speakerA });
    const resolver = fakeResolver(() => ({ decision: 'bound', chatAgent: agent, speaker: speakerA }));
    const h = harness({ channelResolver: resolver.lookup });
    await activate(h, -503);
    await h.bot.handleUpdate(groupText('/agent Mira', -503, 31, true));
    assert.equal(resolver.calls[0]?.key, '-503');
    assert.equal(resolver.calls[0]?.context?.principal, 'user:telegram-chat:31');
  });
});
