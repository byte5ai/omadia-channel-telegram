/**
 * Telegram renderer — maps the channel-agnostic `SemanticAnswer` (from
 * `@omadia/channel-sdk`) to the Telegram Bot API wire format
 * (HTML text + photo/document for attachments + inline-keyboard for
 * interactives).
 *
 * Separated from telegramBot.ts so the bot stays focused on inbound-update
 * dispatch and ChatAgent orchestration, while this file owns all outgoing
 * wire-format concerns: markdown→HTML conversion, inline-keyboard layout,
 * and the callback_data tokenisation map.
 *
 * Post-S+7.5: input is SemanticAnswer; the previous RenderableAnswer
 * ChatTurnResult-shaped adapter is gone.
 *
 * Post-S+7.7: switched from MarkdownV2 to HTML mode. Telegram's MarkdownV2
 * has 18 reserved chars + no native table support, so naive escape killed
 * orchestrator-emitted markdown (visible `**bold**` stars, raw `|`-pipe
 * tables). HTML mode escapes only 3 chars (`<`, `>`, `&`) and a small
 * markdownToTelegramHtml() converter renders tables as `<pre>` monospace
 * blocks. Uses sendHtmlOrPlain() to fall back to plain text if Telegram
 * rejects the assembled HTML (rare; usually means a `<` was missed by the
 * converter or a user-provided URL had unescaped chars).
 */

import {
  escapeHtml,
  markdownToTelegramHtml,
} from './markdownToHtml.js';
import type {
  FollowUpOption,
  OutgoingChoiceCard,
  OutgoingSlotPicker,
  SemanticAnswer,
} from './kernel-types.js';
import type { TelegramApiClient } from './telegramBot.js';

// ---------------------------------------------------------------------------
// callback_data tokenisation (Bot API caps callback_data at 64 bytes)
// ---------------------------------------------------------------------------

