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
