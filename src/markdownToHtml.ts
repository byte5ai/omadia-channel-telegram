/**
 * Convert orchestrator-emitted CommonMark/GFM-ish markdown into the
 * narrow HTML subset Telegram's Bot-API accepts under
 * `parse_mode: 'HTML'`.
 *
 * Supported HTML tags (whitelist):
 *   <b>, <strong>, <i>, <em>, <u>, <s>, <code>, <pre>, <a href="…">,
 *   <blockquote>
 * Anything else gets text-escaped (`<`, `>`, `&` → entities).
 *
 * Rendering rules
 * - Tables (CommonMark `| a | b |` + `|---|---|` + body): rendered as
 *   `<pre>` blocks with manual column padding (Telegram has NO native
 *   table support; monospace-aligned text is the closest we get).
 * - Lists (`-` / `*` at start of line): bullet glyph `• `.
 * - Headings (`#…` at start of line): wrapped in `<b>` (Telegram has no
 *   heading tag; bold-only is the visual approximation).
 * - Bold `**text**` / `__text__`: `<b>text</b>`.
 * - Italic `*text*` / `_text_`: `<i>text</i>` (only when not part of `**`/`__`).
 * - Inline code `` `code` ``: `<code>code</code>`.
 * - Fenced code ``` ```lang…``` ```: `<pre>…</pre>`.
 * - Links `[label](url)`: `<a href="url">label</a>`.
 * - Strikethrough `~~text~~`: `<s>text</s>` (GFM extension).
 *
 * Caller responsibility: this is meant for orchestrator-produced text
 * which is "trusted" prose with markdown formatting. For user-supplied
 * raw text that must be rendered as-is (no markdown processing), call
 * {@link escapeHtml} directly.
 */

const HTML_ENTITY_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>]/g, (c) => HTML_ENTITY_MAP[c] ?? c);
}

/**
 * URL-attribute escape — Telegram is strict about double-quotes inside
 * the href attribute. We also strip control characters and validate the
 * scheme (only http/https/mailto/tg allowed) to avoid `javascript:`-style
 * smuggling from upstream LLMs.
 */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!/^(https?:|mailto:|tg:)/i.test(trimmed)) return null;
  // Strip control characters (ASCII 0x00-0x1F + 0x7F DEL) via codepoint
  // loop — keeps eslint's no-control-regex rule happy without an inline
  // disable.
  const out = trimmed.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  let cleaned = '';
  for (const ch of out) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) continue;
    cleaned += ch;
  }
  return cleaned;
}

export function markdownToTelegramHtml(input: string): string {
  if (!input) return '';

  // ---------------------------------------------------------------------
  // Step 1 — extract fenced code blocks BEFORE escaping anything else.
  // We don't want `**bold**` inside a code block to turn into <b>; we
  // also don't want HTML-escaping to mangle the literal source. Replace
  // each fence with a placeholder, restore at the very end.
  // ---------------------------------------------------------------------
  const codeBlocks: string[] = [];
  let working = input.replace(
    /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g,
    (_match, _lang, code: string) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n+$/, ''))}</pre>`);
      return ` FENCE${idx} `;
    },
  );

  // Inline code `…` likewise — placeholders so emphasis regex doesn't
  // accidentally split on `*` inside a code span.
  const inlineCode: string[] = [];
  working = working.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return ` ICODE${idx} `;
  });

  // ---------------------------------------------------------------------
  // Step 2 — base HTML escape on the rest of the text.
  // After this, `<` `>` `&` are entities; markdown sigils (`*`, `_`,
  // `[`, `(`, `|`, `#`, `-`, `~`) are still raw and parseable.
  // ---------------------------------------------------------------------
  working = escapeHtml(working);

  // ---------------------------------------------------------------------
  // Step 3 — tables (CommonMark style with leading + trailing `|`).
  // ---------------------------------------------------------------------
  working = renderTables(working);

  // ---------------------------------------------------------------------
  // Step 4 — links: [label](url). Skip when href fails the scheme check.
  // ---------------------------------------------------------------------
  working = working.replace(
    /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    (match, label: string, url: string) => {
      const href = safeHref(url);
      if (!href) return match; // leave as plain text — bad link
      return `<a href="${href}">${label}</a>`;
    },
  );

  // ---------------------------------------------------------------------
  // Step 5 — emphasis. Bold MUST run before italic so `**…**` doesn't
  // get mis-parsed as two `*…*` spans.
  // ---------------------------------------------------------------------
  working = working.replace(
    /\*\*([^\n*][^\n]*?)\*\*/g,
    (_match, inner: string) => `<b>${inner}</b>`,
  );
  working = working.replace(
    /__([^\n_][^\n]*?)__/g,
    (_match, inner: string) => `<b>${inner}</b>`,
  );
  // Italic — single `*` / `_`. Must NOT match inside an existing <b>.
  // Using a lookbehind/lookahead to require non-`*`/`_` neighbours.
  working = working.replace(
    /(^|[^*])\*([^\s*][^*\n]*?)\*(?!\*)/g,
    (_match, lead: string, inner: string) => `${lead}<i>${inner}</i>`,
  );
  working = working.replace(
    /(^|[^_])_([^\s_][^_\n]*?)_(?!_)/g,
    (_match, lead: string, inner: string) => `${lead}<i>${inner}</i>`,
  );

  // Strikethrough (GFM)
  working = working.replace(
    /~~([^\n~]+?)~~/g,
    (_match, inner: string) => `<s>${inner}</s>`,
  );

  // ---------------------------------------------------------------------
  // Step 6 — block-level: headings + bullets + blockquote.
  // ---------------------------------------------------------------------
  working = working.replace(
    /^#{1,6}\s+(.+)$/gm,
    (_match, heading: string) => `<b>${heading}</b>`,
  );
  working = working.replace(/^[ \t]*[-*][ \t]+/gm, '• ');
  working = working.replace(
    /^&gt;[ \t]?(.*)$/gm,
    (_match, text: string) => `<blockquote>${text}</blockquote>`,
  );

  // ---------------------------------------------------------------------
  // Step 7 — restore code-block placeholders.
  // ---------------------------------------------------------------------
  working = working.replace(/ FENCE(\d+) /g, (_m, idx: string) => {
    return codeBlocks[Number(idx)] ?? '';
  });
  working = working.replace(/ ICODE(\d+) /g, (_m, idx: string) => {
    return inlineCode[Number(idx)] ?? '';
  });

  return working;
}

// ---------------------------------------------------------------------------
// Table rendering: CommonMark/GFM table → <pre> with monospace alignment.
// Telegram has no native table support; this is the established workaround
// (used by OpenClaw + others). Column widths derived from the longest cell
// per column; a unicode-box-drawing separator is inserted between header
// and body.
// ---------------------------------------------------------------------------

interface ParsedTable {
  header: string[];
  rows: string[][];
}

function renderTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const tbl = tryParseTableAt(lines, i);
    if (tbl) {
      out.push(formatTable(tbl.parsed));
      i = tbl.nextIndex;
      continue;
    }
    out.push(lines[i] ?? '');
    i += 1;
  }
  return out.join('\n');
}

