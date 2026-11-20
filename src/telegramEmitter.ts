/**
 * The one way anything reaches a Telegram user (spec 2042 INV-4, §5.14,
 * criteria 5, 29, 30, 31).
 *
 * Every outgoing message of this channel goes through {@link TelegramEmitter}
 * and carries a speaker: an agent's answer (stamped by the kernel from the
 * routing decision; an answer without one is refused) or `system` (a notice of the management layer or of this
 * plugin). No other module calls `sendMessage`, `sendPhoto` or
 * `sendDocument`; `tests/telegramEmitterPaths.test.ts` fails when one does.
 *
 * Telegram is a plain-text channel. The text comes from the SDK's reference
 * renderer (`renderPlainAnswer`): a name line only where INV-4 asks for one,
 * colleagues' contributions as "Mira: ...", a `system` notice as its own text,
 * cards as numbered text. Nothing else is attached: no buttons, no reactions,
 * no footers, no follow-up lists. The only declared decoration this channel
 * renders is the AI disclosure line, which already is part of `answer.text`
 * according to the operator's frequency setting (#2087). Everything an
 * answer carries beyond that (verifier badge, consulted agents, disclaimer,
 * follow-ups) stays in the structured answer.
 *
 * A Telegram bot is one identity per installation, and several agents can
 * answer through it (selection by `/agent`), so the channel never claims a
 * native identity per agent: `nativeIdentity` is false.
 */

import {
  admitDecorations,
  renderPlainAnswer,
  type SpeakerHistoryStore,
} from '@omadia/channel-sdk';

import { markdownToTelegramHtml } from './markdownToHtml.js';
import type { SemanticAnswer } from './kernel-types.js';
import type { TelegramApiClient } from './telegramBot.js';

/** The channel type the decoration registry knows this channel by. */
export const TELEGRAM_DECORATION_CHANNEL = 'telegram';

/**
 * Every decoration this channel attaches to a message, by registry id. The
 * AI disclosure line is part of the answer text; nothing else is attached.
 * `admitDecorations` checks this list against the registry on every send, so
 * adding an undeclared id here fails closed.
 */
export const TELEGRAM_DECORATIONS: readonly { readonly id: string }[] = Object.freeze([
  { id: 'ai_disclosure_line' },
]);

/** What the emitter reports for each message it sent (tests, audit logging). */
export interface EmissionRecord {
  readonly chatId: number;
  readonly speaker: 'agent' | 'system';
  readonly kind: 'text' | 'photo' | 'document';
}

export interface SpeakerHistoryReader extends SpeakerHistoryStore {
  hydrate?(conversationKey: string): Promise<void>;
}

export interface TelegramEmitterOptions {
  readonly api: Pick<TelegramApiClient, 'sendMessage' | 'sendPhoto' | 'sendDocument'>;
  readonly speakerHistory: SpeakerHistoryReader;
  /** Called once per message sent. */
  readonly onEmit?: (record: EmissionRecord) => void;
}

export class TelegramEmitter {
  constructor(private readonly opts: TelegramEmitterOptions) {}

  /**
   * An agent's answer, or the management layer's notice when the answer's
   * speaker is `system`.
   */
  async sendAnswer(chatId: number, answer: SemanticAnswer): Promise<void> {
    if (answer.speaker?.kind === 'system') {
      await this.sendSystem(chatId, answer.systemNotice?.text ?? answer.text);
      return;
    }
    if (!answer.speaker) {
      // The bot withholds such an answer before it gets here; an emitter that
      // is handed one anyway refuses it rather than post a nameless message.
      throw new Error('telegram emitter: an answer without a speaker cannot be sent');
    }
    const speaker = 'agent';
    this.assertDecorationsDeclared();

    const conversationKey = conversationKeyOf(chatId);
    await this.opts.speakerHistory.hydrate?.(conversationKey);
    const text = renderPlainAnswer(answer, {
      nativeIdentity: false,
      conversationKey,
      speakerHistory: this.opts.speakerHistory,
    });
    if (text.trim().length > 0) {
      await this.sendHtmlOrPlain(chatId, markdownToTelegramHtml(text), speaker);
    }
    for (const attachment of answer.attachments ?? []) {
      await this.sendAttachment(chatId, attachment, speaker);
    }
  }

