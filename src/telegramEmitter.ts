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
 * The installation's own bot is shared: several agents answer through it
 * (selection by `/agent`), so it never claims a native identity and shows a
 * name line where the speaker would be unclear. An agent's own bot (spec 2042
 * §5.3) IS that agent: `nativeIdentity` is true and no name line is shown.
 */

import {
  admitDecorations,
  renderPlainAnswer,
  type SpeakerHistoryStore,
} from '@omadia/channel-sdk';

import { markdownToTelegramHtml } from './markdownToHtml.js';
import { splitForTelegram, splitPlainText } from './messageSplit.js';
import {
  MAX_CAPTION_SOURCE_LENGTH,
  attachmentFileName,
  attachmentsMissingText,
  isPhotoUpload,
  type AttachmentReader,
} from './attachmentDelivery.js';
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
  readonly api: Pick<TelegramApiClient, 'sendMessage' | 'sendPhoto' | 'sendDocument'> &
    Partial<Pick<TelegramApiClient, 'uploadPhoto' | 'uploadDocument'>>;
  /**
   * The kernel's attachment read seam (#1993). Absent on older kernels: then
   * every attachment is sent by URL, as before.
   */
  readonly readAttachment?: AttachmentReader;
  readonly speakerHistory: SpeakerHistoryReader;
  /** Called once per message sent. */
  readonly onEmit?: (record: EmissionRecord) => void;
  /**
   * Spec 2042 §5.3 — this bot IS one agent (its own bot): the client shows
   * the bot's name, so no answer ever needs a name line.
   */
  readonly nativeIdentity?: boolean;
}

/** What a sent answer reports back: the attachments that did not arrive (#1993). */
export interface AnswerDelivery {
  readonly missingAttachments: readonly string[];
}

const NOTHING_MISSING: AnswerDelivery = Object.freeze({ missingAttachments: Object.freeze([]) });

export class TelegramEmitter {
  constructor(private readonly opts: TelegramEmitterOptions) {}

