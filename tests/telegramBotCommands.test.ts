import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { BOT_COMMANDS, registerBotCommands } from '@omadia/channel-telegram';

describe('native command menu', () => {
  it('registers /agent and /agents, with a German description for German clients', async () => {
    const calls: Array<{ commands: readonly { command: string; description: string }[]; language_code?: string }> = [];
    await registerBotCommands({ setMyCommands: async (p) => (calls.push(p), true as const) }, () => undefined);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.commands.map((c) => c.command), ['agent', 'agents']);
    assert.equal(calls[0]?.language_code, undefined);
    assert.equal(calls[1]?.language_code, 'de');
    for (const list of Object.values(BOT_COMMANDS)) {
      for (const c of list) {
        assert.match(c.command, /^[a-z0-9_]{1,32}$/);
        assert.ok(c.description.length >= 3 && c.description.length <= 256);
      }
    }
  });

  it('describes /agent without a name as clearing, /agents as the list (not the other way round)', () => {
    for (const list of Object.values(BOT_COMMANDS)) {
      const agent = list.find((c) => c.command === 'agent')?.description ?? '';
      assert.doesNotMatch(agent, /list|Liste/i, '/agent must not be described as the list');
      assert.match(agent, /clear|lösch/i);
      assert.match(list.find((c) => c.command === 'agents')?.description ?? '', /List|Zeigt/);
    }
  });

  it('a failing setMyCommands costs the menu, not the channel', async () => {
    const logs: string[] = [];
    await registerBotCommands(
      { setMyCommands: async () => { throw new Error('429'); } },
      (level, message) => logs.push(`${level}: ${message}`),
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /^warn: setMyCommands failed: 429/);
  });
});