export interface PendingCallback {
  kind: 'choice' | 'slot' | 'follow_up';
  /** What we re-send to the orchestrator as the user's next message. */
  echo: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Inline-keyboard envelope (subset of Bot-API InlineKeyboardMarkup)
// ---------------------------------------------------------------------------

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

// ---------------------------------------------------------------------------
// MarkdownV2 escape (Bot-API-specific — 18 reserved chars).
//
// NOTE: Kept exported as a legacy helper — the renderer itself no longer
// uses MarkdownV2 (HTML mode + markdownToTelegramHtml are the active path
// since S+7.7). Available for any caller that explicitly needs MV2
// escape — e.g. a future dev tool or a strict-mode opt-in.
// ---------------------------------------------------------------------------

const MARKDOWN_V2_ESCAPES = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(input: string): string {
  return input.replace(MARKDOWN_V2_ESCAPES, (m) => `\\${m}`);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class TelegramRenderer {
  private readonly pendingCallbacks = new Map<string, PendingCallback>();

  constructor(
    private readonly api: TelegramApiClient,
    private readonly pendingCallbackTtlMs: number,
  ) {}

  /**
   * Render a full answer: prose → attachments → interactive (one-shot,
   * SDK-contract caps this at one element per answer). Any SDK interactive
   * kind the channel can't render (today: `topic` — Telegram v1 has no
   * topic-detector UX) degrades to plain-text via the SDK's fallback
   * advice (render the question; list options as numbered text).
   */
  async renderAnswer(
    chatId: number,
    answer: SemanticAnswer,
  ): Promise<void> {
    if (answer.text.trim().length > 0) {
      await this.sendHtmlOrPlain(chatId, markdownToTelegramHtml(answer.text), {
        disable_web_page_preview: true,
      });
    }

    for (const att of answer.attachments ?? []) {
      const captionHtml = markdownToTelegramHtml(att.altText);
      const captionPlain = att.altText;
      try {
        await this.api.sendPhoto({
          chat_id: chatId,
          photo: att.url,
          caption: captionHtml,
          parse_mode: 'HTML',
        });
      } catch (err) {
        console.warn(
          `[telegram] sendPhoto failed (${att.url}): ${
            err instanceof Error ? err.message : String(err)
          } — falling back to sendDocument`,
        );
        try {
          await this.api.sendDocument({
            chat_id: chatId,
            document: att.url,
            caption: captionHtml,
            parse_mode: 'HTML',
          });
        } catch (err2) {
          console.error(
            `[telegram] sendDocument fallback failed: ${err2 instanceof Error ? err2.message : String(err2)}`,
          );
        }
      }
      void captionPlain;
    }

    if (answer.interactive?.kind === 'choice') {
      await this.renderChoiceCard(chatId, answer.interactive);
    } else if (answer.interactive?.kind === 'slots') {
      await this.renderSlotPicker(chatId, answer.interactive);
    } else if (answer.followUps && answer.followUps.length > 0) {
      await this.renderFollowUps(chatId, answer.followUps);
    }
  }

  /** Orchestrator-failure fallback — rendered when ChatAgent.chat() throws. */
  async renderError(chatId: number, detail: string): Promise<void> {
    const html =
      '<b>Entschuldigung</b>, beim Verarbeiten deiner Anfrage ist ein Fehler aufgetreten: ' +
      `<code>${escapeHtml(detail)}</code>. Versuch es gleich nochmal oder stell die Frage anders.`;
    await this.sendHtmlOrPlain(chatId, html);
  }

  /**
   * Send a message with `parse_mode: 'HTML'`, falling back to plain text
   * if Telegram rejects the entities (HTTP 400 with "can't parse"). Keeps
   * a downed user-facing reply from being completely lost when the
   * markdownToTelegramHtml converter slips up on something exotic.
   */
  private async sendHtmlOrPlain(
    chatId: number,
    html: string,
    extra: { disable_web_page_preview?: boolean; reply_markup?: InlineKeyboardMarkup } = {},
  ): Promise<void> {
    try {
      await this.api.sendMessage({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        ...extra,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/can'?t parse|parse entities|Bad Request/i.test(msg)) throw err;
      console.warn(
        `[telegram] HTML parse rejected by Telegram → retrying as plain text. detail=${msg}`,
      );
      // Strip tags + decode the 3 entities. Crude but safe enough for a
      // last-resort fallback — readers see prose, lose formatting.
      const plain = html
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');
      await this.api.sendMessage({
        chat_id: chatId,
        text: plain,
        ...extra,
      });
    }
  }

  /** Resolve an incoming callback_query's token into the stashed echo payload. */
  takePendingCallback(
    chatId: number,
    token: string | undefined,
  ): PendingCallback | undefined {
    if (!token) return undefined;
    const key = callbackKey(chatId, token);
    const hit = this.pendingCallbacks.get(key);
    if (!hit) return undefined;
    this.pendingCallbacks.delete(key);
    if (hit.expiresAt < Date.now()) return undefined;
    return hit;
  }

  private async renderChoiceCard(
    chatId: number,
    choice: OutgoingChoiceCard,
  ): Promise<void> {
    const buttons: InlineKeyboardButton[][] = choice.options.map((opt) => [
      {
        text: opt.label,
        callback_data: this.registerCallback(chatId, {
          kind: 'choice',
          echo: opt.value,
        }),
      },
    ]);
    const lines = [`<b>${escapeHtml(choice.question)}</b>`];
    if (choice.rationale) {
      lines.push('', escapeHtml(choice.rationale));
    }
    await this.sendHtmlOrPlain(chatId, lines.join('\n'), {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  private async renderSlotPicker(
    chatId: number,
    card: OutgoingSlotPicker,
  ): Promise<void> {
    const buttons: InlineKeyboardButton[][] = card.slots.map((slot) => [
      {
        text: slot.label,
        callback_data: this.registerCallback(chatId, {
          kind: 'slot',
          echo: `Bitte buche den Slot ${slot.slotId} (${slot.label}).`,
        }),
      },
    ]);
    const lines = [`<b>${escapeHtml(card.question)}</b>`];
    if (card.subjectHint) {
      lines.push('', `<i>${escapeHtml(card.subjectHint)}</i>`);
    }
    await this.sendHtmlOrPlain(chatId, lines.join('\n'), {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  private async renderFollowUps(
    chatId: number,
    options: FollowUpOption[],
  ): Promise<void> {
    const buttons: InlineKeyboardButton[][] = options
      .slice(0, 5)
      .map((opt) => [
        {
          text: opt.label,
          callback_data: this.registerCallback(chatId, {
            kind: 'follow_up',
            echo: opt.prompt,
          }),
        },
      ]);
    await this.sendHtmlOrPlain(chatId, '<i>Vorschläge:</i>', {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  private registerCallback(
    chatId: number,
    payload: Omit<PendingCallback, 'expiresAt'>,
  ): string {
    this.pruneExpired();
    const token = randomToken();
    this.pendingCallbacks.set(callbackKey(chatId, token), {
      ...payload,
      expiresAt: Date.now() + this.pendingCallbackTtlMs,
    });
    return token;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.pendingCallbacks) {
      if (value.expiresAt < now) this.pendingCallbacks.delete(key);
    }
  }
}

function callbackKey(chatId: number, token: string): string {
  return `${String(chatId)}:${token}`;
}

function randomToken(): string {
  // 8 hex chars = 4 bytes — well under the 64-byte callback_data cap and
  // collision-safe per-chat-lifetime.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
