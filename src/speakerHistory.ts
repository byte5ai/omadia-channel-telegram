/**
 * Which agents have spoken in a Telegram chat (spec 2042 INV-4, §5.14).
 *
 * The SDK's `speakerLine()` decides from this history whether a plain name
 * line is due: only when several agents speak in the conversation, or on the
 * first answer after the speaker changed. A history that is forgotten at
 * restart would silently skip the line for the first answer after a change,
 * so it is persisted next to the pairings and read back before the first
 * answer of a chat is rendered.
 *
 * The SDK interface is synchronous. Reads therefore come from memory and
 * `hydrate()` fills the memory from the store first; writes update memory
 * immediately and are persisted in order in the background.
 */

import type { SpeakerHistoryStore } from '@omadia/channel-sdk';

import type { MemoryStoreShim } from './kernel-types.js';

const DIR = '/memories/pairings/speaker-history';

interface Entry {
  agentIds: Set<string>;
  lastAgentId?: string;
}

interface StoredEntry {
  agentIds?: string[];
  lastAgentId?: string;
}

export class PersistentSpeakerHistoryStore implements SpeakerHistoryStore {
  private readonly cache = new Map<string, Entry>();
  private readonly hydrated = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly memory: MemoryStoreShim) {}

  get(conversationKey: string): { agentIds: ReadonlySet<string>; lastAgentId?: string } | undefined {
    return this.cache.get(conversationKey);
  }

  record(conversationKey: string, agentId: string): void {
    const previous = this.cache.get(conversationKey);
    const entry: Entry = {
      agentIds: new Set([...(previous?.agentIds ?? []), agentId]),
      lastAgentId: agentId,
    };
    this.cache.set(conversationKey, entry);
    this.writes = this.writes.then(() => this.persist(conversationKey, entry));
  }

  /** Read the stored history of a conversation into memory (once). */
  async hydrate(conversationKey: string): Promise<void> {
    if (this.hydrated.has(conversationKey)) return;
    this.hydrated.add(conversationKey);
    const path = historyPath(conversationKey);
    try {
      if (!(await this.memory.fileExists(path))) return;
      const stored = JSON.parse(await this.memory.readFile(path)) as StoredEntry;
      const fromDisk: Entry = {
        agentIds: new Set(stored.agentIds ?? []),
        ...(stored.lastAgentId ? { lastAgentId: stored.lastAgentId } : {}),
      };
      // A record made while the read was in flight is newer than the file.
      const live = this.cache.get(conversationKey);
      this.cache.set(
        conversationKey,
        live
          ? {
              agentIds: new Set([...fromDisk.agentIds, ...live.agentIds]),
              ...(live.lastAgentId ? { lastAgentId: live.lastAgentId } : {}),
            }
          : fromDisk,
      );
    } catch (err) {
      // An unreadable file only costs a possibly missing name line after a
      // change; the next answer rebuilds the history.
      console.warn(
        `[telegram] speaker history of ${conversationKey} unreadable: ${errorMessage(err)}`,
      );
    }
  }

  /** Resolves when every queued write has been attempted (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writes;
  }

  private async persist(conversationKey: string, entry: Entry): Promise<void> {
    const path = historyPath(conversationKey);
    const body = JSON.stringify(
      { agentIds: [...entry.agentIds], lastAgentId: entry.lastAgentId },
      null,
      2,
    );
    try {
      if (await this.memory.fileExists(path)) {
        await this.memory.writeFile(path, body);
      } else {
        await this.memory.createFile(path, body);
      }
    } catch (err) {
      console.warn(
        `[telegram] speaker history of ${conversationKey} not persisted: ${errorMessage(err)}`,
      );
    }
  }
}

function historyPath(conversationKey: string): string {
  const safe = conversationKey.replace(/[^0-9A-Za-z:-]/g, '_').replace(/:/g, '_');
  return `${DIR}/${safe}.json`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
