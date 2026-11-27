/**
 * byte5ai/omadia#2355 — the admin API uses the operator's omadia session on a
 * kernel that resolves it; the `telegram_admin_token` bearer is only the
 * fallback for older kernels. Cross-site writes are refused.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { createAdminAuth } from '@omadia/channel-telegram';

const COOKIE = 'omadia_session=valid';

async function serve(auth: ReturnType<typeof createAdminAuth>) {
  const app = express();
  app.use(auth);
  app.all('/x', (_req, res) => void res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('Telegram admin auth (omadia#2355)', () => {
  it('accepts the operator session and ignores a bearer token', async () => {
    const { base, close } = await serve(
      createAdminAuth({ operatorOf: async (c) => (c === COOKIE ? { email: 'op@example.com' } : null), adminToken: 't' }),
    );
    try {
      assert.equal((await fetch(`${base}/x`, { headers: { cookie: COOKIE } })).status, 200);
      const bearerOnly = await fetch(`${base}/x`, { headers: { authorization: 'Bearer t' } });
      assert.equal(bearerOnly.status, 401);
      assert.deepEqual(await bearerOnly.json(), { error: 'no_session', auth: 'session' });
    } finally {
      await close();
    }
  });

  it('refuses a cross-site write even with a session', async () => {
    const { base, close } = await serve(createAdminAuth({ operatorOf: async () => ({ email: 'op@example.com' }) }));
    try {
      const cross = await fetch(`${base}/x`, { method: 'POST', headers: { cookie: COOKIE, origin: 'https://evil.example' } });
      assert.equal(cross.status, 403);
      const same = await fetch(`${base}/x`, { method: 'POST', headers: { cookie: COOKIE, origin: base } });
      assert.equal(same.status, 200);
    } finally {
      await close();
    }
  });

  it('falls back to the bearer on a kernel without operator sessions', async () => {
    const { base, close } = await serve(createAdminAuth({ adminToken: 'secret-token' }));
    try {
      assert.equal((await fetch(`${base}/x`, { headers: { authorization: 'Bearer secret-token' } })).status, 200);
      const wrong = await fetch(`${base}/x`, { headers: { authorization: 'Bearer nope' } });
      assert.deepEqual(await wrong.json(), { error: 'unauthorized', auth: 'bearer' });
    } finally {
      await close();
    }
  });
});
