/**
 * Operator-facing admin endpoints for the Telegram pairing flow. Mounted
 * BY THE PLUGIN ITSELF via `core.registerRouter` — no kernel coupling.
 * Plugin is fully self-contained: admin route, capability-free service
 * instances, own bearer-token auth.
 *
 * Endpoint surface (under `/api/telegram/admin` after the plugin mounts it):
 *   GET    /accounts           omadia accounts for the picker (kernel, operator session)
 *   POST   /pairings           issue a pairing token + QR
 *   GET    /pairings           list pending tokens (no values)
 *   GET    /bindings/dm        list DM bindings
 *   DELETE /bindings/dm/:id    revoke a DM binding
 *   GET    /bindings/groups    list group activations
 *   DELETE /bindings/groups/:id  deactivate a group
 *
 * Auth (omadia#2355): the operator's omadia session. On a kernel with
 * `ctx.operatorAuth.sessionPrincipal` every request needs a signed-in
 * operator (session cookie, resolved by the kernel); a cross-site write is
 * refused. Only on an older kernel without it does the router fall back to
 * the `telegram_admin_token` bearer from the plugin vault.
 *
 * Account links (ADR-0225): on a kernel with `CoreApi.channelIdentityLinks`
 * a pairing names an omadia account (`userId`), and the kernel validates it
 * and the operator from the request's session cookie. Without the capability
 * a pairing is a DM allow-list with a free-text note.
 *
 * QR rendering: direct kroki POST `/qrcode/svg`. krokiBaseUrl flows
 * in via the plugin's TelegramChannelPluginDeps. When unset, qrSvg
 * comes back null and operator copy-pastes the deeplink.
 */

import { Router } from 'express';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  refusalStatus,
  telegramTurnUserId,
  TELEGRAM_LINK_CHANNEL_TYPE,
  type AccountLinks,
} from './accountLinks.js';
import type { PairingStore } from './pairingStore.js';
import type { PairingTokenRegistry } from './pairingTokens.js';

export interface TelegramAdminRouterDeps {
  pairingStore: PairingStore;
  pairingTokens: PairingTokenRegistry;
  identity: { username: string; id: number };
  /**
   * The operator behind a request's cookie header (kernel
   * `ctx.operatorAuth.sessionPrincipal`). Present → session auth, no bearer.
   */
  operatorOf?: (cookieHeader: string | undefined) => Promise<{ email: string } | null>;
  /** Bearer fallback for kernels without `operatorOf` (vault `telegram_admin_token`). */
  adminToken?: string;
  /** Optional kroki base URL for QR rendering. Undefined → qrSvg null. */
  krokiBaseUrl?: string;
  /** Channel runtime mode reflected back in /info — UI status panel. */
  webhookMode: 'webhook' | 'long-poll';
  /** Active DM policy, reflected back in /info — UI status panel. */
  dmPolicy: 'open' | 'pairing' | 'disabled';
  /** The kernel's account links; absent on a kernel without ADR-0225. */
  accountLinks?: AccountLinks;
}

/** A pairing that links the Telegram account to an omadia account. */
const LinkBodySchema = z.object({ userId: z.string().min(1).max(256) }).strict();
/** An allow-list pairing (kernel without account links): free-text note only. */
const AllowListBodySchema = z.object({
  harnessIdentityId: z.string().min(1).max(256),
  harnessIdentityLabel: z.string().min(1).max(120),
});

const TgUserIdParamSchema = z.coerce.number().int();
const ChatIdParamSchema = z.coerce.number().int();