  /**
   * A message the kernel posts on an agent's behalf (conversation or targeted
   * send): the bot IS that agent's identity, so the text goes out as it is,
   * with no name line. Returns the Bot API `message_id` of the text, which a
   * posted question is matched by.
   */
  async sendPosted(
    chatId: number,
    message: { readonly text: string; readonly attachments?: SemanticAnswer['attachments'] },
  ): Promise<number | undefined> {
    this.assertDecorationsDeclared();
    const messageId =
      message.text.trim().length > 0
        ? await this.sendHtmlOrPlain(chatId, markdownToTelegramHtml(message.text), 'agent')
        : undefined;
    for (const attachment of message.attachments ?? []) {
      await this.sendAttachment(chatId, attachment, 'agent');
    }
    return messageId;
  }

  /**
   * A notice with speaker `system`: the management layer's or this plugin's
   * own (pairing, group activation, errors). Plain text, never an agent's
   * name, never markup.
   */
  async sendSystem(chatId: number, text: string): Promise<void> {
    await this.opts.api.sendMessage({ chat_id: chatId, text });
    this.opts.onEmit?.({ chatId, speaker: 'system', kind: 'text' });
  }

  private async sendAttachment(
    chatId: number,
    attachment: NonNullable<SemanticAnswer['attachments']>[number],
    speaker: EmissionRecord['speaker'],
  ): Promise<void> {
    const caption = markdownToTelegramHtml(attachment.altText);
    try {
      await this.opts.api.sendPhoto({
        chat_id: chatId,
        photo: attachment.url,
        caption,
        parse_mode: 'HTML',
      });
      this.opts.onEmit?.({ chatId, speaker, kind: 'photo' });
      return;
    } catch (err) {
      console.warn(
        `[telegram] sendPhoto failed (${attachment.url}): ${errorMessage(err)} — falling back to sendDocument`,
      );
    }
    try {
      await this.opts.api.sendDocument({
        chat_id: chatId,
        document: attachment.url,
        caption,
        parse_mode: 'HTML',
      });
      this.opts.onEmit?.({ chatId, speaker, kind: 'document' });
    } catch (err) {
      console.error(`[telegram] sendDocument fallback failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Send with `parse_mode: 'HTML'`, falling back to plain text when Telegram
   * rejects the entities, so an answer is never lost to a converter slip.
   */
  private async sendHtmlOrPlain(
    chatId: number,
    html: string,
    speaker: EmissionRecord['speaker'],
  ): Promise<number> {
    let sent: { message_id: number };
    try {
      sent = await this.opts.api.sendMessage({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err) {
      const msg = errorMessage(err);
      if (!/can'?t parse|parse entities|Bad Request/i.test(msg)) throw err;
      console.warn(
        `[telegram] HTML parse rejected by Telegram → retrying as plain text. detail=${msg}`,
      );
      sent = await this.opts.api.sendMessage({
        chat_id: chatId,
        text: stripHtml(html),
        disable_web_page_preview: true,
      });
    }
    this.opts.onEmit?.({ chatId, speaker, kind: 'text' });
    return sent.message_id;
  }

  private assertDecorationsDeclared(): void {
    const { refused } = admitDecorations(TELEGRAM_DECORATION_CHANNEL, TELEGRAM_DECORATIONS, (r) =>
      console.error(`[telegram] decoration ${r.id} refused by the registry (${r.reason})`),
    );
    if (refused.length > 0) {
      throw new Error(
        `undeclared decoration(s) for telegram: ${refused.map((r) => r.id).join(', ')}`,
      );
    }
  }
}

/** The notice shown when the agent call itself failed and no answer exists. */
export function failureNoticeText(detail: string): string {
  return `Entschuldigung, beim Verarbeiten deiner Anfrage ist ein Fehler aufgetreten: ${detail}. Versuch es gleich nochmal oder stell die Frage anders.`;
}

export function conversationKeyOf(chatId: number): string {
  return `telegram:${String(chatId)}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
