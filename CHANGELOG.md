# Changelog

## Unreleased

An agent's own Telegram bot (byte5ai/omadia#2042, spec §5.3, §8 item 20).
Needs a kernel with `registerAgentIdentityProvider` (S7); on an older kernel
the plugin runs its own bot only, as before.

- **One bot per agent** next to the installation's own bot: the plugin
  registers an `AgentIdentityProvider` (field: bot token). The token is
  checked with `getMe`, stored in the plugin vault as
  `agent_bot_token_<botId>`, and the bot is started (webhook
  `/api/telegram/agent-bots/<botId>/webhook` with a per-bot secret derived
  from the installation's webhook secret, or long-polling). Boot restarts
  every stored bot; removal stops it and deletes the token.
- **Bot key `tg:<botId>`** for every bot: routing key, `asChannelKey`,
  `receivedByChannelKey` and the roster identity (was `@username`).
- **An agent bot resolves on its own key only** and answers only when the
  kernel reports the key as that agent's identity (`exclusive`); otherwise a
  system notice, never another agent. Its answers carry no name line.
- **Sends, rosters and presence per bot**: `asChannelKey` picks exactly that
  bot (unknown key: unreachable); `presentIn` tells the kernel which agent
  bots are members of a group.
- **Group activations per bot**, DM pairings shared.
- **`compat.core` `>=1.79.0 <2.0`** (placeholder): needs the kernel with agent
  channel identities (S7). The parent session sets the final range on release.

## 0.4.0

Agents as colleagues in Telegram (byte5ai/omadia#2042, issue #7). Needs a
kernel with the speaker, plain-text renderer, decoration registry and pace of
the 2042 channel SDK (byte5ai/omadia#2045, #2086, #2087); do not install it
before that kernel runs.

- **One emitter, every message attributed** (`TelegramEmitter`). Answers use
  the SDK's `renderPlainAnswer`: a name line only where INV-4 asks for one,
  colleagues' contributions as `Ben: …`, kernel notices as plain system text,
  question cards as numbered text. Plugin notices (pairing, refusals,
  failures) are `system` text. A test fails when a send path exists outside
  the emitter.
- **Decorations removed.** No inline-keyboard cards, no follow-up list, no
  callback token map; none is declared for Telegram in the registry. Buttons
  of older messages are acknowledged with a hint to answer in text. The only
  declared element is the AI disclosure line, which is part of the text.
- **Numbered questions** (choice, topic, slots) are answered by number or
  label; the reply becomes the value a button tap carried.
- **`/agent`, `/agents`** are registered with `setMyCommands` (default and
  `de`) and passed to the agent behind the channel resolver unchanged,
  `/agent@Bot …` included. `/agent` without a name clears the selection,
  `/agents` lists (the menu text said "/agent for the list" before; wrong).
  Selection exchanges are not added to the conversation history. In groups a
  bare `/agent` and `/agents` pass the addressing filter (other commands
  without `@Bot` stay ignored), see the README for why.
- **S1 routing contract** (`agentResolution.ts`): `channelResolver@1` is looked
  up per turn and answers `bound` (agent plus speaker) or `reject` (agent for
  `/agent`, plus the `system` notice). The `fallback` decision no longer
  exists. A rejected turn is answered by `system` only; a throwing resolver is
  not a rejection and uses the default agent. Keys tried: chat id,
  `@bot_username`, bare username.
- **No fallback to `chatAgent@1`**: routing goes through the SDK's
  `resolveChannelRoute`. A resolver that throws now ends in a short notice
  (before: the default agent answered); only a host without a resolver uses
  the default `chatAgent`.
- **Selection key** (S1 rule: the key the resolver is called with): the chat id,
  `@bot_username` and the bare username are all probed. Winner: an exclusive
  hit, else the first result something decided (selection, binding, explicit),
  chat before bot, else the default-table agent, else the first rejection. The
  default table no longer shadows a binding on the bot key. Every call carries
  the sender's `de`/`en` locale. See README.
- **One principal form**: the sender is `user:telegram-chat:<id>`
  (`channelUserPrincipal` / `turnPrincipal` from the SDK) for routing and in
  the turn origin; the former `telegram:<id>` principal is gone. The turn origin
  also states `conversationType`, `channelConversationId`, `messageId` and
  `speaker`. `ChatTurnInput.userId` keeps the `telegram:<id>` spelling (a
  trace and pairing key, not a principal).
- **Pace acknowledgement under the agent**: sent as the announced speaker, in
  the sender's language (`de`/`en` from Telegram's `language_code`). Without an
  announced speaker it is not sent (typing carries the wait). It is no longer
  a `system` message.
- **Fail closed without a speaker**: an agent answer with no speaker is
  withheld and replaced by a `system` notice (before: posted without
  attribution plus a warning). A system notice is something the person must
  see; a nameless agent message is something that must not exist.
- **Speaker history persisted** under `/memories/pairings/speaker-history/`
  so the name line is correct after a restart.
- **Conversation roster for the kernel** (`ConversationRosterProvider`,
  feature-detected): `complete` when proven or a private chat, `partial` for
  administrators and seen members, `unknown` when nothing was readable. Not
  activated groups and foreign bot identities resolve to `undefined`.
- **Pace** via `runPacedTurn`: typing from the start, renewed every 4 s, one
  acknowledgement after 8 s, no progress messages, no reply window.
- Fixed: the "not paired" refusal showed MarkdownV2 backslashes.
- **Agents post through Telegram** (criterion 30): conversation and targeted
  send providers, declared honestly (`asChannelKey` only for this bot's own
  key `@<bot_username>`; no `poll`, no `card`, no mentions). The kernel posts a
  poll or card as numbered text itself, keeps the question open and turns a
  typed reply into the `card_answer` (kernel `typedCardReplies`); this plugin has
  no card code. It reports the Telegram `message_id` of every send and records
  what people write as `created` events (delivery mode `all` / `addressed` /
  `none`) with `replyToMessageId` and `addressedToBot`, the bot's own mention
  cut from the text. See README.
- **No double turn for a typed answer**: an addressed message is reported with
  `reportConversationMessage` (feature-detected, 1.5 s timeout, errors logged,
  never thrown) before the turn; `answeredCard: true` starts no turn. Delivery
  mode `all` is unchanged.
- **compat.core** `>=1.75.0 <2.0` (placeholder; the parent session sets the
  final range with the release).
- Own identity per agent (one bot token per agent) is **not** supported; the
  README says why and what it would cost.
- Tests: emitter paths (criterion 5), plain text, parity and decorations
  (29, 30, 31), roster, command menu, pace, routing (reject notice, speaker
  ack, principal form, `/agent` pass-through, group addressing), send providers,
  `created` events for facilitation (the typed card answer is tested in the kernel).

## 0.3.0

Telegram supplies the people present for member-scoped memory
(byte5ai/omadia#1340, context-memory mode `members`):

- **Member tracking** (`GroupMemberTracker`). Telegram gives bots no member
  listing. In an activated group, the bot therefore records message senders,
  `new_chat_members` / `left_chat_member` notices and `chat_member` updates
  (the latter only while the bot is an admin; `allowed_updates` now asks for
  them). The set is persisted under `/memories/pairings/group-members/`.
  Unactivated groups are not tracked.
- **Proven complete or not at all** (`TelegramRosterProvider.audience`). The
  roster is the administrators plus the tracked members. Each one is checked
  with `getChatMember`, and leavers drop out. `completeRoster: true` only
  when the verified members plus the bot equal `getChatMemberCount`; above
  50 members, or after a failed check, the roster stays incomplete. Without
  `completeRoster`, the kernel treats the group as *unknown* and grants no
  member-scoped recall. An unseen newcomer therefore never reads team
  knowledge, not even when an unseen leaver keeps the count the same.
- The roster cache is 10 s instead of 5 min and is invalidated on every
  observed membership change. Bots in the group carry `kind: 'agent'` and
  are not part of the audience.
- Join/leave notices no longer trigger the "Ich kann derzeit nur
  Text-Nachrichten …" reply.
- **TurnOrigin**: every turn states its chat context (DM → `personal`,
  group → conversation).
- Tests: `telegramRosterAudience.test.ts`, 9 cases, including the swap of a
  leaver and a newcomer.

## 0.2.2

- Declare every capability this channel resolves through `ctx.services.get`
  (omadia#838), retiring the `@omadia/channel-telegram` row in
  `STANDALONE_LEGACY_SERVICE_GRANTS_2026_08_20`. `chatAgent@^1` and
  `memoryStore@^1` sit under `requires:` (both plugin-provided); `turnContext`
  and `channelResolver` under `optional_requires:` (kernel-published / absence
  survivable).
