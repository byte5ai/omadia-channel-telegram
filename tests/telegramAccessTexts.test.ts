/**
 * byte5ai/omadia#1998 (DM policy fails closed), #2004 (bare /start greets),
 * #1997 (activation text names what reaches the bot under privacy mode).
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseDmPolicy, parseStartCommand } from '@omadia/channel-telegram';

import { BOT_ID, BOT_USERNAME, harness, privateText, recordingApi } from './fakes.js';

const texts = (h: ReturnType<typeof harness>): string[] => h.api.sent.map((s) => String(s.params['text']));

describe('#1998 — the DM policy fails closed', () => {
  it('reads case and blanks loosely, and falls back to pairing for anything else', () => {
    assert.equal(parseDmPolicy('Pairing'), 'pairing');
    assert.equal(parseDmPolicy(' OPEN '), 'open');
    assert.equal(parseDmPolicy('disabled'), 'disabled');
    const invalid: string[] = [];
    assert.equal(parseDmPolicy('offen', (raw) => invalid.push(raw)), 'pairing');
    assert.deepEqual(invalid, ['offen']);
    assert.equal(parseDmPolicy(''), 'pairing');
    assert.equal(parseDmPolicy(undefined), 'pairing');
    assert.equal(parseDmPolicy(42), 'pairing');
  });
});

describe('#2004 — /start', () => {
  it('parses the bare, token and @bot forms; another bot is not ours', () => {
    assert.deepEqual(parseStartCommand('/start', 'Bot'), { token: '' });
    assert.deepEqual(parseStartCommand('/start abc', 'Bot'), { token: 'abc' });
    assert.deepEqual(parseStartCommand('/start@bot abc', 'Bot'), { token: 'abc' });
    assert.equal(parseStartCommand('/start@OtherBot', 'Bot'), undefined);
    assert.equal(parseStartCommand('/starting', 'Bot'), undefined);
    assert.equal(parseStartCommand('hi /start', 'Bot'), undefined);
  });

  it('bare /start under pairing greets an unpaired person with how to get paired, and starts no turn', async () => {
    const h = harness({ dmPolicy: 'pairing', systemName: 'Idaria' });
    await h.bot.handleUpdate(privateText('/start', 21));
    assert.equal(h.turns.length, 0);
    assert.equal(texts(h).length, 1);
    assert.match(texts(h)[0]!, /Willkommen zum Idaria System!.*Pairing-Link/s);
  });

  it('bare /start under open greets and starts no turn', async () => {
    const h = harness({ dmPolicy: 'open' });
    await h.bot.handleUpdate(privateText(`/start@${BOT_USERNAME}`, 22));
    assert.equal(h.turns.length, 0);
    assert.match(texts(h)[0]!, /Du kannst mich Sachen über deine Daten fragen/);
  });

  it('bare /start under disabled stays silent', async () => {
    const h = harness({ dmPolicy: 'disabled' });
    await h.bot.handleUpdate(privateText('/start', 23));
    assert.equal(h.api.sent.length, 0);
    assert.equal(h.turns.length, 0);
  });
});

describe('#1997 — the group activation notice', () => {
  async function activate(opts: { privacyOff: boolean; status: 'member' | 'administrator' }) {
    const base = recordingApi();
    const api = {
      ...base.client,
      getMe: async () => ({ id: BOT_ID, is_bot: true, first_name: 'Bot', can_read_all_group_messages: opts.privacyOff }),
    };
    const h = harness({ api: api as never });
    await h.pairingStore.putDmBinding({
      telegramUserId: 5,
      harnessIdentityId: 'h1',
      harnessIdentityLabel: 'Anna',
      telegramDisplayName: 'Anna',
      boundAt: new Date().toISOString(),
    });
    await h.bot.handleUpdate({
      update_id: 7001,
      my_chat_member: {
        chat: { id: -1003, type: 'supergroup', title: 'Team' },
        from: { id: 5, is_bot: false, first_name: 'Anna' },
        date: 0,
        old_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: 'left' },
        new_chat_member: { user: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, status: opts.status },
      },
    });
    return base.sent.map((s) => String(s.params['text']));
  }

  it('with privacy mode on: names replies and /cmd@bot and says how to get @-mentions', async () => {
    const [notice] = await activate({ privacyOff: false, status: 'member' });
    assert.match(notice!, new RegExp(`/agent@${BOT_USERNAME}`));
    assert.match(notice!, /Privacy-Mode aktiv/);
    assert.match(notice!, /setprivacy/);
    assert.doesNotMatch(notice!, /Erwähne mich/);
  });

  it('with privacy mode off or as admin: @-mentions are named', async () => {
    for (const opts of [{ privacyOff: true, status: 'member' as const }, { privacyOff: false, status: 'administrator' as const }]) {
      const [notice] = await activate(opts);
      assert.match(notice!, new RegExp(`Erwähne mich dort mit @${BOT_USERNAME}`));
      assert.doesNotMatch(notice!, /setprivacy/);
    }
  });
});
