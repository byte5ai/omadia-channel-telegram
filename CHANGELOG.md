# Changelog

## Unreleased

- **Declares its memory tree.** The manifest declares `permissions.memory.trees: ["pairings"]` (omadia ADR-0256, byte5ai/omadia#2232). On a kernel with ADR-0256, a plugin's `memoryStore@1` changes only the top-level trees it declares and owns, so no other plugin can read or rewrite `/memories/pairings/*`. Older kernels ignore the field, and ADR-0256's kernel keeps `pairings` for this plugin through a dated legacy row until this release is installed, so install order does not matter.
- **The agent's files arrive** (byte5ai/omadia#1993).
  - **The problem.** The channel sent every attachment by URL. Telegram cannot fetch a `localhost` URL, and with `sendDocument` it fetches only GIF, PDF and ZIP. So Excel and Word files never arrived, and with the default base URL no diagram did either. The answer still said "here is your file".
  - **How files are sent now.** On a kernel with the attachment read seam (`CoreApi.readAttachment`, channel-sdk 0.3.16, omadia ADR-0222, byte5ai/omadia#2257), a file the kernel serves is read as bytes and uploaded as multipart. JPEG, PNG and WebP up to 10 MB are sent as a photo, everything else as a document. A URL that is not the kernel's is still sent by URL.
  - **When a file cannot be sent.** If a file does not arrive in any of these ways, the person gets one notice naming the missing files ("Die Datei „…“ konnte nicht zugestellt werden."). The turn history notes `[attachment not delivered: "<name>"]`, so the agent does not refer to the file as delivered.
  - **Captions** are cut to stay within Telegram's 1024-character caption limit. If Telegram refuses a caption's HTML, the file is sent again once with the caption as plain text, so a caption never costs the file.
  - **The notice names the file by the kernel's file name**, otherwise by an alt text that is a file name, otherwise by the end of the URL.
  - **Proactive sends.** A routine or facilitator post still reports `delivered` when its text arrived, because the send contract has no "partly delivered". The missing files are logged and named in the chat.
  - **Older kernels.** The seam is feature-detected. On a kernel without it, everything goes by URL as before, plus the notice.

## 0.8.0

- **Long answers arrive in parts** (byte5ai/omadia#1989). An answer over Telegram's 4096-character limit was refused ("message is too long") and the fallback to plain text failed the same way, so the person got an error instead of the answer. The emitter now cuts the text before converting it to HTML, at a paragraph, line or space; every part is valid HTML on its own, and a code block across a cut is closed and opened again. Attachments follow the last part. Only an entity error ("can't parse entities") falls back to plain text now; any other refusal is not retried as plain text. A part never is an empty code block, and text that cannot be cut into valid HTML parts (a long fence line full of `<`) goes out as escaped plain text instead of failing.
- **A failed turn shows a fixed notice, never the error** (byte5ai/omadia#2000). The apology used to repeat the error message (provider hosts, Bot API wording) and ended in a double period. It now names the kind in fixed words, in the person's language: the language model is not reachable, the answer could not be delivered, or something went wrong. A Bot API call that does not reach Telegram counts as a delivery failure. The full error is logged with the kind.
- **Files the bot cannot read are named** (byte5ai/omadia#1999). PDF and Office files, HEIC or other image formats sent as a file, images over 5 MB, voice and audio messages, videos and stickers were dropped with a log line only, or answered with "Ich kann derzeit nur Text-Nachrichten und Bilder verarbeiten." even when the file was an image. The person now gets one line per file with the reason (with the hint to send an image as a photo where that helps), and a turn with text carries the note `[attachment could not be read: "<name>" (<mime>): <reason>]` (name and type cleaned of line breaks and brackets, so they cannot add text of their own) so the agent does not answer as if it had seen the file. Reading PDF or Office files needs an attachment seam in the kernel (byte5ai/omadia#1993) and is not part of this change.
- **Service messages and empty updates get no notice** (byte5ai/omadia#1996). A message without text, image or file (a pinned message, a new chat title) drew the "nur Text-Nachrichten und Bilder" notice in direct chats before the DM policy was checked, so an unpaired user or `dm_policy=disabled` still got an answer. Such a message is now ignored with a log line, and the notice for an unreadable file is sent only after the DM policy and the group gates.
- **The DM policy fails closed** (byte5ai/omadia#1998). `dm_policy` is now an enum field (`pairing`, `open`, `disabled`) and is read case-insensitively. A missing, blank or unknown value (`Pairing ` with a typo, a cleared field) used to open the bot to everyone; it is now `pairing`, with a warning in the log. Note: an installation from before 0.3 that never had the field and relied on the old `open` fallback is now `pairing`; set `open` explicitly to keep it. The kernel's post-install PATCH does not validate enum values yet (core part of #1998); the plugin's fallback covers that.
- **START shows the greeting** (byte5ai/omadia#2004). A bare `/start` (the START button) only matched with a trailing space, so it was refused as unpaired or sent to the model. `/start`, `/start <token>`, `/start@<bot>` and `/start@<bot> <token>` are now recognised. A bare `/start` greets and never starts a turn; under `pairing` an unpaired person is told to ask for a pairing link, under `disabled` the bot stays silent. `/start@<bot>` in an activated group greets too.
- **The group activation notice says what reaches the bot** (byte5ai/omadia#1997). With BotFather privacy mode on (the default) and no admin rights, an @-mention never reaches the bot, but the notice and the setup guide told people to @-mention it. The notice now checks `getMe` (`can_read_all_group_messages`) and the bot's status: with privacy on it names replies to the bot and `/agent@<bot>`, and says how to get @-mentions (`/setprivacy` → Disable, then remove and re-add the bot, or make it an admin); a warning goes to the log. The setup guide and README say the same.
- **Admin UI texts** (byte5ai/omadia#2002, #2005). The login hint no longer says the token is logged at first boot (it never is since 0.7.4); it points to the "Admin-Token" field in the plugin settings. The page title and login line say omadia instead of "byte5 Harness".
- **Telegram chats appear in `/operator/channels`** (byte5ai/omadia#2001). The plugin registered no `ChannelKeyDirectory`, so the page listed no Telegram row and an agent could not be bound to a Telegram chat from the UI. It now lists the installation bot (`@<bot>`, every chat of that bot), each activated group (its chat id) and each paired direct chat (the person's chat id): the keys a turn is resolved on. An agent's own bot is not listed, it already is its agent. Needs the kernel's `channelDirectoryRegistry@1` (declared optional); without it routing works as before. The page's empty-state text is a kernel change (core part of #2001).
- **The pairing no longer claims a link it does not make** (byte5ai/omadia#1995). The welcome said "Du bist verbunden als <name>", but a pairing binds the chat to no omadia user: turns run as the Telegram user, and the identity ID is a free-text note. omadia decided that a pairing should link to a real user, with the link owned by the kernel (ADR-0225, Proposed). Until that kernel seam exists, the welcome says the account is now allowed to chat (pairing "<label>"), and the admin UI calls the field a free label ("Kennung"), not "Harness Identity ID" (rest of #2005). The README describes the pairing as a DM allow-list.

## 0.7.5

- **No acknowledgement after the bot already posted in the turn.** A facilitator posts through its own bot while the turn runs (the handshake, the ballot). The pace acknowledgement ("Ich kümmere mich darum, das dauert einen Moment.") still followed and announced work the group had already seen (telegram#8 live run). The bot's send providers now note each delivered post per chat, and a turn whose bot posted into the chat since it started sends no acknowledgement. Same rule as Discord 0.5.4.

## 0.7.4

- **The admin token is never logged.** The first generated token used to be written to the boot log in cleartext. A token set through the setup API landed in the plain config and had no effect. It is now the secret setup field "Admin-Token" (vault key `telegram_admin_token`). Without one, a random token is generated and kept in the vault. To use the admin UI, or to rotate the token, set your own in the plugin settings.
- **The group hears the activation notice when the adder cannot be written to.** An agent's own bot may not write first to a person who never opened a chat with it (403). The notice now goes to the group instead.

## 0.7.3

- **0.7.2 did not activate when it declared public paths.** The kernel accepts a declared public path only under a prefix the plugin registered through `ctx.routes`. The webhooks were still mounted through `core.registerRouter`, so activation failed with "the plugin registered no routers". Both webhooks are now `ctx.routes` registrations with `auth: 'custom'`, at exactly `/api/telegram/webhook` and `/api/telegram/agent-bots`, and are removed on close. `createTelegramWebhookRouter` takes an optional `path` (default `/webhook`, unchanged for existing callers).

## 0.7.2

- **System name in the bot's own texts.** A new setup field `system_name`
  (default `omadia`) names the system in the pairing welcome ("Willkommen zum
  <Name> System" / "Welcome to the <Name> system", then the connected
  identity), the bare `/start` greeting, the refusal for an unpaired DM and
  the group-activation notice. The hard-coded "byte5 Harness" is gone. The
  texts follow the user's Telegram language (en or de).
- **Webhooks reachable behind the kernel's session gate.** The manifest
  declares `/api/telegram/webhook` and `/api/telegram/agent-bots` as public
  paths (each handler checks Telegram's secret header). Before, webhook mode
  on an instance with the session gate answered every update `401
  auth.missing`, so neither the installation's bot nor an agent bot ever
  received a message. The operator grants the two paths on the plugin page.
  The setup help now says the base URL is the middleware's origin, not the
  web UI's (found live, omadia-channel-telegram#8).

## 0.7.1

User-visible texts no longer say "Orchestrator" (spec 2042 §6 criterion 12, `docs/terminology.md`): the manifest description, the package description, the README and the admin page now speak of your agents and the agent runtime.

## 0.7.0

Native facilitators in Telegram (byte5ai/omadia-channel-telegram#8, epic
byte5ai/omadia#2043, spec §5.3, §5.5, §6.4). Uses only contracts already in
`@omadia/channel-sdk` 0.3.9 / `@omadia/plugin-api` 1.82.0
(`registerReadinessProvider`, `registerMeetingSourceProvider`,
`emitConversationEvent`, `SendPoll`); every one is feature-detected.
Two later kernel fields are read structurally when present:
`SendPoll.multipleAnswers` (plugin-api 1.84.0, omadia#2155) and the private
turn's `TurnOrigin.replyToMessageId` (channel-sdk 0.3.11, omadia#2157).
Suggested version: 0.7.0.

- **Readiness** per bot and group: activated, member, may post, receives every
  message (administrator, or privacy mode off: then `verified: false`).
  Without it the kernel refused every facilitation on Telegram.
- **Capability snapshot** of an activated group: text and native polls in,
  text and poll answers out, so the facilitator posts polls here.
- **Native polls**: the conversation send declares `poll`; text first, then a
  non-anonymous single-choice `sendPoll`. `poll_answer` is now in
  `allowed_updates`; a vote reaches the kernel as `card_answer` with the
  kernel's poll and option ids (persisted, so a vote after a restart still
  maps). Retracted votes and anonymous administrators are not reported.
- **Approval votes as multiple-answer polls**: a poll with
  `multipleAnswers: true` (read structurally; plugin-api 1.84.0 /
  channel-sdk 0.3.10, omadia#2155) is sent with `allows_multiple_answers`
  and its answers carry `{ optionIds }`. On an older kernel polls stay single
  choice (README gap table).
- **Runoff rounds stop the earlier poll**: a new poll of the same step
  (`<stepId>:<round>`) stops the open one with `stopPoll` first
  (best-effort, never fails the send) and drops its record; a poll that
  could not be stopped keeps its record, so the next round tries again. Closing a poll
  when a step ends is a documented gap: the kernel sends nothing for it.
- **A refused poll** is followed by the options as text, so the ballot hint
  never points at a poll nobody sees; reported without `cardMessageId`.
- **Poll answers in order**: one person's answers in one poll are handled one
  after another (a webhook delivers them concurrently).
- **Bounded poll records**: deleted when stopped or replaced, dropped after
  30 days or beyond 20 open polls per chat (such a poll is stopped on
  Telegram too); the in-memory cache holds 500.
- **`replyToMessageId` on private turns** (`TurnOrigin`, channel-sdk 0.3.11 /
  plugin-api 1.85.0, omadia#2157): a reply to a reminder the bot sent names
  the same id the send reported as `messageId`.
- **Readiness**: a failing activation lookup is `graph_error` (and no
  capability snapshot) instead of a rejected check; privacy off is
  `verified` once the bot has read a message there that did not address it
  (reset when the bot's membership in the group changes).
- **Membership events**: `members_added`, `members_removed` and `bot_added`
  (with who added the bot) for activated groups; bots left out, duplicates
  (notice plus `chat_member`, or several bots) dropped within 60 s. A change
  whose emit failed is not remembered, so the next copy goes out.
- **Images behind the gates**: a photo is downloaded only once the message
  passed the activation, mention and engine gates.
- **Fix**: a sticker or voice message in a group no longer draws the
  "only text and images" notice unless it addresses the bot in an activated
  group (with privacy mode off every sticker did).
- README: what Telegram cannot do for a facilitation and the closest
  behaviour.

## 0.6.0

Bot reactions (spec 2043 §5.14, byte5ai/omadia#2061; decision record ADR 0027,
kernel PR byte5ai/omadia#2151). Needs `@omadia/channel-sdk` 0.3.9 and
`@omadia/plugin-api` 1.82.0; `compat.core` is now `>=1.82.0 <2.0`.

- **A thumbs-up instead of an echo**: the conversation send provider
  implements `react` and declares `supports.reactions: true`. The reaction
  `acknowledge` is set as 👍 with the Bot API `setMessageReaction`
  (https://core.telegram.org/bots/api#setmessagereaction) on `chat_id` =
  the inbound event's `conversationId`, `message_id` = its `messageId`.
- **As exactly the bot `asChannelKey` names** (the installation's bot or an
  agent's own bot); an unknown key is `not_permitted` and nothing is set
  through another bot. Same chat gate as posting: a group must have activated
  that bot, a private chat must pass the DM policy.
- **Never thrown**: a chat whose available reactions exclude 👍, a deleted
  message or a rate limit is `unreachable` / `channel_error` with Telegram's
  message; a non-Telegram chat or message id is `no_binding`.
- No new permission: outbound `api.telegram.org` was already declared; the
  manifest lists `setMessageReaction` among the Bot API methods used.

## 0.5.0

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
- **Triggers and routines deliver through the bot they were set on** (spec
  2042 §5.12): every turn opens the kernel's routines scope
  (`routinesIntegration@1`, optional) with a delivery ref naming the chat and,
  on an agent's own bot, that bot (`asChannelKey`); the proactive send posts
  through exactly that bot (no name line on an agent's bot, named like an
  answer on the installation's). A bot that no longer runs here is an error.
  These turns never become a person's Conductor reminder target
  (`conductorBinding: false`), and the proactive send is removed when the
  channel closes.
- **`compat.core` `>=1.79.0 <2.0`**: needs the kernel with agent channel
  identities (plugin-api 1.79.0, S7).

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