export function createTelegramAdminRouter(
  deps: TelegramAdminRouterDeps,
): Router {
  const router = Router();
  // JSON body parser scoped to admin routes — webhook router has its own.
  router.use(express.json({ limit: '64kb' }));

  router.use(createAdminAuth(deps));

  // -------------------------------------------------------------------
  // GET /info — status snapshot for the UI (bot identity, mode, policy).
  // Doubles as the bearer-token validation endpoint: UI calls this on
  // login; 200 → token good, 401 → invalid. No mutation, cheap, safe to
  // poll for "still authorised" checks.
  // -------------------------------------------------------------------
  router.get('/info', (_req: Request, res: Response) => {
    res.json({
      bot: { username: deps.identity.username, id: deps.identity.id },
      dmPolicy: deps.dmPolicy,
      webhookMode: deps.webhookMode,
      qrEnabled: Boolean(deps.krokiBaseUrl),
      accountLinking: deps.accountLinks !== undefined,
      auth: deps.operatorOf ? 'session' : 'bearer',
    });
  });

  // -------------------------------------------------------------------
  // GET /accounts — the omadia accounts a pairing may link to. Read from
  // the kernel under the operator's own session; 403 without one.
  // -------------------------------------------------------------------
  router.get('/accounts', async (req: Request, res: Response) => {
    if (!deps.accountLinks) {
      res.status(404).json({ error: 'account_linking_unavailable' });
      return;
    }
    const accounts = await deps.accountLinks.listLinkableAccounts(req.headers.cookie);
    if (accounts === null) {
      res.status(403).json({ error: 'no_session' });
      return;
    }
    res.json({ accounts });
  });

  // -------------------------------------------------------------------
  // POST /pairings — issue a token + return deeplink + QR
  // -------------------------------------------------------------------
  router.post('/pairings', async (req: Request, res: Response) => {
    const pairing = await pairingFor(deps, req);
    if (!pairing.ok) {
      res.status(pairing.status).json(pairing.body);
      return;
    }
    const issued = deps.pairingTokens.issue(pairing.token);
    const deeplink = buildDeeplink(deps.identity.username, issued.token);
    let qrSvg: string | null = null;
    if (deps.krokiBaseUrl) {
      try {
        qrSvg = await renderQrSvg(deps.krokiBaseUrl, deeplink);
      } catch (err) {
        console.warn(
          `[telegram-admin] kroki QR render failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    res.status(201).json({
      bot: { username: deps.identity.username, id: deps.identity.id },
      token: issued.token,
      deeplink,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      ttlMs: issued.expiresAt - Date.now(),
      harnessIdentityLabel: issued.harnessIdentityLabel,
      accountLink: issued.linkOfferId !== undefined,
      qrSvg,
    });
  });

  // -------------------------------------------------------------------
  // GET /pairings — list pending tokens (metadata only, no token strings)
  // -------------------------------------------------------------------
  router.get('/pairings', (_req: Request, res: Response) => {
    res.json({ pending: deps.pairingTokens.listMetadata() });
  });

  // -------------------------------------------------------------------
  // GET /bindings/dm — list active DM bindings
  // -------------------------------------------------------------------
  router.get('/bindings/dm', async (_req: Request, res: Response) => {
    res.json({ bindings: await deps.pairingStore.listDmBindings() });
  });

  // -------------------------------------------------------------------
  // DELETE /bindings/dm/:tgUserId — revoke a DM binding
  // -------------------------------------------------------------------
  router.delete(
    '/bindings/dm/:tgUserId',
    async (req: Request, res: Response) => {
      const parse = TgUserIdParamSchema.safeParse(req.params['tgUserId']);
      if (!parse.success) {
        res.status(400).json({ error: 'invalid_user_id' });
        return;
      }
      const binding = await deps.pairingStore.getDmBinding(parse.data);
      // A linked account is unlinked in the kernel first: a revoked pairing
      // must not leave the Telegram account running as the omadia account.
      if (binding?.accountLinked && deps.accountLinks) {
        const unlinked = await deps.accountLinks.unlink(req.headers.cookie, {
          channelType: TELEGRAM_LINK_CHANNEL_TYPE,
          channelUserId: telegramTurnUserId(parse.data),
        });
        if (!unlinked.ok && unlinked.reason !== 'not_linked') {
          res.status(refusalStatus(unlinked.reason)).json({ error: unlinked.reason });
          return;
        }
      }
      await deps.pairingStore.deleteDmBinding(parse.data);
      res.status(204).end();
    },
  );

  // -------------------------------------------------------------------
  // GET /bindings/groups — list active group activations
  // -------------------------------------------------------------------
  router.get('/bindings/groups', async (_req: Request, res: Response) => {
    res.json({ groups: await deps.pairingStore.listGroupActivations() });
  });

  // -------------------------------------------------------------------
  // DELETE /bindings/groups/:chatId — deactivate a group
  // -------------------------------------------------------------------
  router.delete(
    '/bindings/groups/:chatId',
    async (req: Request, res: Response) => {
      const parse = ChatIdParamSchema.safeParse(req.params['chatId']);
      if (!parse.success) {
        res.status(400).json({ error: 'invalid_chat_id' });
        return;
      }
      await deps.pairingStore.deleteGroupActivation(parse.data);
      res.status(204).end();
    },
  );

  return router;
}

type PairingRequest =
  | {
      readonly ok: true;
      readonly token: { harnessIdentityId: string; harnessIdentityLabel: string; linkOfferId?: string };
    }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, string> };

/**
 * What a POST /pairings body asks for. With account links the body names an
 * account and the kernel offers the link (it checks the operator session and
 * the account); the free-text form is refused, so a pairing on such a kernel
 * always means a person. Without them only the allow-list form exists.
 */
async function pairingFor(deps: TelegramAdminRouterDeps, req: Request): Promise<PairingRequest> {
  if (deps.accountLinks) {
    const parse = LinkBodySchema.safeParse(req.body);
    if (!parse.success) {
      return { ok: false, status: 400, body: { error: 'invalid_body', detail: 'expected { userId }' } };
    }
    const offer = await deps.accountLinks.offerLink(req.headers.cookie, {
      channelType: TELEGRAM_LINK_CHANNEL_TYPE,
      userId: parse.data.userId,
      ttlMs: deps.pairingTokens.ttl,
    });
    if (!offer.ok) return { ok: false, status: refusalStatus(offer.reason), body: { error: offer.reason } };
    return {
      ok: true,
      token: {
        harnessIdentityId: offer.account.userId,
        harnessIdentityLabel: offer.account.displayName,
        linkOfferId: offer.offerId,
      },
    };
  }
  const parse = AllowListBodySchema.safeParse(req.body);
  if (!parse.success) {
    return { ok: false, status: 400, body: { error: 'invalid_body', detail: parse.error.message } };
  }
  return { ok: true, token: parse.data };
}

function buildDeeplink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername}?start=${token}`;
}

async function renderQrSvg(krokiBase: string, text: string): Promise<string> {
  const base = krokiBase.endsWith('/') ? krokiBase.slice(0, -1) : krokiBase;
  const res = await fetch(`${base}/qrcode/svg`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text,
  });
  if (!res.ok) {
    throw new Error(`kroki returned ${String(res.status)}`);
  }
  return await res.text();
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A write the browser marks as cross-site is refused even with a valid
 * session: the session cookie is `SameSite=Lax`, and this keeps a forged
 * form or fetch from another site out on top of that.
 */
function isCrossSiteWrite(req: Request): boolean {
  if (!MUTATING.has(req.method)) return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || origin === '') return false;
  try {
    return new URL(origin).host !== req.headers['host'];
  } catch {
    return true;
  }
}

/** omadia#2355 — operator session when the kernel offers it, else the vault bearer. */
export function createAdminAuth(
  deps: Pick<TelegramAdminRouterDeps, 'operatorOf' | 'adminToken'>,
): (req: Request, res: Response, next: NextFunction) => void {
  const operatorOf = deps.operatorOf;
  if (operatorOf) {
    return (req, res, next) => {
      if (isCrossSiteWrite(req)) {
        res.status(403).json({ error: 'cross_site' });
        return;
      }
      operatorOf(req.headers.cookie)
        .then((operator) => {
          if (!operator) {
            res.status(401).json({ error: 'no_session', auth: 'session' });
            return;
          }
          next();
        })
        .catch(() => res.status(401).json({ error: 'no_session', auth: 'session' }));
    };
  }
  const adminToken = deps.adminToken;
  return (req, res, next) => {
    const header = req.headers['authorization'];
    const supplied =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!adminToken || supplied === '' || !constantTimeEqualString(supplied, adminToken)) {
      res.status(401).json({ error: 'unauthorized', auth: 'bearer' });
      return;
    }
    next();
  };
}
