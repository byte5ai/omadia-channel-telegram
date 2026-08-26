import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { formatSessionScope, unsharedConversationScope } from '@omadia/channel-sdk';
import { TELEGRAM_CHANNEL_TYPE, telegramTurnOrigin } from '@omadia/channel-telegram';

/**
 * W5 memory-ACL (#870 §4, Telegram row) — the Telegram channel states WHERE a
 * turn came from so the kernel can scope `/memories/` to that chat context.
 *
 * ## What this suite is actually guarding
 *
 * The kernel's `memoryAxesForOrigin` decides which memory tiers an origin
 * reaches, and `middleware/test/memoryAxesForOrigin.test.ts` proves that
 * decision against the §2 table — for literal shapes written by hand in that
 * file. This suite is the other half of the seam: that the shapes this plugin
 * really emits are those shapes. Neither suite alone catches a producer that
 * builds a well-formed origin for the wrong Telegram context, which is a
 * cross-chat memory leak that nothing downstream would notice.
 *
 * The assertions are therefore about the MAPPING, not about the tiers:
 *
 *  - a `private` chat produces a `personal` scope keyed on the human
 *  - `group` / `supergroup` / `channel` keep the conversation scope
 *  - no Telegram turn ever carries a container
 *
 * ## The scope the adapter passes in is the one it renders `sessionScope` from
 *
 * `runTurn` builds a single `ScopeId` via `unsharedConversationScope` and hands
 * the SAME value to `formatSessionScope` and to `telegramTurnOrigin`. These
 * tests rebuild it the same way rather than hand-spelling conversation ids, so a
 * change to the scope derivation shows up here instead of silently splitting the
 * origin away from the session scope.
 *
 * Pollution guard: `telegramTurnOrigin` is pure and this file holds no
 * module-level fixtures — every case builds its own inputs inline.
 */

/** Rebuild the scope exactly as `runTurn` does, from a Telegram chat id. */
const scopeForChat = (chatId: number) =>
  unsharedConversationScope({ scope: `telegram:${String(chatId)}` });

describe('W5 telegramTurnOrigin — private chat', () => {
  it('names the PERSON, not the chat window', () => {
    // A Telegram private chat id happens to equal the user id today, but that is
    // a Bot-API coincidence and not a contract. Keying the user tier on the
    // sender is what makes it the person's tier.
    const origin = telegramTurnOrigin({
      chatType: 'private',
      conversationScope: scopeForChat(12345),
      fromId: 12345,
    });

    assert.deepEqual(origin.scope, { kind: 'personal', userId: '12345' });
    assert.equal(origin.container, undefined);
  });

  it('keys the personal scope on the RAW numeric id, not the prefixed spelling', () => {
    // The kernel keys the tier as `memoryContextKey(channelType, nativeId)` and
    // the channel type is already a segment of that key. A `telegram:` prefix
    // here would spell the channel twice and put one person under two keys
    // depending on which field a caller reached for.
    const origin = telegramTurnOrigin({
      chatType: 'private',
      conversationScope: scopeForChat(777),
      fromId: 777,
    });

    assert.deepEqual(origin.scope, { kind: 'personal', userId: '777' });
  });

  it('keeps two people in their own private trees', () => {
    const alice = telegramTurnOrigin({
      chatType: 'private',
      conversationScope: scopeForChat(111),
      fromId: 111,
    });
    const bob = telegramTurnOrigin({
      chatType: 'private',
      conversationScope: scopeForChat(222),
      fromId: 222,
    });

    assert.notDeepEqual(alice.scope, bob.scope);
  });

  it('falls back to the conversation scope when the sender cannot be named', () => {
    // NOT a hole — a private chat id is already per-person, so the turn stays
    // isolated; it just cannot be recognised as the same person from elsewhere.
    // The alternative, `personal:`, would be one bucket every anonymous private
    // turn shares.
    const origin = telegramTurnOrigin({
      chatType: 'private',
      conversationScope: scopeForChat(12345),
    });

    assert.deepEqual(origin.scope, { kind: 'conversation', conversationId: 'telegram:12345' });
    assert.equal(origin.principal, undefined);
  });
});

