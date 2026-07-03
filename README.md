<div align="center">

# @omadia/channel-telegram

### Telegram as a first-class channel for omadia's agents — direct Bot API, MarkdownV2, inline keyboards, no third-party SDK.

A **Telegram** channel plugin for [omadia](https://github.com/byte5ai/omadia).
Implements [`@omadia/channel-sdk`](https://github.com/byte5ai/omadia)'s
`ChannelPlugin` contract directly against the Telegram Bot API — webhook with
optional long-polling fallback, MarkdownV2 rendering, inline-keyboard
interactives, chat-member roster. Self-contained: no `depends_on` relationship
to other integrations.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**omadia**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai)

</div>

---

## How it works

| Concern | Implementation |
|---|---|
| Transport | Telegram Bot API directly (no third-party SDK) — webhook + optional long-polling fallback (`telegramBot.ts`) |
| Rendering | MarkdownV2 (`markdownToHtml.ts`, `telegramRenderer.ts`), inline keyboards for choice cards / slot picker / follow-ups |
| Roster | `getChatAdministrators` for group rosters (`telegramRoster.ts`) |
| Pairing | Token-based account pairing (`pairingStore.ts`, `pairingTokens.ts`) |
| DM policy | `dmPolicyGuard.ts` |
| Admin UI | `adminRouter.ts` + static assets under `ui/`, copied into `dist/` at build time |
| Delegation | Every user turn delegated to the shared Conductor/orchestrator |

This channel validates the `@omadia/channel-sdk` contracts against a runtime
with no Bot Framework dependency — it's the SDK's proof that the contract
isn't Teams-specific.

## Build & install

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build        # tsc && copy UI assets into dist/
```

The `@omadia/*` peers (`plugin-api`, `channel-sdk`, `orchestrator`) are
provided by the omadia host at runtime. For local typechecking,
`tsconfig.json` maps them to a sibling `odoo-bot` checkout — see `paths` in
`tsconfig.json`.

## Manifest

See [`manifest.yaml`](manifest.yaml) for the full plugin manifest.

## License

MIT © byte5 GmbH — see [LICENSE](LICENSE).