function tryParseTableAt(
  lines: string[],
  startIndex: number,
): { parsed: ParsedTable; nextIndex: number } | null {
  const headerLine = lines[startIndex];
  const sepLine = lines[startIndex + 1];
  if (!headerLine || !sepLine) return null;
  if (!isTableRow(headerLine) || !isTableSeparator(sepLine)) return null;

  const header = splitTableCells(headerLine);
  const rows: string[][] = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length && isTableRow(lines[cursor] ?? '')) {
    rows.push(splitTableCells(lines[cursor] ?? ''));
    cursor += 1;
  }
  if (rows.length === 0) return null;
  return { parsed: { header, rows }, nextIndex: cursor };
}

function isTableRow(line: string): boolean {
  // Must start AND end with `|` (CommonMark requires the pipes; we don't
  // try to parse the looser pipe-separated-without-borders variant —
  // false positives there are common, e.g. `a | b | c` in prose).
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 3;
}

function isTableSeparator(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = splitTableCells(line);
  return cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Mobile-friendly vertical-list table rendering. Telegram's `<pre>` blocks
 * don't horizontal-scroll on mobile — they wrap, which destroys the
 * column alignment that monospace was trying to provide. So we flip the
 * table to a per-row "heading + fields" stack.
 */
function formatTable(t: ParsedTable): string {
  const colCount = Math.max(
    t.header.length,
    ...t.rows.map((r) => r.length),
  );
  const cell = (row: string[] | undefined, i: number): string =>
    (row?.[i] ?? '').trim();

  // 2-column compact path: "<b>key:</b> value" lines (typical for "Posten / Tage" reports).
  if (colCount === 2) {
    const lines = t.rows.map((r) => `<b>${cell(r, 0)}:</b> ${cell(r, 1)}`);
    return lines.join('\n');
  }

  // Detect leading row-index column ("#", "Nr.", or blank header + 1/2/3
  // body values). When detected, the heading is "{n}. {col2}".
  const firstHeader = (t.header[0] ?? '').trim().toLowerCase();
  const firstColIsIndex =
    (firstHeader === '#' ||
      firstHeader === 'nr' ||
      firstHeader === 'nr.' ||
      firstHeader === '') &&
    t.rows.every((r, i) => {
      const v = cell(r, 0);
      return /^\d+$/.test(v) && Number(v) === i + 1;
    });

  const headingCol = firstColIsIndex ? 1 : 0;
  const fieldStartCol = headingCol + 1;

  const blocks: string[] = [];
  for (let rowIdx = 0; rowIdx < t.rows.length; rowIdx++) {
    const row = t.rows[rowIdx];
    const headingValue = cell(row, headingCol) || '—';
    const headingPrefix = firstColIsIndex ? `${String(rowIdx + 1)}. ` : '';
    const fieldLines: string[] = [];
    for (let c = fieldStartCol; c < t.header.length; c++) {
      const name = (t.header[c] ?? '').trim();
      const value = cell(row, c);
      if (!value) continue;
      fieldLines.push(`  <i>${name}:</i> ${value}`);
    }
    const block = `<b>${headingPrefix}${headingValue}</b>${
      fieldLines.length > 0 ? `\n${fieldLines.join('\n')}` : ''
    }`;
    blocks.push(block);
  }
  return blocks.join('\n\n');
}