describe('W5 telegramTurnOrigin — group and supergroup', () => {
  for (const chatType of ['group', 'supergroup'] as const) {
    it(`gives a ${chatType} its conversation scope and NO container`, () => {
      // Telegram has no enclosing workspace: a supergroup is a conversation, not
      // a team. An absent container is the accurate statement, and it is what
      // keeps a Telegram turn off the team tier entirely.
      const origin = telegramTurnOrigin({
        chatType,
        conversationScope: scopeForChat(-1001234567890),
        fromId: 42,
      });

      assert.deepEqual(origin.scope, {
        kind: 'conversation',
        conversationId: 'telegram:-1001234567890',
      });
      assert.equal(origin.container, undefined);
    });
  }

  it('does not turn a group into a personal chat just because a sender is named', () => {
    const origin = telegramTurnOrigin({
      chatType: 'supergroup',
      conversationScope: scopeForChat(-1001234567890),
      fromId: 42,
    });

    assert.equal(origin.scope.kind, 'conversation');
  });

  it('keeps two supergroups apart — negative ids stay verbatim', () => {
    // The supergroup id space is negative and the minus sign is part of the
    // identity. Dropping or normalising it would merge two chats into one tree.
    const first = telegramTurnOrigin({
      chatType: 'supergroup',
      conversationScope: scopeForChat(-1001234567890),
    });
    const second = telegramTurnOrigin({
      chatType: 'supergroup',
      conversationScope: scopeForChat(1001234567890),
    });

    assert.notDeepEqual(first.scope, second.scope);
    assert.equal(formatSessionScope(first.scope), 'telegram:-1001234567890');
    assert.equal(formatSessionScope(second.scope), 'telegram:1001234567890');
  });

  it('treats a broadcast channel as a conversation, never as a container', () => {
    // A broadcast `channel` is an audience, not a workspace. Conversation scope
    // is both accurate and the narrower of the two options.
    const origin = telegramTurnOrigin({
      chatType: 'channel',
      conversationScope: scopeForChat(-1009999999999),
    });

    assert.equal(origin.scope.kind, 'conversation');
    assert.equal(origin.container, undefined);
  });
});

describe('W5 telegramTurnOrigin — the origin never disagrees with the session scope', () => {
  it('re-emits the scope `runTurn` renders as `sessionScope` for group turns', () => {
    // Two spellings of one conversation would key two different context trees.
    const conversationScope = scopeForChat(-100777);
    const origin = telegramTurnOrigin({ chatType: 'group', conversationScope });

    assert.equal(formatSessionScope(origin.scope), formatSessionScope(conversationScope));
  });
});

describe('W5 telegramTurnOrigin — channel type and principal', () => {
  it('always declares itself as `telegram`', () => {
    // The SDK's allowlist is keyed on this token; a different spelling would
    // silently make every Telegram turn context-free.
    const origin = telegramTurnOrigin({
      chatType: 'group',
      conversationScope: scopeForChat(-100777),
    });

    assert.equal(origin.channelType, 'telegram');
    assert.equal(origin.channelType, TELEGRAM_CHANNEL_TYPE);
  });

  it('carries the speaker as a user principal in the pairing-store spelling', () => {
    // `telegram:<id>` is what `ChatTurnInput.userId` and the pairing store
    // already use, so an audit row matches a binding without a translation
    // table. It deliberately differs from the personal scope's raw id — the SDK
    // reads the SCOPE for the tier, never the principal.
    const origin = telegramTurnOrigin({
      chatType: 'private',
      conversationScope: scopeForChat(12345),
      fromId: 12345,
    });

    assert.deepEqual(origin.principal, { kind: 'user', userId: 'telegram:12345' });
    assert.deepEqual(origin.scope, { kind: 'personal', userId: '12345' });
  });

  it('omits the principal rather than inventing an unmatched one', () => {
    const origin = telegramTurnOrigin({
      chatType: 'group',
      conversationScope: scopeForChat(-100777),
    });

    assert.equal(origin.principal, undefined);
  });
});

describe('W5 telegramTurnOrigin — fail-closed inputs', () => {
  it('inherits the unshared-scope guarantee for an unresolvable chat', () => {
    // `unsharedConversationScope` refuses to land two callers in one bucket.
    // The origin inherits that, so two unresolvable turns never share a tier.
    const first = telegramTurnOrigin({
      chatType: 'group',
      conversationScope: unsharedConversationScope({ scope: undefined, uniqueSuffix: 'upd-1' }),
    });
    const second = telegramTurnOrigin({
      chatType: 'group',
      conversationScope: unsharedConversationScope({ scope: undefined, uniqueSuffix: 'upd-2' }),
    });

    assert.notDeepEqual(first.scope, second.scope);
  });

  it('passes a shared-bucket scope through as the SDK classified it', () => {
    // The producer states the context truthfully rather than pre-judging it; the
    // fail-closed decision lives in exactly one place, the SDK.
    const origin = telegramTurnOrigin({
      chatType: 'group',
      conversationScope: { kind: 'unscoped', reason: 'shared', token: 'unknown' },
    });

    assert.equal(origin.scope.kind, 'unscoped');
  });
});
