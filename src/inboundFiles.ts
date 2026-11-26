/**
 * Files the bot cannot read (byte5ai/omadia#1999). The channel reads text and
 * images (JPEG, PNG, GIF, WebP up to 5 MB). Everything else a person sends
 * (PDF, Office, HEIC, voice, video, stickers) is not silently dropped: the
 * person is told per file why it was not read, and the turn text carries a
 * note, so the agent does not answer as if the file had been seen.
 *
 * Reading PDF or Office files is a core topic (an attachment seam for
 * channels), not this plugin's.
 */

import type { SystemLocale } from './systemTexts.js';

export type UnreadableReason =
  | 'unsupported_file'
  | 'image_format'
  | 'too_large'
  | 'download_failed'
  | 'voice'
  | 'video'
  | 'sticker';

export type UnreadableKind = 'sticker' | 'voice' | 'audio' | 'video' | 'video_note' | 'animation' | 'file' | 'image';

export interface UnreadableFile {
  readonly kind: UnreadableKind;
  /** The file name, when Telegram reports one. */
  readonly name?: string;
  readonly reason: UnreadableReason;
  /** The MIME type, when known. */
  readonly mimeType?: string;
}

/** The parts of a message this channel never reads, besides text and images. */
export interface InboundFileFields {
  readonly document?: { readonly file_name?: string; readonly mime_type?: string };
  readonly voice?: unknown;
  readonly audio?: { readonly file_name?: string; readonly mime_type?: string };
  readonly video?: { readonly file_name?: string; readonly mime_type?: string };
  readonly video_note?: unknown;
  readonly animation?: unknown;
  readonly sticker?: unknown;
}

/** Files of `message` that are not text or an image: none of them is read. */
export function unreadableParts(message: InboundFileFields): UnreadableFile[] {
  const out: UnreadableFile[] = [];
  if (message.sticker) out.push({ kind: 'sticker', reason: 'sticker' });
  if (message.voice) out.push({ kind: 'voice', reason: 'voice' });
  if (message.audio) out.push(fileOf(message.audio, 'audio', 'voice'));
  if (message.video) out.push(fileOf(message.video, 'video', 'video'));
  if (message.video_note) out.push({ kind: 'video_note', reason: 'video' });
  // An animation (GIF) arrives with a `document` too; report it once.
  if (message.animation) {
    out.push({ kind: 'animation', reason: 'video' });
  } else if (message.document && !message.document.mime_type?.startsWith('image/')) {
    out.push(fileOf(message.document, 'file', 'unsupported_file'));
  }
  return out;
}

/** A file name is a label: longer ones are cut. */
const MAX_NAME_LENGTH = 120;
const MAX_MIME_LENGTH = 100;

/**
 * The sender chooses the file name and the declared MIME type, and both end
 * up in the turn text. Control characters and line breaks are removed and
 * brackets replaced, so a name cannot close the `[attachment ...]` note and
 * add text that reads as the channel's own.
 */
function cleanLabel(raw: string, max: number): string {
  let out = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x20 || cp === 0x7f || (cp >= 0x2028 && cp <= 0x2029) ? ' ' : ch;
  }
  return out.replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

export function fileOf(
  file: { readonly file_name?: string; readonly mime_type?: string },
  kind: UnreadableKind,
  reason: UnreadableReason,
): UnreadableFile {
  const name = file.file_name ? cleanLabel(file.file_name, MAX_NAME_LENGTH) : '';
  const mimeType = file.mime_type ? cleanLabel(file.mime_type, MAX_MIME_LENGTH) : '';
  return {
    kind,
    reason,
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

const KIND_LABELS: Readonly<Record<SystemLocale, Readonly<Record<UnreadableKind, string>>>> = {
  de: {
    sticker: 'Sticker',
    voice: 'Sprachnachricht',
    audio: 'Audiodatei',
    video: 'Video',
    video_note: 'Videonachricht',
    animation: 'Animation',
    file: 'Datei',
    image: 'Bild',
  },
  en: {
    sticker: 'Sticker',
    voice: 'Voice message',
    audio: 'Audio file',
    video: 'Video',
    video_note: 'Video message',
    animation: 'Animation',
    file: 'File',
    image: 'Image',
  },
};

function labelOf(file: UnreadableFile, locale: SystemLocale): string {
  return file.name ?? KIND_LABELS[locale][file.kind];
}

const REASONS: Readonly<Record<SystemLocale, Readonly<Record<UnreadableReason, string>>>> = {
  de: {
    unsupported_file: 'diesen Dateityp kann ich nicht lesen (nur Text und Bilder)',
    image_format: 'dieses Bildformat kann ich nicht lesen; schick es bitte als Foto statt als Datei',
    too_large: 'das Bild ist größer als 5 MB; schick es bitte als Foto statt als Datei',
    download_failed: 'die Datei konnte nicht von Telegram geladen werden',
    voice: 'Sprach- und Audionachrichten kann ich nicht anhören',
    video: 'Videos kann ich nicht ansehen',
    sticker: 'Sticker kann ich nicht lesen',
  },
  en: {
    unsupported_file: 'I cannot read this file type (only text and images)',
    image_format: 'I cannot read this image format; please send it as a photo instead of a file',
    too_large: 'the image is larger than 5 MB; please send it as a photo instead of a file',
    download_failed: 'the file could not be fetched from Telegram',
    voice: 'I cannot listen to voice or audio messages',
    video: 'I cannot watch videos',
    sticker: 'I cannot read stickers',
  },
};

/** The notice to the person: one line per file that was not read. */
export function unreadableNoticeText(files: readonly UnreadableFile[], locale: SystemLocale): string {
  const intro =
    locale === 'en'
      ? files.length === 1
        ? 'I could not read your attachment:'
        : 'I could not read these attachments:'
      : files.length === 1
        ? 'Deinen Anhang konnte ich nicht lesen:'
        : 'Diese Anhänge konnte ich nicht lesen:';
  const lines = files.map((f) => `• ${labelOf(f, locale)}: ${REASONS[locale][f.reason]}`);
  return [intro, ...lines].join('\n');
}

/** The note the turn text carries for the agent, one line per file. */
export function unreadableTurnNote(files: readonly UnreadableFile[]): string {
  return files
    .map((f) => `[attachment could not be read: "${labelOf(f, 'en')}"${f.mimeType ? ` (${f.mimeType})` : ''}: ${f.reason.replace(/_/g, ' ')}]`)
    .join('\n');
}
