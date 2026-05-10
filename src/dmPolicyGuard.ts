/**
 * Pre-turn DM-policy gate. Decides whether an incoming private-chat
 * message from a Telegram user is allowed to drive an orchestrator turn.
 *
 * Three modes (see manifest.yaml setup.dm_policy):
 *
 * - `'open'`: any DM passes. Behaviour pre-S+7.6. Existing installs keep
 *   this on idempotent-bootstrap (no rewrite).
 * - `'pairing'` (S+7.6 default for new installs): unbound users are
 *   refused with a polite "Bitte erst koppeln"-reply that does NOT leak
 *   the pairing UI URL (operator hands out the QR/deeplink out-of-band).
 *   Bound users (DmBinding present) pass.
 * - `'disabled'`: every DM is silently ignored — bot looks dead in DMs.
 *   Use case: bot only operates in groups, DMs are not a feature.
 *
 * Group / supergroup chats are NOT gated here — they have their own
 * activation flow via `my_chat_member` (Sub-Commit 5). This guard runs
 * only for `chat.type === 'private'`.
 *
 * The /start <token> branch in handleMessage runs BEFORE this guard, so
 * pairing always works regardless of dmPolicy. That keeps pairing self-
 * bootstrap-able without a chicken-and-egg.
 */

import type { PairingStore } from './pairingStore.js';

export type DmPolicy = 'open' | 'pairing' | 'disabled';

const VALID_POLICIES: ReadonlySet<string> = new Set([
  'open',
  'pairing',
  'disabled',
]);

export function parseDmPolicy(raw: string | undefined, fallback: DmPolicy): DmPolicy {
  if (!raw) return fallback;
  return VALID_POLICIES.has(raw) ? (raw as DmPolicy) : fallback;
}

export interface DmPolicyDecision {
  /** When true, caller proceeds to runTurn. When false, caller returns silently or sends a refusal. */
  allow: boolean;
  /**
   * Optional refusal text to send. Undefined → caller stays silent (the
   * `'disabled'` branch chooses silence on purpose; spammers shouldn't
   * see whether the bot is reachable). MarkdownV2-escaped.
   */
  refusal?: string;
}

const REFUSAL_NOT_PAIRED =
  'Du bist noch nicht mit dem byte5 Harness verbunden\\. Bitte frag den Operator nach einem Pairing\\-Link\\.';

/**
 * Returns whether the DM should proceed to the orchestrator turn, plus
 * an optional refusal-message text to send first.
 *
 * Pure function over (policy, telegram_user_id, store-state). Side-effects
 * happen in the caller.
 */
export async function evaluateDmPolicy(input: {
  policy: DmPolicy;
  telegramUserId: number;
  store: PairingStore;
}): Promise<DmPolicyDecision> {
  switch (input.policy) {
    case 'open':
      return { allow: true };
    case 'disabled':
      return { allow: false }; // silent — no refusal text
    case 'pairing': {
      const binding = await input.store.getDmBinding(input.telegramUserId);
      if (binding) return { allow: true };
      return { allow: false, refusal: REFUSAL_NOT_PAIRED };
    }
  }
}
