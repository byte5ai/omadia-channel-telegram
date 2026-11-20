<div align="center">

# @omadia/channel-telegram

### Telegram as a first-class channel for omadia's agents — direct Bot API, plain-text answers, `/agent` selection, no third-party SDK.

A **Telegram** channel plugin for [omadia](https://github.com/byte5ai/omadia).
Implements [`@omadia/channel-sdk`](https://github.com/byte5ai/omadia)'s
`ChannelPlugin` contract directly against the Telegram Bot API — webhook with
optional long-polling fallback, plain-text answers, the native `/agent`
command, an honest chat-member roster. Self-contained: no `depends_on`
relationship to other integrations.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**omadia**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai)

</div>

---

## How it works

| Concern | Implementation |
|---|---|
| Transport | Telegram Bot API directly (no third-party SDK) — webhook + optional long-polling fallback (`telegramBot.ts`) |
| Output | One emitter for every message (`telegramEmitter.ts`): the SDK's plain-text renderer, HTML formatting from Markdown (`markdownToHtml.ts`), no buttons, reactions or footers |
| Roster | Verified group audience (`telegramRoster.ts`) and the kernel-facing `ConversationRosterProvider` with an honest status (`conversationRoster.ts`) |
| Agent choice | Native `/agent` and `/agents` commands (`botCommands.ts`); the channel passes the text on, the resolver's agent carries them out (`agentResolution.ts`) |
| Pace | Typing indicator, one acknowledgement for long work under the agent's name (SDK `runPacedTurn`) |
| Agent posts | Conversation and targeted send providers (`telegramSend.ts`); the kernel posts polls and cards as text and matches typed answers, the plugin supplies message ids and `created` events (`conversationMessages.ts`) |
| Pairing | Token-based account pairing (`pairingStore.ts`, `pairingTokens.ts`) |
| DM policy | `dmPolicyGuard.ts` |
| Admin UI | `adminRouter.ts` + static assets under `ui/`, copied into `dist/` at build time |
| Delegation | Every user turn delegated to the shared Conductor/orchestrator |

This channel validates the `@omadia/channel-sdk` contracts against a runtime
with no Bot Framework dependency — it's the SDK's proof that the contract
isn't Teams-specific.

## Agents in Telegram

omadia treats agents as colleagues: every message has a speaker, and you can
address a specific agent. This is what that means in Telegram.

### Own bot per agent

A Telegram agent identity is a bot, created in @BotFather with its own token.
This plugin runs **the installation's own bot** (the token in its setup) and,
next to it, **one bot per agent** (spec 2042 §5.3):

1. In @BotFather, `/newbot`, named like the agent (for example "Mira", username
   `mira_omadia_bot`). Optional: `/setprivacy` → Disable, `/setuserpic`.
2. In omadia, **Operator → Agents → the agent → Channels → Own bots →
   Telegram**: paste the token and connect.

The kernel hands the token to this plugin once; the plugin checks it with
`getMe`, keeps it in its own vault (`agent_bot_token_<botId>`, never in the
kernel), starts the bot (webhook `/api/telegram/agent-bots/<botId>/webhook`
with its own derived secret, or long-polling) and returns the routing key
`tg:<botId>`. From then on:

- **everyone who writes to Mira's bot talks to Mira**, in a private chat and in
  groups; the kernel routes the bot key to Mira before any selection or
  binding, without a model in between. `/agent` there answers that this is
  Mira's own bot;
- **Mira's answers and posts go out through her bot**, with her name and
  picture from Telegram, and without a name line;
- a bot the kernel does not know as an agent's identity (removed in omadia)
  answers only with a short system notice, never as another agent;
- **group activation is per bot**: the bot speaks in a group once a paired
  person added THAT bot, because who added which bot where is a fact about the
  bot. The DM pairing is shared by all bots of the installation, because it
  says which Telegram user is which person, a fact about the person and not
  about a bot; pairing once is enough for every agent's bot;
- removing the bot on the agent page stops it and deletes its token;
- **triggers and routines** an agent sets in a conversation ("remind me
  tomorrow at 9", a weekly report) are delivered later through the bot the
  conversation runs through: through Mira's bot as Mira, through the
  installation's bot named like an answer. Every turn opens the kernel's
  routines scope (`routinesIntegration@1`, only with a database), which is
  what offers the agent these tools here; a bot that was removed or given to
  another agent delivers nothing.

Agents without a bot of their own are reached through the installation's own
bot with `/agent` (below). Its routing key is `tg:<botId>` too; the operator
can still bind it or a chat to an agent (Operator → Channels).

### Choosing an agent: `/agent`, `/agents`

- `/agent Mira` selects the agent Mira for you in this conversation.
- `/agent` without a name clears your selection; the binding or default applies
  again.
- `/agents` lists the agents available to you here.

Both commands appear in the bot's "/" menu (English and German description).
The plugin does **not** handle them: the text goes to the agent behind the
kernel's channel resolver unchanged. It checks availability, stores your
selection (per user and conversation, it survives restarts) and confirms with a
short `system` notice. The plugin has no selection code of its own.

**In groups.** A command without `@YourBot` is normally ignored (it may be meant
for another bot). `/agent` and `/agents` are the exception and are let through
without the suffix: Telegram clients only add `@YourBot` when several bots in
the group know the command, so requiring it would make `/agent` from the "/"
menu dead in the usual single-bot group. `/agent@OtherBot` is still ignored.
With **several** omadia bots in one group, keep BotFather privacy mode **on**
(Telegram then delivers a bare command only to the bot that spoke last) or use
the `@YourBot` form; with privacy off every bot sees the bare command and each
answers it.

**Which key a selection hangs on.** The kernel stores `/agent` selections at the
key the resolver is called with, plus the sender's principal. The bot probes
the chat id, `@<bot_username>` and the bare username (all with the sender's
principal and language, `de`/`en` from Telegram's `language_code`) and uses the
key where something is actually decided: an agent's own bot wins, then a
selection or binding (chat before bot), then the instance's default-agent
table, which every key reports alike and which therefore never shadows a
binding on the bot. With only the default table, or nothing, the chat id is the
key, so a selection is per chat and person. With an operator binding on
`@<bot_username>`, the selection sits at the bot and applies to that person in
all chats of the bot. The shared `chatAgent@1` is never a fallback: with a
registry it only refuses; only a host without one uses it, and a failing
resolver ends in a short notice, not in another agent.

When no agent may answer a turn (agent disabled, not available to you, nothing
bound) the kernel says why in a `system` notice and the plugin posts it. It is
never an agent's answer, and there is no fallback agent.

### What answers look like

Plain text, like a colleague's message.

- **Speaker:** a name line (`Mira: …`) only when several agents speak in the
  conversation or on the first answer after the speaker changed. With one agent
  there is none. The history is kept across restarts.
- **Consultation:** a colleague's contribution is part of the message as
  `Ben: …`.
- **Notices** from the kernel (agent unavailable, selection confirmed) are plain
  system text, never under an agent's name.
- **Questions with options** arrive as a numbered list. Reply with the number
  or the label.
- **Not sent:** buttons, follow-up lists, 👀 reactions, verifier badges, consulted
  footers, disclaimers. They are not declared decorations for Telegram in the
  SDK's registry. The AI disclosure line is part of the text and follows the
  operator's frequency setting. Details stay in the structured answer.
- **Pace:** the typing indicator while the agent works, and one "I'm on it"
  message when the work clearly takes longer. The message comes from the agent
  (the resolver announces it before the answer), so it carries the agent's
  name where the name line is due. Without an announced agent no
  acknowledgement is sent; the typing indicator carries the wait.
- **No speaker, no answer:** an agent answer that names no speaker is not
  posted. The person gets a short `system` notice, the problem is logged.

### Polls, questions and facilitation in plain text

Everything an agent can do with a card works as text, and the **kernel** does
it: a poll or card that a channel does not show natively is posted by the
kernel as a numbered list, kept as an open question, and a typed reply (a
Telegram reply to that message, or a message that addresses the bot when it is
the only open question) becomes the same typed answer a card would carry. This
plugin has no card code. What it provides for that:

- A conversation send and a targeted send (DM) provider that declare
  `asChannelKey` (and, on the conversation send, `reactions`): no `poll`, no
  `card` (so the kernel posts them as text, and a poll or card in a DM is
  refused as before), no mentions. The `messageId` a send reports is the
  Telegram `message_id`; a reply points at it.
- **Reactions instead of echoes** (spec 2043 §5.14): the conversation send
  implements `react`, so a facilitator records a contribution quietly with a
  👍 on the person's message instead of posting an echo. It calls the Bot API
  [`setMessageReaction`](https://core.telegram.org/bots/api#setmessagereaction)
  with `chat_id` = the inbound event's `conversationId`, `message_id` = its
  `messageId` and `reaction: [{ type: 'emoji', emoji: '👍' }]`, as exactly the
  bot `asChannelKey` names (an unknown key is `not_permitted`; nothing is set
  through another bot), and only in a group that activated that bot or a
  private chat the DM policy allows. A bot sets at most one reaction per
  message. A chat whose available reactions exclude 👍, a deleted message or a
  rate limit comes back as `unreachable` / `channel_error` with Telegram's
  message, never thrown.
- `created` events for a conversation the kernel subscribed an agent to, with
  `replyToMessageId` (the `message_id` replied to) and `addressedToBot` (a
  mention, a command, a reply to the bot, or a private chat). The bot's own
  mention is cut from the text. In a group a reply to the bot's message is
  addressed even with privacy mode on.
- **A typed answer is not also a turn.** Where the channel would start a turn
  for a message (it addresses the bot, or a private chat), the plugin first
  reports it with `reportConversationMessage` and waits at most 1.5 s. If the
  kernel consumed it as the answer to an open question, no turn starts: no
  typing, no acknowledgement, no agent answer. A slow or failing report, or a
  kernel without the method, means the turn runs as before.
- In a conversation the kernel subscribed an agent to, what people write is
  recorded with the author Telegram states (`all` mode: no turn is started;
  `addressed` mode: what addresses the bot). Edits and deletions are not
  recorded (Telegram does not report them to this plugin). With BotFather
  privacy mode on the bot only sees mentions, commands and replies, so a
  facilitation that needs every message needs privacy mode off.
- Every bot's own-identity key is `tg:<botId>` (the installation's bot and
  each agent's bot). A send names the bot it goes out as; a key no bot of
  this installation has is refused, nothing is posted under a different name.

### Groups

The bot answers when addressed (mention, reply, `/command@YourBot`, or a bare
`/agent` / `/agents`).
Telegram gives bots no member list, so the roster the plugin reports to the
kernel says how much it could read: `complete` only when every member is
proven (small groups the bot has watched, matching `getChatMemberCount`),
`partial` when only the administrators and seen members are known, `unknown`
when nothing was readable. The kernel treats anything but `complete` as an
unknown audience and fails closed.

## Build & install

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build        # tsc && copy UI assets into dist/
```

The `@omadia/*` peers (`plugin-api`, `channel-sdk`, `orchestrator`) are
provided by the omadia host at runtime. For local typechecking,
`tsconfig.json` maps them to a sibling `omadia` checkout (built `dist/`) — see
`paths` in `tsconfig.json`.

## Manifest

See [`manifest.yaml`](manifest.yaml) for the full plugin manifest.

Permissions: outbound network to `api.telegram.org` only. Telegram needs no
extra bot right for anything this plugin does, reactions included
(`setMessageReaction` works for any bot that is a member of the chat; which
emoji are allowed is the chat's own `available_reactions` setting).

## License

MIT © byte5 GmbH — see [LICENSE](LICENSE).
