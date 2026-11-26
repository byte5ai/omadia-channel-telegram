/**
 * byte5ai/omadia#1993 — an agent's file reaches the chat as an upload when
 * the kernel can read it; a foreign URL goes by URL; a file that arrives in
 * no way is named to the person and noted in the history.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { TelegramApiClient, TelegramEmitter, attachmentReaderOf, type AttachmentReadResult } from '@omadia/channel-telegram';

import { harness, privateText, recordingApi, speakerA } from './fakes.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function rig(
  read: (url: string) => AttachmentReadResult,
  opts: { urlFails?: boolean; photoUploadFails?: boolean; captionHtmlFails?: boolean } = {},
) {
  const base = recordingApi();
  const uploads: Array<{ method: string; fileName: string; mediaType?: string; size: number }> = [];
  const failing = async () => {
    throw new Error('Bad Request: failed to get HTTP URL content');
  };
  const api = {
    ...base.client,
    ...(opts.urlFails ? { sendPhoto: failing, sendDocument: failing } : {}),
    uploadPhoto: async (p: { file: { fileName: string; mediaType?: string; bytes: Uint8Array } }) => {
      if (opts.photoUploadFails) throw new Error('Bad Request: IMAGE_PROCESS_FAILED');
      uploads.push({ method: 'photo', fileName: p.file.fileName, mediaType: p.file.mediaType, size: p.file.bytes.byteLength });
      return { message_id: 900 };
    },
    uploadDocument: async (p: { file: { fileName: string; mediaType?: string; bytes: Uint8Array }; parse_mode?: string; caption?: string }) => {
      if (opts.captionHtmlFails && p.parse_mode === 'HTML') throw new Error("Bad Request: can't parse entities: unsupported start tag");
      uploads.push({ method: 'document', fileName: p.file.fileName, mediaType: p.file.mediaType, size: p.file.bytes.byteLength });
      return { message_id: 901 };
    },
  };
  const h = harness({ api: api as never, readAttachment: async (url: string) => read(url) });
  return { h, uploads, base };
}

describe('#1993 — outgoing files', () => {
  it('a kernel file (xlsx) is uploaded as a document, never sent by URL', async () => {
    const { h, uploads, base } = rig(() => ({ ok: true, bytes: new Uint8Array(6150), mediaType: XLSX, fileName: 'p08-drei.xlsx' }));
    h.answers.push({
      text: 'Hier ist deine Datei.',
      speaker: speakerA,
      attachments: [{ url: 'http://localhost:8080/documents/dl/abc', altText: 'p08-drei.xlsx', kind: 'file' } as never],
    });
    await h.bot.handleUpdate(privateText('xlsx bitte'));
    assert.deepEqual(uploads, [{ method: 'document', fileName: 'p08-drei.xlsx', mediaType: XLSX, size: 6150 }]);
    assert.ok(base.sent.every((s) => s.method === 'sendMessage'), 'no by-URL send');
  });

  it('a kernel PNG is uploaded as a photo', async () => {
    const { h, uploads } = rig(() => ({ ok: true, bytes: new Uint8Array(1000), mediaType: 'image/png' }));
    h.answers.push({
      text: 'Diagramm:',
      speaker: speakerA,
      attachments: [{ url: 'http://localhost:8080/diagrams/dl/d1.png', altText: 'Ablauf', kind: 'image' } as never],
    });
    await h.bot.handleUpdate(privateText('zeichne'));
    assert.deepEqual(uploads.map((u) => [u.method, u.fileName]), [['photo', 'd1.png']]);
  });

  it('a foreign URL is still sent by URL', async () => {
    const { h, uploads, base } = rig(() => ({ ok: false, reason: 'not_kernel_attachment' }));
    h.answers.push({
      text: 'Bild',
      speaker: speakerA,
      attachments: [{ url: 'https://example.test/a.png', altText: 'a', kind: 'image' } as never],
    });
    await h.bot.handleUpdate(privateText('zeig'));
    assert.equal(uploads.length, 0);
    assert.equal(base.sent.at(-1)?.method, 'sendPhoto');
  });

  it('a file that arrives in no way: the person is told, the history says so', async () => {
    const { h, base } = rig(() => ({ ok: false, reason: 'not_kernel_attachment' }), { urlFails: true });
    h.answers.push({
      text: 'Hier ist deine Datei.',
      speaker: speakerA,
      attachments: [{ url: 'https://files.example.test/x/bericht.docx', altText: 'bericht.docx', kind: 'file' } as never],
    });
    await h.bot.handleUpdate(privateText('docx', 5));
    const texts = base.sent.map((s) => String(s.params['text'] ?? ''));
    assert.match(texts.at(-1)!, /Die Datei „bericht\.docx“ konnte nicht zugestellt werden\./);
    await h.bot.handleUpdate(privateText('und?', 5));
    const history = JSON.stringify(h.turns.at(-1));
    assert.match(history, /attachment not delivered: \\"bericht\.docx\\"/);
  });

  it('a kernel file that cannot be read is not sent by URL and is named as missing', async () => {
    const { h, base, uploads } = rig(() => ({ ok: false, reason: 'not_found' }));
    h.answers.push({
      text: 'Datei',
      speaker: speakerA,
      attachments: [{ url: 'http://localhost:8080/documents/dl/gone.pdf', altText: 'gone', kind: 'file' } as never],
    });
    await h.bot.handleUpdate(privateText('pdf'));
    assert.equal(uploads.length, 0);
    assert.ok(base.sent.every((s) => s.method === 'sendMessage'));
    assert.match(String(base.sent.at(-1)?.params['text']), /gone\.pdf/);
  });

  it('the missing file is named by its alt text, not by an opaque URL segment', async () => {
    const { h, base } = rig(() => ({ ok: false, reason: 'not_found' }));
    h.answers.push({
      text: 'Datei',
      speaker: speakerA,
      attachments: [{ url: 'http://localhost:8080/documents/dl/abc', altText: 'p08-drei.xlsx', kind: 'file' } as never],
    });
    await h.bot.handleUpdate(privateText('x'));
    assert.match(String(base.sent.at(-1)?.params['text']), /„p08-drei\.xlsx“/);
  });

  it('a failed photo upload falls back to a document upload; a PNG over 10 MB is a document', async () => {
    const small = rig(() => ({ ok: true, bytes: new Uint8Array(100), mediaType: 'image/png' }), { photoUploadFails: true });
    small.h.answers.push({ text: 'a', speaker: speakerA, attachments: [{ url: 'http://k/diagrams/dl/a.png', altText: 'a', kind: 'image' } as never] });
    await small.h.bot.handleUpdate(privateText('a'));
    assert.deepEqual(small.uploads.map((u) => u.method), ['document']);
    const big = rig(() => ({ ok: true, bytes: new Uint8Array(10 * 1024 * 1024 + 1), mediaType: 'image/png' }));
    big.h.answers.push({ text: 'b', speaker: speakerA, attachments: [{ url: 'http://k/diagrams/dl/b.png', altText: 'b', kind: 'image' } as never] });
    await big.h.bot.handleUpdate(privateText('b'));
    assert.deepEqual(big.uploads.map((u) => u.method), ['document']);
  });

  it('a caption Telegram cannot parse is retried as plain text instead of losing the file', async () => {
    const { h, uploads, base } = rig(() => ({ ok: true, bytes: new Uint8Array(10), mediaType: 'application/pdf', fileName: 'x.pdf' }), {
      captionHtmlFails: true,
    });
    h.answers.push({ text: 't', speaker: speakerA, attachments: [{ url: 'http://k/documents/dl/x', altText: '**x**', kind: 'file' } as never] });
    await h.bot.handleUpdate(privateText('t'));
    assert.deepEqual(uploads.map((u) => u.fileName), ['x.pdf']);
    assert.ok(!base.sent.some((s) => /nicht zugestellt/.test(String(s.params['text']))));
  });

  it('a proactive post with a missing file still posts its text and names the file', async () => {
    const base = recordingApi();
    const emitter = new TelegramEmitter({
      api: base.client,
      speakerHistory: { get: () => undefined, set: () => undefined } as never,
      readAttachment: async () => ({ ok: false, reason: 'too_large' }),
    });
    const id = await emitter.sendPosted(42, {
      text: 'Bericht anbei',
      attachments: [{ url: 'http://k/documents/dl/r', altText: 'report.pdf', kind: 'file' } as never],
    });
    assert.equal(id, 1);
    assert.match(String(base.sent.at(-1)?.params['text']), /„report\.pdf“ konnte nicht zugestellt werden/);
  });

  it('the upload is multipart with chat_id, caption, parse_mode and the named file', async () => {
    const original = globalThis.fetch;
    let seen: { url: string; form: FormData } | undefined;
    globalThis.fetch = (async (url: string, init: { body: FormData }) => {
      seen = { url, form: init.body };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    }) as never;
    try {
      const api = new TelegramApiClient('123:abc');
      await api.uploadDocument({
        chat_id: 5,
        file: { bytes: new Uint8Array([1, 2, 3]), fileName: 'a.xlsx', mediaType: 'application/x' },
        caption: 'c',
        parse_mode: 'HTML',
      });
    } finally {
      globalThis.fetch = original;
    }
    assert.match(seen!.url, /\/sendDocument$/);
    assert.equal(seen!.form.get('chat_id'), '5');
    assert.equal(seen!.form.get('caption'), 'c');
    assert.equal(seen!.form.get('parse_mode'), 'HTML');
    const file = seen!.form.get('document') as File;
    assert.equal(file.name, 'a.xlsx');
    assert.equal(file.size, 3);
  });

  it('the reader is feature-detected and a throwing kernel counts as a failed read', async () => {
    assert.equal(attachmentReaderOf({}), undefined);
    const reader = attachmentReaderOf({ readAttachment: async () => { throw new Error('boom'); } });
    assert.deepEqual(await reader!('http://x/y'), { ok: false, reason: 'failed' });
  });
});
