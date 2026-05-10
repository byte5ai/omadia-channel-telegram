/**
 * Operator-facing admin endpoints for the Telegram pairing flow. Mounted
 * BY THE PLUGIN ITSELF via `core.registerRouter` — no kernel coupling.
 * Plugin is fully self-contained: admin route, capability-free service
 * instances, own bearer-token auth.
 *
 * Endpoint surface (under `/api/telegram/admin` after the plugin mounts it):
 *   POST   /pairings           issue a pairing token + QR
 *   GET    /pairings           list pending tokens (no values)
 *   GET    /bindings/dm        list DM bindings
 *   DELETE /bindings/dm/:id    revoke a DM binding
 *   GET    /bindings/groups    list group activations
 *   DELETE /bindings/groups/:id  deactivate a group
 *
 * Auth: Bearer-Token from `telegram_admin_token` vault entry. Plugin
 * resolves it at activate() and passes it to this factory; operator
 * captures the token from the boot log on first install (auto-generated
 * by bootstrapTelegramFromEnv).
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

import type { PairingStore } from './pairingStore.js';
import type { PairingTokenRegistry } from './pairingTokens.js';

export interface TelegramAdminRouterDeps {
  pairingStore: PairingStore;
  pairingTokens: PairingTokenRegistry;
  identity: { username: string; id: number };
  /** Random per-install token. Operator reads from boot log / vault. */
  adminToken: string;
  /** Optional kroki base URL for QR rendering. Undefined → qrSvg null. */
  krokiBaseUrl?: string;
  /** Channel runtime mode reflected back in /info — UI status panel. */
  webhookMode: 'webhook' | 'long-poll';
  /** Active DM policy, reflected back in /info — UI status panel. */
  dmPolicy: 'open' | 'pairing' | 'disabled';
}

const IssueBodySchema = z.object({
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

  // Bearer auth — token sourced from the plugin's vault entry, not from
  // the kernel ADMIN_TOKEN. Self-contained.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const supplied = header.slice('Bearer '.length).trim();
    if (!constantTimeEqualString(supplied, deps.adminToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

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
    });
  });

  // -------------------------------------------------------------------
  // POST /pairings — issue a token + return deeplink + QR
  // -------------------------------------------------------------------
  router.post('/pairings', async (req: Request, res: Response) => {
    const parse = IssueBodySchema.safeParse(req.body);
    if (!parse.success) {
      res
        .status(400)
        .json({ error: 'invalid_body', detail: parse.error.message });
      return;
    }
    const issued = deps.pairingTokens.issue(parse.data);
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
