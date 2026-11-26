/**
 * Telegram refuses a message longer than 4096 characters (after entity
 * parsing), byte5ai/omadia#1989. An answer is cut into parts before it is
 * converted to HTML, so every part is valid HTML on its own: a cut never
 * falls inside a tag, and a fenced code block that spans a cut is closed at
 * the end of one part and opened again at the start of the next.
 *
 * Cuts prefer a paragraph break, then a line break, then a space; only a
 * single word longer than a part is cut hard.
 */

/** Telegram's limit for the text of one message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * The markdown budget per part. HTML escaping and tags make the converted
 * text longer than its source, so parts start well below the limit; a part
 * whose HTML still exceeds it is halved again.
 */
const MARKDOWN_PART_BUDGET = 3500;

/** Below this a part is not halved any more but cut at the limit. */
const MIN_PART_LENGTH = 64;

const FENCE = /^\s*```/;

/**
 * Split `markdown` into parts whose converted text stays within `limit`.
 * `convert` is the converter the parts are sent through (HTML, or identity
 * for plain text). Returns the converted parts, in order; an empty input
 * gives no parts.
 */
export function splitForTelegram(
  markdown: string,
  convert: (part: string) => string,
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (markdown.trim().length === 0) return [];
  const budget = Math.min(MARKDOWN_PART_BUDGET, limit);
  const parts: string[] = [];
  for (const part of packLines(markdown, budget)) {
    parts.push(...fitPart(part, convert, limit, 0));
  }
  // A part with markup but no visible text ("<pre></pre>") is refused by
  // Telegram ("message text is empty") and would cut off everything after it.
  return parts.filter((p) => visibleText(p).length > 0);
}

/** Split plain text (no markup) into parts of at most `limit` characters. */
export function splitPlainText(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  return splitForTelegram(text, identity, limit);
}

/** Halving stops here; what still does not fit is sent as escaped plain text. */
const MAX_HALVING_DEPTH = 8;

/**
 * Convert a part; halve it while its converted text is over the limit. A
 * part that does not shrink by halving (a long fence line is copied into
 * every half) or is still too long after {@link MAX_HALVING_DEPTH} rounds is
 * sent as escaped plain text in slices: valid HTML, nothing lost.
 */
function fitPart(part: string, convert: (part: string) => string, limit: number, depth: number): string[] {
  const converted = convert(part);
  if (converted.length <= limit) return [converted];
  if (part.length > MIN_PART_LENGTH && depth < MAX_HALVING_DEPTH) {
    const halves = packLines(part, Math.max(MIN_PART_LENGTH, Math.floor(part.length / 2)));
    if (halves.length > 1 && halves.every((h) => h.length < part.length)) {
      return halves.flatMap((h) => fitPart(h, convert, limit, depth + 1));
    }
  }
  return plainSlices(part, convert === identity ? identity : escapeForHtml, limit);
}

/** Cut `text` into slices whose escaped form stays within `limit`. */
function plainSlices(text: string, escape: (s: string) => string, limit: number): string[] {
  // An escaped character is at most 5 long ("&amp;").
  const step = escape === identity ? limit : Math.floor(limit / 5);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) out.push(escape(text.slice(i, i + step)));
  return out;
}

const identity = (part: string): string => part;

function escapeForHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The text a person would see: tags and entities removed. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;|&#\d+;/gi, 'x').trim();
}

/**
 * Pack the lines of `text` into parts of at most `budget` characters,
 * keeping fenced code blocks balanced in every part.
 */
function packLines(text: string, budget: number): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let openFence: string | undefined;
  let fenceAtPartStart: string | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    const body = current.join('\n');
    const closed = openFence !== undefined ? `${body}\n\`\`\`` : body;
    parts.push(closed);
    current = openFence !== undefined ? [openFence] : [];
    currentLength = openFence !== undefined ? openFence.length + 1 : 0;
    fenceAtPartStart = openFence;
  };

  for (const line of text.split('\n')) {
    for (const piece of cutLongLine(line, Math.max(1, budget - reserveFor(openFence)))) {
      const pieceLength = piece.length + 1;
      const isOnlyReopenedFence = fenceAtPartStart !== undefined && current.length === 1;
      if (currentLength + pieceLength > budget - reserveFor(openFence) && current.length > 0 && !isOnlyReopenedFence) {
        flush();
      }
      if (FENCE.test(piece) && openFence !== undefined && isOnlyReopenedFence) {
        // The block ends right after a cut: the part would be an empty code
        // block. Drop the reopened fence instead of closing an empty one.
        current = [];
        currentLength = 0;
        openFence = undefined;
        fenceAtPartStart = undefined;
        continue;
      }
      current.push(piece);
      currentLength += pieceLength;
      if (FENCE.test(piece)) {
        openFence = openFence === undefined ? fenceOpener(piece) : undefined;
      }
    }
    // Prefer to cut after a paragraph: an empty line is a good place to end.
    if (line.trim().length === 0 && currentLength > budget * 0.75) flush();
  }
  if (current.length > 0) {
    parts.push(current.join('\n'));
  }
  return parts;
}

/**
 * The fence as it is reopened after a cut: the backticks and the language
 * name only. Code on the fence line itself stays in the part it was in,
 * otherwise every half would carry it again.
 */
function fenceOpener(line: string): string {
  return /^\s*```[\w+#.-]*/.exec(line)?.[0].trim() ?? '```';
}

/** Room for the closing fence a part needs when it ends inside a code block. */
function reserveFor(openFence: string | undefined): number {
  return openFence !== undefined ? 4 : 0;
}

/** A line longer than `max` is cut at spaces, a single over-long word hard. */
function cutLongLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    const cut = space > max / 2 ? space : max;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}
