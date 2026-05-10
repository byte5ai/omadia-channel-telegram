/**
 * Persistent telegram → harness identity bindings, plus group activations,
 * stored as JSON files in the kernel-provided memoryStore. First channel-
 * side memoryStore consumer (capability spec: docs/harness-platform/
 * conventions/service-capabilities.md §2.1).
 *
 * Layout under the plugin's memory namespace:
 *   pairings/dm/<telegram_user_id>.json   → DmBinding
 *   pairings/groups/<chat_id>.json        → GroupActivation
 *
 * One file per binding so concurrent writes never race on a shared list,
 * and reads stay O(1) by ID. List operations (`listDmBindings`,
 * `listGroupActivations`) walk the prefix — fine for the operator-UI
 * surface size we expect (dozens to low-hundreds).
 *
 * Concurrency note: memoryStore is filesystem-backed. The plugin runs
 * single-process today (one Telegram channel instance per middleware),
 * so write-conflicts cannot happen without an admin tool simultaneously
 * editing the same file. That's an operator-error, not a runtime hazard.
 */

import type { MemoryStoreShim } from './kernel-types.js';

// MemoryStore enforces a /memories/ root prefix on all virtual paths
// (FilesystemMemoryStore.toAbsolute throws MemoryInvalidPathError on
// anything else). The plugin still gets its own per-plugin namespace
// underneath that root via `ctx.memory` — these paths are scoped to
// the channel-telegram plugin, never to /memories at the user level.
const DM_DIR = '/memories/pairings/dm';
const GROUP_DIR = '/memories/pairings/groups';

// ---------------------------------------------------------------------------
// Schemas — JSON-on-disk shapes. Stable across plugin versions: any new
// field MUST be optional, no rename without migration.
// ---------------------------------------------------------------------------

export interface DmBinding {
  /** Telegram user ID (positive integer, stringified for path use). */
  telegramUserId: number;
  /** Opaque Harness-side identity. */
  harnessIdentityId: string;
  /** Friendly label for the operator UI (no auth value). */
  harnessIdentityLabel: string;
  /** Last-seen Telegram username (snapshot — may go stale). */
  telegramUsername?: string;
  /** Last-seen Telegram display name. */
  telegramDisplayName?: string;
  /** ISO-8601 of binding creation. */
  boundAt: string;
}

export interface GroupActivation {
  /** Telegram chat ID (negative integer for groups, supergroups). */
  chatId: number;
  /** Telegram chat title at activation time (may go stale). */
  chatTitle: string;
  /** Telegram chat type (group | supergroup). */
  chatType: 'group' | 'supergroup';
  /** Harness identity who activated (must be a paired DM identity). */
  activatedBy: string;
  /** How activation happened. */
  activatedVia: 'auto' | 'explicit';
  /** ISO-8601. */
  activatedAt: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PairingStore {
  constructor(private readonly memory: MemoryStoreShim) {}

  // ---------- DM bindings -------------------------------------------------

  async getDmBinding(telegramUserId: number): Promise<DmBinding | undefined> {
    const p = dmPath(telegramUserId);
    if (!(await this.memory.fileExists(p))) return undefined;
    return parseJson<DmBinding>(await this.memory.readFile(p));
  }

  async putDmBinding(binding: DmBinding): Promise<void> {
    const p = dmPath(binding.telegramUserId);
    const body = JSON.stringify(binding, null, 2);
    if (await this.memory.fileExists(p)) {
      await this.memory.writeFile(p, body);
    } else {
      await this.memory.createFile(p, body);
    }
  }

  async deleteDmBinding(telegramUserId: number): Promise<void> {
    const p = dmPath(telegramUserId);
    if (await this.memory.fileExists(p)) await this.memory.delete(p);
  }

  async listDmBindings(): Promise<DmBinding[]> {
    if (!(await this.memory.directoryExists(DM_DIR))) return [];
    const entries = await this.memory.list(DM_DIR);
    const out: DmBinding[] = [];
    for (const e of entries) {
      if (e.isDirectory) continue;
      try {
        const body = await this.memory.readFile(e.virtualPath);
        out.push(parseJson<DmBinding>(body));
      } catch (err) {
        // Skip corrupted entries — operator can clean up via UI later.
        console.warn(
          `[telegram] skipping corrupted dm binding ${e.virtualPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return out;
  }

  // ---------- Group activations ------------------------------------------

  async getGroupActivation(
    chatId: number,
  ): Promise<GroupActivation | undefined> {
    const p = groupPath(chatId);
    if (!(await this.memory.fileExists(p))) return undefined;
    return parseJson<GroupActivation>(await this.memory.readFile(p));
  }

  async putGroupActivation(activation: GroupActivation): Promise<void> {
    const p = groupPath(activation.chatId);
    const body = JSON.stringify(activation, null, 2);
    if (await this.memory.fileExists(p)) {
      await this.memory.writeFile(p, body);
    } else {
      await this.memory.createFile(p, body);
    }
  }

  async deleteGroupActivation(chatId: number): Promise<void> {
    const p = groupPath(chatId);
    if (await this.memory.fileExists(p)) await this.memory.delete(p);
  }

  async listGroupActivations(): Promise<GroupActivation[]> {
    if (!(await this.memory.directoryExists(GROUP_DIR))) return [];
    const entries = await this.memory.list(GROUP_DIR);
    const out: GroupActivation[] = [];
    for (const e of entries) {
      if (e.isDirectory) continue;
      try {
        const body = await this.memory.readFile(e.virtualPath);
        out.push(parseJson<GroupActivation>(body));
      } catch (err) {
        console.warn(
          `[telegram] skipping corrupted group activation ${e.virtualPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Path helpers — keep IDs in stringified form for filesystem-safe paths.
// Negative chat IDs (e.g. supergroups -100…) start with a minus; that's
// allowed in memoryStore paths but we normalise it for clarity.
// ---------------------------------------------------------------------------

function dmPath(telegramUserId: number): string {
  return `${DM_DIR}/${String(telegramUserId)}.json`;
}

function groupPath(chatId: number): string {
  // Replace leading minus with `n` (negative) — `-` is rejected by the
  // memoryStore path validator (path-traversal hardening) so we can't
  // store negative chat IDs verbatim.
  const safe = chatId < 0 ? `n${String(-chatId)}` : String(chatId);
  return `${GROUP_DIR}/${safe}.json`;
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}
