/**
 * Telegram webhook router. Mounted by the channel plugin at a
 * channel-specific path (default `/api/telegram/webhook`). Validates the
 * `X-Telegram-Bot-Api-Secret-Token` header against the configured secret
 * (constant-time compare) before dispatching the Update to the bot.
 *
 * The router never returns >=400 to Telegram for legitimate-looking calls
 * (only 401 on secret mismatch / 415 on bad content-type), because Telegram
 * will retry failed deliveries and exponentially back off. Update handling
 * runs fire-and-forget after a 200 ack so a slow orchestrator turn never
 * blocks the Bot-API connection (Telegram's webhook timeout is 60s; an
 * orchestrator turn can exceed that).
 */

import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';

import type { TelegramBot, TelegramUpdate } from './telegramBot.js';

export interface TelegramRouterDeps {
  bot: TelegramBot;
  /** Same value passed to `setWebhook({ secret_token })`. Required. */
  webhookSecret: string;
  /**
   * The route inside the router. Default `/webhook` (router mounted at
   * `/api/telegram`); the plugin mounts it at `/api/telegram/webhook` itself
   * and passes `/`, so the mount is exactly the declared public path.
   */
  path?: string;
}

export function createTelegramWebhookRouter(deps: TelegramRouterDeps): Router {
  const router = Router();
  // Telegram POSTs JSON; size hard-cap well above any realistic Update.
  router.use(express.json({ limit: '1mb' }));
  router.post(deps.path ?? '/webhook', (req: Request, res: Response) => {
    if (!verifySecretHeader(req, deps.webhookSecret)) {
      res.status(401).json({ ok: false, error: 'unauthorised' });
      return;
    }
    const update = req.body as TelegramUpdate;
    if (!update || typeof update.update_id !== 'number') {
      res.status(400).json({ ok: false, error: 'invalid_update' });
      return;
    }
    // Ack first, dispatch async — orchestrator turns may exceed Telegram's
    // 60s webhook timeout otherwise.
    res.status(200).json({ ok: true });
    void deps.bot.handleUpdate(update).catch((err: unknown) => {
      console.error('[telegram] handleUpdate failed:', err);
    });
  });
  return router;
}

function verifySecretHeader(req: Request, expected: string): boolean {
  const got = req.header('x-telegram-bot-api-secret-token');
  if (typeof got !== 'string' || got.length === 0) return false;
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Spec 2042 §5.3 — the webhooks of agents' own bots, one router for all:
 * `POST /<botId>/webhook`, each checked against that bot's own secret. A bot
 * that is not running (removed, not started) answers 404 so Telegram stops.
 */
export function createTelegramAgentBotsRouter(
  lookup: (botId: number) => TelegramRouterDeps | undefined,
): Router {
  const router = Router();
  router.use(express.json({ limit: '1mb' }));
  router.post('/:botId/webhook', (req: Request, res: Response) => {
    const raw = req.params['botId'];
    const botId = typeof raw === 'string' && /^\d{1,20}$/.test(raw) ? Number(raw) : undefined;
    const target = botId === undefined ? undefined : lookup(botId);
    if (!target) {
      res.status(404).json({ ok: false, error: 'unknown_bot' });
      return;
    }
    if (!verifySecretHeader(req, target.webhookSecret)) {
      res.status(401).json({ ok: false, error: 'unauthorised' });
      return;
    }
    const update = req.body as TelegramUpdate;
    if (!update || typeof update.update_id !== 'number') {
      res.status(400).json({ ok: false, error: 'invalid_update' });
      return;
    }
    res.status(200).json({ ok: true });
    void target.bot.handleUpdate(update).catch((err: unknown) => {
      console.error(`[telegram] handleUpdate (agent bot ${String(botId)}) failed:`, err);
    });
  });
  return router;
}
