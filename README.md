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
| Agent posts | Conversation and targeted send providers (`telegramSend.ts`); the kernel posts cards (and polls in DMs) as text and matches typed answers, the plugin supplies message ids and `created` events (`conversationMessages.ts`); group polls go out as native Telegram polls (`telegramPolls.ts`) |
| Facilitation | Readiness per bot and group, the group's capability snapshot (`telegramReadiness.ts`), join/leave events (`membershipEvents.ts`) |
| Pairing | Token-based account pairing (`pairingStore.ts`, `pairingTokens.ts`) |
| DM policy | `dmPolicyGuard.ts` |
| Admin UI | `adminRouter.ts` + static assets under `ui/`, copied into `dist/` at build time |
| Delegation | Every user turn delegated to the shared agent runtime (Conductor) |

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
  `asChannelKey` (and, on the conversation send, `reactions` and `poll`): no
  `card` (so the kernel posts it as text), no poll on the targeted send (a DM
  to one person: the kernel posts it as text), no mentions. The conversation
  send posts native polls into any chat it reaches, the bot's private chat
  with a person included. The `messageId` a send reports is the Telegram
  `message_id`; a reply points at it.
- **Native polls** on the conversation send: the message text (with the hint
  for a written ballot) goes out first, then a non-anonymous Telegram poll
  ([`sendPoll`](https://core.telegram.org/bots/api#sendpoll)); the poll's
  `message_id` is `cardMessageId`. A vote (`poll_answer`) reaches the kernel
  as a `card_answer` event with `cardAnswer: { cardId: <pollId>, value:
  { optionId } }` and the voter as author. Written ballots in the chat count
  as well. One person's answers in one poll reach the kernel in the order
  Telegram sent them.
  - **Approval votes**: a poll with `multipleAnswers: true` (plugin-api
    1.84.0 / channel-sdk 0.3.10, omadia#2155) goes out as a multiple-answer
    poll and every answer is `{ optionIds }`. Without the flag a poll is
    single choice.
  - **Runoff rounds**: a poll whose `pollId` shares the step part (everything
    before the last `:`, the facilitator's `<stepId>:<round>`) with an open
    poll of the same chat stops that older poll first
    ([`stopPoll`](https://core.telegram.org/bots/api#stoppoll)), best-effort:
    a failure is logged and never fails the send; the old poll's record stays
    until a later stop succeeds.
  - **A poll Telegram refuses** after the text went out is followed by the
    options as text (`A — Berlin`, …) for written ballots; the send is
    reported delivered without `cardMessageId`.
  - Poll records are deleted when a poll is stopped or replaced, dropped
    after 30 days, and at most 20 open polls are kept per chat; a poll
    dropped for age or the cap is stopped on Telegram as well.
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
  `addressed` mode: what addresses the bot). The mention gate is lifted only
  in a conversation the kernel answers `all` for; everywhere else the usual
  mention rules stay. Edits and deletions are not recorded (Telegram does not
  report them to this plugin). With BotFather privacy mode on the bot only
  sees commands (`/cmd@<bot>`) and replies to its own messages, never an
  @-mention; see "Native facilitators" below.
- Every bot's own-identity key is `tg:<botId>` (the installation's bot and
  each agent's bot). A send names the bot it goes out as; a key no bot of
  this installation has is refused, nothing is posted under a different name.

### Native facilitators (spec 2043 §6.4)

A facilitator agent moderates a group as its own bot (a BotFather token on
the agent's page, `tg:<botId>`). What the plugin gives the kernel for that:

- **Readiness** per bot and group (`registerReadinessProvider`): `ready` when
  the group activated that bot, the bot is a member, may post, and receives
  every message. The kernel refuses a facilitation until then and the
  facilitator says in the chat what is missing (`app_not_installed`,
  `consent_missing`, `cannot_post`, `graph_error`, `no_identity`). A private
  chat is `unsupported_conversation`.
- **Capabilities** of an activated group (`registerMeetingSourceProvider`):
  a chat that takes text and poll answers and gives text and native polls.
- **Membership events** (`emitConversationEvent`): `members_added` /
  `members_removed` from join and leave notices and `chat_member` updates,
  `bot_added` (with who added it) when a paired person adds the bot. Bots are
  left out; the same change seen twice (notice and update, or by two bots of
  the installation) goes out once within 60 s.
- **Fresh roster**: `getRoster(id, { fresh: true })` skips the 10 s cache and
  answers `complete` only when proven (see Groups).

**Where Telegram falls short, and the closest behaviour:**

| Requirement | Telegram | Closest behaviour |
|---|---|---|
| Every group message reaches the facilitator | With privacy mode **on** (BotFather default) a bot gets only commands, replies to it and service messages (no @-mentions) | Make the facilitator's bot an **administrator** of the group (admins get every message), or `/setprivacy` → Disable in @BotFather and then **remove and re-add** the bot (the setting applies from the next join). Readiness says `consent_missing` until one of the two holds; privacy off without admin rights is reported `ready` with `verified: false`, because the Bot API cannot tell whether the bot was re-added, until the bot has read a message in the group that did not address it (process-local proof, gone after a restart or when the bot's membership in the group changes) |
| Several agent bots in one group with privacy off | Every bot sees every bare `/command` | Use `/command@Bot` (see `/agent` above) |
| Approval votes as polls | Telegram polls are single or multiple choice; only a kernel with `SendPoll.multipleAnswers` (plugin-api 1.84.0, omadia#2155) says which | With the flag: a multiple-answer poll. **On an older kernel every poll is single choice, so in an approval vote one tap replaces a written multi-option ballot**; there is no robust signal in the poll itself (the hint text is not one), so write several approvals instead of tapping |
| Ranked and other votes as polls | Telegram has no ranked poll | The facilitator posts no poll for them; the ballot is written in the chat |
| Polls in a private chat | The targeted send (a DM to a person) declares no poll; the conversation send does | Targeted send: the kernel posts the question as numbered text, reply with the number. Conversation send into the bot's private chat: a native poll |
| Closing a poll when its step or the facilitation ends | The kernel sends nothing for a poll on close (`updateCard` is for question cards, not polls), so the plugin cannot tell | A poll stays open until a newer round of the same step replaces it (then it is stopped). Taps in a closed step's poll are ignored by the facilitator (`poll_answer_stale`); the facilitator's result message says the vote is over |
| Retracting a native vote | Telegram reports an empty answer | Not reported (the kernel has no form for "no answer"): the last ballot stays until it is changed |
| Anonymous administrators | They vote as the chat, without a person | Not counted; vote as yourself or write the ballot |
| Edits and deletions | Not delivered to this plugin (no `edited_message`; Telegram never reports deletions to bots) | Write a new message; the newest ballot counts |
| Confirming by reaction | Reactions of people are not reported (`message_reaction` needs admin rights and is not subscribed) | Confirm with a short reply ("ja") |
| Joins and leaves | `chat_member` updates only while the bot is an admin | Join and leave notices (delivered to every bot) cover the rest |
| A complete roster | No member list for bots | `complete` only for groups up to 50 members whose members the bot has all seen; otherwise the facilitator works with a declared list |

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
