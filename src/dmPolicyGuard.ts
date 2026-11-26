/**
 * Pre-turn DM-policy gate. Decides whether an incoming private-chat
 * message from a Telegram user is allowed to drive an orchestrator turn.
 *
 * Three modes (see manifest.yaml setup.dm_policy):
 *
 * - `'open'`: any DM passes. Only when set explicitly.
 * - `'pairing'` (default, and the fallback for a missing or unknown
 *   value, #1998): unbound users are
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
import { DEFAULT_SYSTEM_NAME, notPairedText, type SystemLocale } from './systemTexts.js';

export type DmPolicy = 'open' | 'pairing' | 'disabled';

const VALID_POLICIES: ReadonlySet<string> = new Set([
  'open',
  'pairing',
  'disabled',
]);

/** The policy a missing, blank or unknown value falls back to: closed, never open (#1998). */
export const FAIL_CLOSED_DM_POLICY: DmPolicy = 'pairing';

/**
 * The configured DM policy. Case and surrounding blanks are ignored
 * (`Pairing`, ` open `). A missing, blank or unknown value is the
 * fail-closed `pairing`, never `open`: a typo must not let anyone chat with
 * the bot (byte5ai/omadia#1998). `onInvalid` reports an unknown value.
 */
export function parseDmPolicy(raw: unknown, onInvalid?: (raw: string) => void): DmPolicy {
  if (typeof raw !== 'string' || raw.trim().length === 0) return FAIL_CLOSED_DM_POLICY;
  const normalised = raw.trim().toLowerCase();
  if (VALID_POLICIES.has(normalised)) return normalised as DmPolicy;
  onInvalid?.(raw);
  return FAIL_CLOSED_DM_POLICY;
}

export interface DmPolicyDecision {
  /** When true, caller proceeds to runTurn. When false, caller returns silently or sends a refusal. */
  allow: boolean;
  /**
   * Optional refusal text to send. Undefined → caller stays silent (the
   * `'disabled'` branch chooses silence on purpose; spammers shouldn't
   * see whether the bot is reachable). Plain text, sent as a `system` notice.
   */
  refusal?: string;
}


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
  /** Names the system in the refusal; default "omadia". */
  systemName?: string;
  /** Language of the refusal; default German. */
  locale?: SystemLocale;
}): Promise<DmPolicyDecision> {
  switch (input.policy) {
    case 'open':
      return { allow: true };
    case 'disabled':
      return { allow: false }; // silent — no refusal text
    case 'pairing': {
      const binding = await input.store.getDmBinding(input.telegramUserId);
      if (binding) return { allow: true };
      return {
        allow: false,
        refusal: notPairedText(input.systemName ?? DEFAULT_SYSTEM_NAME, input.locale ?? 'de'),
      };
    }
  }
}
