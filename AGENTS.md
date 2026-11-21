# AGENTS.md — omadia-channel-telegram

Rules for coding agents working in this repository.

## Releases

- **No version bumps in PRs.** Do not change `version` in `package.json` or
  `manifest.yaml`, and do not publish. The coordinator releases: add your
  change under `## Unreleased` in `CHANGELOG.md` and suggest the next version
  in the PR body.
- Kernel contract changes (`@omadia/channel-sdk`, `@omadia/plugin-api`) land
  in the kernel first; name the kernel PR and the package versions a change
  depends on in the CHANGELOG entry and the PR body.

## Gates

Node 22. `npm run typecheck`, `npm run build`, `npm test` (tests run against
the built `dist/`, so build first).

## Decisions

### Bot reactions (spec 2043 §5.14, ADR 0027, byte5ai/omadia#2151)

- The conversation send provider declares `supports.reactions: true` and
  implements `react`. Kernel reaction `acknowledge` = Telegram 👍.
- Platform source: Bot API `setMessageReaction`
  (https://core.telegram.org/bots/api#setmessagereaction) with
  `chat_id`, `message_id` (numeric) and
  `reaction: [{ type: 'emoji', emoji: '👍' }]`. Bots set at most one reaction
  per message; a chat's `available_reactions` may exclude 👍, which Telegram
  answers with an error.
- Addressing: `conversationId` = `String(chat.id)` and `messageId` =
  `String(message_id)`, exactly as `conversationMessages.ts` reports inbound
  messages.
- Identity: as exactly the bot `asChannelKey` (`tg:<botId>`) names, through
  `posterFor`; an unknown key is `not_permitted`, never another bot.
- Failures are returned, never thrown: platform errors are `channel_error`
  with Telegram's message; unparseable ids are `no_binding`; a chat the bot
  may not post to is `not_permitted`.
- No extra Telegram permission is needed; outbound host stays
  `api.telegram.org`.

### Native facilitators: readiness, polls, membership (#8, spec 2043 §6.4)

- **Context**: the kernel refuses a facilitation on a channel without a
  readiness provider, reports a text-only baseline without a meeting source
  (so the facilitator never posts polls), and needs joins and leaves for its
  electorate. Telegram's privacy mode, poll model and update kinds limit what
  can be promised.
- **Decision**:
  - Readiness is `ready` for an activated group where the bot is a member,
    may post, and is an administrator or has privacy mode off. Privacy off
    without admin rights is `ready` with `verified: false`: the setting only
    applies after the bot is re-added, which the Bot API cannot show. Messages
    are written for the person who has to fix it (the facilitator relays them).
  - Native polls on the conversation send only (DMs stay text). Text first,
    then a non-anonymous single-choice poll: `SendPoll` carries no method, and
    a multiple-answer poll would let a single-choice voter cast a ballot the
    engine refuses. A poll Telegram refuses after the text is out leaves the
    text (written ballots still count) and is reported delivered without
    `cardMessageId`. Labels are clipped to Telegram's limits, never refused.
    Poll ids are stored per bot in the memory store so votes map after a
    restart. Retracted votes and votes by an anonymous admin are not reported.
  - Membership events: one `TelegramMembershipEvents` per installation, so a
    change seen by several bots or by notice and `chat_member` goes out once
    (same chat, person, direction within 60 s). Bots are never members.
    `bot_present` is not emitted (no consumer needs it yet).
- **Consequence**: a Telegram facilitation needs the bot to be admin or
  privacy-off-and-re-added; README lists every gap with the closest
  behaviour. Multi-choice native polls need a kernel change (`SendPoll`
  saying single or multiple).

