/**
 * byte5ai/omadia#1995 (ADR-0225 / ADR-0280) — a pairing links the Telegram
 * account to an omadia account through the kernel: the admin API asks the
 * kernel to offer the link, `/start <token>` redeems it for the sender.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  createTelegramAdminRouter,
  PairingStore,
  PairingTokenRegistry,
  type AccountLinks,
} from '@omadia/channel-telegram';

import { harness, memoryStore, privateText } from './fakes.js';

const ANNA = '7d1c2b3a-0000-4000-8000-00000000a001';
const COOKIE = 'omadia_session=valid';
const ADMIN_TOKEN = 'admin-token';

interface LinkCalls {
  offers: unknown[];
  redeems: unknown[];
  unlinks: unknown[];
}

function fakeLinks(opts: { redeemOk?: boolean } = {}): { links: AccountLinks; calls: LinkCalls } {
  const calls: LinkCalls = { offers: [], redeems: [], unlinks: [] };
  const links: AccountLinks = {
    listLinkableAccounts: async (cookie) =>
      cookie === COOKIE ? [{ userId: ANNA, displayName: 'Anna', email: 'anna@example.com' }] : null,
    offerLink: async (cookie, request) => {
      calls.offers.push({ cookie, ...request });
      if (cookie !== COOKIE) return { ok: false, reason: 'no_session' };
      if (request.userId !== ANNA) return { ok: false, reason: 'unknown_user' };
      return { ok: true, offerId: 'offer-1', account: { userId: ANNA, displayName: 'Anna' }, expiresAt: '2026-11-27T10:00:00Z' };
    },
    redeemLink: async (request) => {
      calls.redeems.push(request);
      return opts.redeemOk === false
        ? { ok: false, reason: 'unknown_offer' }
        : { ok: true, link: { userId: ANNA, displayName: 'Anna' } };
    },
    unlink: async (cookie, request) => {
      calls.unlinks.push({ cookie, ...request });
      return cookie === COOKIE ? { ok: true } : { ok: false, reason: 'no_session' };
    },
  };
  return { links, calls };
}

describe('#1995 — /start links the sender to the offered account', () => {
  it('redeems the offer for telegram:<id>, binds the DM as linked and says "connected"', async () => {
    const { links, calls } = fakeLinks();
    const pairingTokens = new PairingTokenRegistry();
    const token = pairingTokens.issue({ harnessIdentityId: ANNA, harnessIdentityLabel: 'Anna', linkOfferId: 'offer-1' });
    const h = harness({ dmPolicy: 'pairing', pairingTokens, accountLinks: links });
    await h.bot.handleUpdate(privateText(`/start ${token.token}`, 4711));
    assert.equal(calls.redeems.length, 1);
    const redeem = calls.redeems[0] as { channelType: string; channelUserId: string; offerId: string };
    assert.equal(redeem.channelType, 'telegram');
    assert.equal(redeem.channelUserId, 'telegram:4711');
    assert.equal(redeem.offerId, 'offer-1');
    const binding = await h.pairingStore.getDmBinding(4711);
    assert.equal(binding?.accountLinked, true);
    assert.equal(binding?.harnessIdentityId, ANNA);
    assert.match(String(h.api.sent.at(-1)?.params['text']), /mit dem omadia-Konto von Anna verbunden/);
    // The person can chat now, and the turn still carries the channel id.
    await h.bot.handleUpdate(privateText('Hallo', 4711));
    assert.equal(h.turns.at(-1)?.userId, 'telegram:4711');
  });

  it('a refused link pairs nothing and asks for a new link', async () => {
    const { links } = fakeLinks({ redeemOk: false });
    const pairingTokens = new PairingTokenRegistry();
    const token = pairingTokens.issue({ harnessIdentityId: ANNA, harnessIdentityLabel: 'Anna', linkOfferId: 'offer-1' });
    const h = harness({ dmPolicy: 'pairing', pairingTokens, accountLinks: links });
    await h.bot.handleUpdate(privateText(`/start ${token.token}`, 4712));
    assert.equal(await h.pairingStore.getDmBinding(4712), undefined);
    assert.match(String(h.api.sent.at(-1)?.params['text']), /konnte dein Konto nicht verbinden/);
  });

  it('an allow-list pairing (no offer) never says "connected"', async () => {
    const pairingTokens = new PairingTokenRegistry();
    const token = pairingTokens.issue({ harnessIdentityId: 'note', harnessIdentityLabel: 'Anna' });
    const h = harness({ dmPolicy: 'pairing', pairingTokens });
    await h.bot.handleUpdate(privateText(`/start ${token.token}`, 4713));
    const binding = await h.pairingStore.getDmBinding(4713);
    assert.equal(binding?.accountLinked, undefined);
    assert.doesNotMatch(String(h.api.sent.at(-1)?.params['text']), /verbunden/);
  });
});

async function withAdmin(
  links: AccountLinks | undefined,
  fn: (call: (method: string, path: string, body?: unknown, cookie?: string) => Promise<Response>, store: PairingStore) => Promise<void>,
): Promise<void> {
  const store = new PairingStore(memoryStore());
  const app = express();
  app.use(
    '/admin',
    createTelegramAdminRouter({
      pairingStore: store,
      pairingTokens: new PairingTokenRegistry(),
      identity: { username: 'ColleagueBot', id: 999 },
      adminToken: ADMIN_TOKEN,
      webhookMode: 'long-poll',
      dmPolicy: 'pairing',
      ...(links ? { accountLinks: links } : {}),
    }),
  );
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const call = (method: string, path: string, body?: unknown, cookie?: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${String(port)}/admin${path}`, {
        method,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    await fn(call, store);
  } finally {
    server.close();
  }
}

describe('#1995 — admin API with kernel account links', () => {
  it('lists accounts only under an operator session', async () => {
    const { links } = fakeLinks();
    await withAdmin(links, async (call) => {
      assert.equal((await call('GET', '/accounts')).status, 403);
      const ok = await call('GET', '/accounts', undefined, COOKIE);
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { accounts: unknown[] }).accounts.length, 1);
      const info = (await (await call('GET', '/info')).json()) as { accountLinking: boolean };
      assert.equal(info.accountLinking, true);
    });
  });

  it('a pairing names an account the kernel offers, with the operator cookie', async () => {
    const { links, calls } = fakeLinks();
    await withAdmin(links, async (call) => {
      const res = await call('POST', '/pairings', { userId: ANNA }, COOKIE);
      assert.equal(res.status, 201);
      const body = (await res.json()) as { harnessIdentityLabel: string; accountLink: boolean; deeplink: string };
      assert.equal(body.harnessIdentityLabel, 'Anna');
      assert.equal(body.accountLink, true);
      assert.deepEqual(calls.offers[0], { cookie: COOKIE, channelType: 'telegram', userId: ANNA, ttlMs: 120_000 });
      assert.equal((await call('POST', '/pairings', { userId: 'nobody' }, COOKIE)).status, 400);
      assert.equal((await call('POST', '/pairings', { userId: ANNA })).status, 403);
      // Free text is refused once the kernel can link.
      const free = await call('POST', '/pairings', { harnessIdentityId: 'x', harnessIdentityLabel: 'X' }, COOKIE);
      assert.equal(free.status, 400);
    });
  });

  it('revoking a linked binding unlinks in the kernel first, and keeps it without a session', async () => {
    const { links, calls } = fakeLinks();
    await withAdmin(links, async (call, store) => {
      await store.putDmBinding({
        telegramUserId: 4711,
        harnessIdentityId: ANNA,
        harnessIdentityLabel: 'Anna',
        boundAt: new Date(0).toISOString(),
        accountLinked: true,
      });
      assert.equal((await call('DELETE', '/bindings/dm/4711')).status, 403);
      assert.ok(await store.getDmBinding(4711));
      assert.equal((await call('DELETE', '/bindings/dm/4711', undefined, COOKIE)).status, 204);
      assert.equal(await store.getDmBinding(4711), undefined);
      assert.deepEqual(calls.unlinks.at(-1), { cookie: COOKIE, channelType: 'telegram', channelUserId: 'telegram:4711' });
    });
  });

  it('without the kernel capability the pairing stays an allow-list', async () => {
    await withAdmin(undefined, async (call) => {
      assert.equal((await call('GET', '/accounts')).status, 404);
      const res = await call('POST', '/pairings', { harnessIdentityId: 'note', harnessIdentityLabel: 'Anna' });
      assert.equal(res.status, 201);
      assert.equal(((await res.json()) as { accountLink: boolean }).accountLink, false);
    });
  });
});
