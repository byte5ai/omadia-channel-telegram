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
| Agent posts | Conversation and targeted send providers (`telegramSend.ts`); polls and cards as numbered text, answers by reply (`openCards.ts`, `conversationMessages.ts`) |
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

### Own identity per agent: not supported, and why

A Telegram agent identity is a bot, and a bot is created in @BotFather with its
own token. **One installation of this plugin is one bot token and therefore one
identity.** Per-agent bots would need several tokens per installation, a webhook
and secret per token, and pairing, group activation and member tracking per bot.
None of that exists in this plugin, the setup form has no list field for tokens,
and installing the plugin twice is not possible because its routes, vault and
pairing state are keyed by the plugin.

So today the honest answer is: **the bot is one identity, the operator binds it
to an agent** (Operator → Channels, binding on the bot `@username` or a chat id,
resolved through `channelResolver@1`), and **other agents are reached with
`/agent`**. If you want separate bots per agent, the cost for the operator
would be one BotFather bot and one token per agent plus a plugin that
manages several of them; that is not implemented.

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

Everything an agent can do with a card works as text. The plugin registers a
conversation send and a targeted send (DM) provider with the kernel:

- A poll or a one-question card is posted as a numbered list plus "Antworte
  direkt auf diese Nachricht." Reply with the number or the label (several
  numbers for multiple choice and rankings, `ja` / `einwand: Grund` for
  consent, a number or `YYYY-MM-DD`). The reply reaches the kernel as the same
  typed answer a card would carry. In a group only a **reply to that message**
  counts (it also reaches the bot with privacy mode on); in a private chat the
  next message does when it parses. Open questions survive a restart.
- Only kinds a typed reply answers unambiguously are declared (single and
  multiple choice, ranking, consent, number, date), one question per card. The
  kernel falls back to a chat ballot for the rest. A posted question cannot be
  updated into a result card.
- In a conversation the kernel subscribed an agent to, what people write is
  recorded with the author Telegram states (`all` mode: no turn is started;
  `addressed` mode: what addresses the bot). Edits and deletions are not
  recorded (Telegram does not report them to this plugin). With BotFather
  privacy mode on the bot only sees mentions, commands and replies, so a
  facilitation that needs every message needs privacy mode off.
- The own-identity key of this bot is `@<bot_username>`. A send that names
  another identity is refused, nothing is posted under a different name.

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

## License

MIT © byte5 GmbH — see [LICENSE](LICENSE).
