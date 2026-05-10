/**
 * In-memory pairing-token registry. Tokens are issued by the admin route
 * (operator wants to bind a Telegram user to a Harness identity), encoded
 * into a Telegram start-deeplink (`https://t.me/<bot>?start=<token>`), and
 * consumed once when the user clicks the link and the bot receives
 * `/start <token>` as the first message.
 *
 * Tokens are short-lived (120s TTL) and single-use. After consumption the
 * entry is deleted; expired entries are pruned lazily on every read/write.
 *
 * Persistence: NONE — tokens are deliberately ephemeral. If the middleware
 * restarts mid-pairing, the operator generates a new token. The persistent
 * binding (telegram_user_id → harness_identity) lives in pairingStore.ts
 * via the memoryStore capability.
 *
 * Token shape: 22 ASCII chars (16 random bytes, base64url). Well under
 * Telegram's 64-byte start-param cap, URL-safe, no padding.
 */

const DEFAULT_TTL_MS = 120 * 1000;

export interface PairingToken {
  token: string;
  /** Opaque Harness-side identity to bind on consumption. */
  harnessIdentityId: string;
  /** Friendly label rendered in the operator UI / DM-confirm message. */
  harnessIdentityLabel: string;
  /** Unix-ms creation time. Used for audit + expiry math. */
  createdAt: number;
  /** Unix-ms expiry. Lazy-pruned. */
  expiresAt: number;
}

export class PairingTokenRegistry {
  private readonly map = new Map<string, PairingToken>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  issue(input: {
    harnessIdentityId: string;
    harnessIdentityLabel: string;
  }): PairingToken {
    this.pruneExpired();
    const token = randomTokenString();
    const now = Date.now();
    const entry: PairingToken = {
      token,
      harnessIdentityId: input.harnessIdentityId,
      harnessIdentityLabel: input.harnessIdentityLabel,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.map.set(token, entry);
    return entry;
  }

  /** Returns the entry and DELETES it (single-use). Returns undefined if missing or expired. */
  consume(token: string): PairingToken | undefined {
    this.pruneExpired();
    const entry = this.map.get(token);
    if (!entry) return undefined;
    this.map.delete(token);
    if (entry.expiresAt < Date.now()) return undefined;
    return entry;
  }

  /** Inspect without consuming — only used by admin-route GET endpoints. */
  peek(token: string): PairingToken | undefined {
    this.pruneExpired();
    return this.map.get(token);
  }

  /** Operator-facing list — no token strings leak (only metadata). */
  listMetadata(): Array<Omit<PairingToken, 'token'>> {
    this.pruneExpired();
    return Array.from(this.map.values()).map(({ token: _drop, ...meta }) => {
      void _drop;
      return meta;
    });
  }

  /** TTL accessor for downstream callers (e.g. UI countdown). */
  get ttl(): number {
    return this.ttlMs;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt < now) this.map.delete(k);
    }
  }
}

function randomTokenString(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64url, no padding — Telegram start-param accepts a-zA-Z0-9_-
  return Buffer.from(bytes).toString('base64url');
}
