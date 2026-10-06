# Changelog

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
