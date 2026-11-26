/**
 * Getting an agent's file into a Telegram chat (byte5ai/omadia#1993).
 *
 * The kernel hands a channel an attachment as a URL. Telegram fetches a URL
 * only when it can reach it (never `localhost`) and, for `sendDocument`,
 * only for GIF, PDF and ZIP, so Office files never arrived by URL. A kernel
 * with the attachment read seam (`CoreApi.readAttachment`, channel-sdk
 * 0.3.16, omadia ADR-0222) gives the channel the bytes of a file it serves
 * itself; those are uploaded as multipart. A URL that is not the kernel's is
 * still sent by URL. When neither works the person is told which file is
 * missing, and the agent learns it through the turn history.
 */

/** What the kernel's `readAttachment` answers; it never throws. */
export type AttachmentReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mediaType?: string; readonly fileName?: string }
  | { readonly ok: false; readonly reason: 'not_kernel_attachment' | 'not_found' | 'too_large' | 'failed' };

export type AttachmentReader = (url: string) => Promise<AttachmentReadResult>;

/** The kernel's reader when it has one (feature-detected, older kernels have none). */
export function attachmentReaderOf(core: unknown): AttachmentReader | undefined {
  const read = (core as { readAttachment?: unknown } | null)?.readAttachment;
  if (typeof read !== 'function') return undefined;
  return async (url) => {
    try {
      return (await (read as AttachmentReader).call(core, url)) ?? { ok: false, reason: 'failed' };
    } catch {
      // The contract says it never throws; a kernel that does is a failed read.
      return { ok: false, reason: 'failed' };
    }
  };
}

/** Telegram's `sendPhoto` takes JPEG, PNG and WebP up to 10 MB; anything else is a document. */
const PHOTO_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function isPhotoUpload(mediaType: string | undefined, sizeBytes: number): boolean {
  return mediaType !== undefined && PHOTO_MEDIA_TYPES.has(mediaType.toLowerCase()) && sizeBytes <= MAX_PHOTO_BYTES;
}

/** Telegram's caption limit is 1024 characters after entity parsing. */
export const MAX_CAPTION_SOURCE_LENGTH = 900;

/** A label that reads like a file name ("bericht.docx"), not a sentence. */
const FILE_NAME_LIKE = /^[^\n/\\]{1,120}\.[A-Za-z0-9]{1,8}$/;

/**
 * The file's name for the upload and the notice: the kernel's, else an alt
 * text that is a file name, else the URL's last segment.
 */
export function attachmentFileName(url: string, stated?: string, altText?: string): string {
  if (stated && stated.trim()) return stated.trim();
  const alt = altText?.trim();
  if (alt && FILE_NAME_LIKE.test(alt)) return alt;
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // not a URL; fall through
  }
  return 'Datei';
}

/** The person's notice for files that did not arrive. */
export function attachmentsMissingText(names: readonly string[]): string {
  return names.length === 1
    ? `Die Datei „${names[0]!}“ konnte nicht zugestellt werden.`
    : `Diese Dateien konnten nicht zugestellt werden: ${names.map((n) => `„${n}“`).join(', ')}.`;
}

/** The note the turn history carries, so the agent does not believe the file arrived. */
export function attachmentsMissingNote(names: readonly string[]): string {
  return names.map((n) => `[attachment not delivered: "${n}"]`).join('\n');
}
