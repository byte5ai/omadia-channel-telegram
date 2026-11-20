/**
 * Plain-text replies to a question the agent asked (spec 2042 §5.14 channel
 * parity, criterion 30).
 *
 * Telegram declares no decoration for buttons (`decision_card` and
 * `follow_up_options` are not rendered here), so an agent's choice, slot or
 * topic question reaches the user as a numbered list. The user answers with
 * the number or the label; this store turns that reply back into the value a
 * button tap would have carried, so the agent cannot tell the difference.
 *
 * One-shot per person and chat: the next message of that person resolves or
 * discards the pending question. Anything that is not a clear pick passes
 * through unchanged, so an ordinary answer in words still works.
 */

import type { OutgoingInteractive } from '@omadia/channel-sdk';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface PendingOption {
  readonly label: string;
  /** What the agent receives as the user's next message. */
  readonly echo: string;
}

interface Pending {
  readonly options: readonly PendingOption[];
  readonly expiresAt: number;
}

/** The options a question offers, or `undefined` when it is not a pick-one question. */
export function pendingOptionsOf(interactive: OutgoingInteractive): readonly PendingOption[] | undefined {
  switch (interactive.kind) {
    case 'choice':
      return interactive.options.map((o) => ({ label: o.label, echo: o.value }));
    case 'topic':
      return interactive.topics.map((t) => ({ label: t.label, echo: t.value }));
    case 'slots':
      return interactive.slots.map((s) => ({
        label: s.label,
        echo: `Bitte buche den Slot ${s.slotId} (${s.label}).`,
      }));
    case 'routine_list':
    case 'mcp_input':
      return undefined;
  }
}

export class PendingReplyStore {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Remember the question just asked to `key` (a person in a chat). */
  remember(key: string, interactive: OutgoingInteractive | undefined): void {
    this.prune();
    const options = interactive ? pendingOptionsOf(interactive) : undefined;
    if (!options || options.length === 0) {
      this.pending.delete(key);
      return;
    }
    this.pending.set(key, { options, expiresAt: this.now() + this.ttlMs });
  }

  /**
   * The user's next message: the picked option's value, or `text` unchanged
   * when nothing was pending or the reply is not a pick.
   */
  resolve(key: string, text: string): string {
    const hit = this.pending.get(key);
    if (!hit) return text;
    this.pending.delete(key);
    if (hit.expiresAt < this.now()) return text;
    const reply = text.trim();
    if (/^\d+$/.test(reply)) return hit.options[Number(reply) - 1]?.echo ?? text;
    const lower = reply.toLowerCase();
    return hit.options.find((o) => o.label.toLowerCase() === lower)?.echo ?? text;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.pending) {
      if (value.expiresAt < now) this.pending.delete(key);
    }
  }
}

export function pendingReplyKey(chatId: number, userId: number | undefined): string {
  return `${String(chatId)}:${userId === undefined ? 'anon' : String(userId)}`;
}