  /**
   * An agent's answer, or the management layer's notice when the answer's
   * speaker is `system`.
   */
  async sendAnswer(chatId: number, answer: SemanticAnswer): Promise<AnswerDelivery> {
    if (answer.speaker?.kind === 'system') {
      await this.sendSystem(chatId, answer.systemNotice?.text ?? answer.text);
      return NOTHING_MISSING;
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
      nativeIdentity: this.opts.nativeIdentity === true,
      conversationKey,
      speakerHistory: this.opts.speakerHistory,
    });
    await this.sendText(chatId, text, speaker);
    // Attachments follow the last part of the text.
    return { missingAttachments: await this.sendAttachments(chatId, answer.attachments, speaker) };
  }

  /**
   * A message the kernel posts on an agent's behalf (conversation or targeted
   * send): the bot IS that agent's identity, so the text goes out as it is,
   * with no name line. Returns the Bot API `message_id` of the text (of its
   * last part when it was split: that is where a question ends), which a
   * posted question is matched by.
   */
  async sendPosted(
    chatId: number,
    message: { readonly text: string; readonly attachments?: SemanticAnswer['attachments'] },
  ): Promise<number | undefined> {
    this.assertDecorationsDeclared();
    const messageId = await this.sendText(chatId, message.text, 'agent');
    await this.sendAttachments(chatId, message.attachments, 'agent');
    return messageId;
  }

  /**
   * A notice with speaker `system`: the management layer's or this plugin's
   * own (pairing, group activation, errors). Plain text, never an agent's
   * name, never markup.
   */
  async sendSystem(chatId: number, text: string): Promise<void> {
    for (const part of splitPlainText(text)) {
      await this.opts.api.sendMessage({ chat_id: chatId, text: part });
      this.opts.onEmit?.({ chatId, speaker: 'system', kind: 'text' });
    }
  }

  /**
   * Markdown text as one or more messages, each within Telegram's length
   * limit (#1989). Returns the `message_id` of the last part, or undefined
   * when there was no text.
   */
  private async sendText(
    chatId: number,
    markdown: string,
    speaker: EmissionRecord['speaker'],
  ): Promise<number | undefined> {
    let lastId: number | undefined;
    for (const html of splitForTelegram(markdown, markdownToTelegramHtml)) {
      lastId = await this.sendHtmlOrPlain(chatId, html, speaker);
    }
    return lastId;
  }

  /**
   * Every attachment, in order. Returns the names of those that did not
   * arrive; the person has been told about them in one notice (#1993).
   */
  private async sendAttachments(
    chatId: number,
    attachments: SemanticAnswer['attachments'],
    speaker: EmissionRecord['speaker'],
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const attachment of attachments ?? []) {
      const sent = await this.sendAttachment(chatId, attachment, speaker);
      if (!sent.delivered) missing.push(sent.name);
    }
    if (missing.length > 0) {
      // The send contract has no "partly delivered": the text did go out, so a
      // proactive send still reports delivered. The log and the notice say
      // which files are missing.
      console.warn(`[telegram] chat=${String(chatId)}: ${String(missing.length)} attachment(s) not delivered: ${missing.join(', ')}`);
      try {
        await this.sendSystem(chatId, attachmentsMissingText(missing));
      } catch (err) {
        console.error(`[telegram] notice about undelivered attachments failed: ${errorMessage(err)}`);
      }
    }
    return missing;
  }

  /**
   * One attachment: uploaded when the kernel can read it, by URL when the
   * URL is not the kernel's. Returns whether it arrived.
   */
  private async sendAttachment(
    chatId: number,
    attachment: NonNullable<SemanticAnswer['attachments']>[number],
    speaker: EmissionRecord['speaker'],
  ): Promise<{ readonly delivered: boolean; readonly name: string }> {
    const caption = markdownToTelegramHtml(attachment.altText.slice(0, MAX_CAPTION_SOURCE_LENGTH));
    const read = this.opts.readAttachment ? await this.opts.readAttachment(attachment.url) : undefined;
    const name = attachmentFileName(attachment.url, read?.ok ? read.fileName : undefined, attachment.altText);
    if (read?.ok) return { name, delivered: await this.uploadAttachment(chatId, attachment.url, read, caption, speaker) };
    if (read && read.reason !== 'not_kernel_attachment') {
      console.error(`[telegram] attachment not readable from the kernel (${read.reason}): ${attachment.url}`);
      return { name, delivered: false };
    }
    return { name, delivered: await this.sendAttachmentByUrl(chatId, attachment.url, caption, speaker) };
  }

  private async uploadAttachment(
    chatId: number,
    url: string,
    read: Extract<Awaited<ReturnType<AttachmentReader>>, { ok: true }>,
    caption: string,
    speaker: EmissionRecord['speaker'],
  ): Promise<boolean> {
    const { uploadPhoto, uploadDocument } = this.opts.api;
    if (!uploadPhoto || !uploadDocument) return this.sendAttachmentByUrl(chatId, url, caption, speaker);
    const file = {
      bytes: read.bytes,
      fileName: attachmentFileName(url, read.fileName),
      ...(read.mediaType ? { mediaType: read.mediaType } : {}),
    };
    if (isPhotoUpload(read.mediaType, read.bytes.byteLength)) {
      try {
        await withPlainCaptionRetry(caption, (c) => uploadPhoto.call(this.opts.api, { chat_id: chatId, file, ...c }));
        this.opts.onEmit?.({ chatId, speaker, kind: 'photo' });
        return true;
      } catch (err) {
        console.warn(`[telegram] photo upload failed (${file.fileName}): ${errorMessage(err)} — sending as a document`);
      }
    }
    try {
      await withPlainCaptionRetry(caption, (c) => uploadDocument.call(this.opts.api, { chat_id: chatId, file, ...c }));
      this.opts.onEmit?.({ chatId, speaker, kind: 'document' });
      return true;
    } catch (err) {
      console.error(`[telegram] document upload failed (${file.fileName}): ${errorMessage(err)}`);
      return false;
    }
  }

  private async sendAttachmentByUrl(
    chatId: number,
    url: string,
    caption: string,
    speaker: EmissionRecord['speaker'],
  ): Promise<boolean> {
    try {
      await withPlainCaptionRetry(caption, (c) => this.opts.api.sendPhoto({ chat_id: chatId, photo: url, ...c }));
      this.opts.onEmit?.({ chatId, speaker, kind: 'photo' });
      return true;
    } catch (err) {
      console.warn(`[telegram] sendPhoto failed (${url}): ${errorMessage(err)} — falling back to sendDocument`);
    }
    try {
      await withPlainCaptionRetry(caption, (c) => this.opts.api.sendDocument({ chat_id: chatId, document: url, ...c }));
      this.opts.onEmit?.({ chatId, speaker, kind: 'document' });
      return true;
    } catch (err) {
      console.error(`[telegram] sendDocument fallback failed: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * Send with `parse_mode: 'HTML'`, falling back to plain text when Telegram
   * rejects the entities, so an answer is never lost to a converter slip.
   * Only an entity error falls back: any other refusal ("message is too
   * long", a blocked chat) is not cured by plain text and is thrown.
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
      if (!isEntityParseError(msg)) throw err;
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

/**
 * Send with the HTML caption; when Telegram refuses its entities, once more
 * with the caption as plain text, so a caption never costs the file.
 */
async function withPlainCaptionRetry<T>(
  html: string,
  send: (caption: { caption: string; parse_mode?: 'HTML' }) => Promise<T>,
): Promise<T> {
  try {
    return await send({ caption: html, parse_mode: 'HTML' });
  } catch (err) {
    if (!isEntityParseError(errorMessage(err))) throw err;
    console.warn(`[telegram] caption HTML rejected → retrying with a plain caption. detail=${errorMessage(err)}`);
    return await send({ caption: stripHtml(html) });
  }
}

/** Telegram's answer to HTML it cannot parse ("can't parse entities: ..."). */
export function isEntityParseError(message: string): boolean {
  return /can'?t parse entities|can'?t find end of the entity|unsupported start tag|unexpected end tag/i.test(message);
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
