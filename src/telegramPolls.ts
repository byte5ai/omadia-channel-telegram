/**
 * Native Telegram polls for kernel polls (spec 2043 §6.4: "polls as native
 * polls where the channel has them", byte5ai/omadia-channel-telegram#8).
 *
 * The kernel posts a `SendPoll` (its own `pollId`, option ids and labels);
 * this plugin sends it with `sendPoll` as a NON-anonymous poll, because only
 * then does Telegram report who voted (`poll_answer` with `user`). Telegram
 * names an answer by its own poll id and option INDEXES, so the posted poll
 * is remembered here (persisted: a vote can come days later, after a
 * restart) and an answer is mapped back to the kernel's ids.
 *
 * Records are kept per bot and indexed per chat, so a newer poll for the same
 * step can stop the older one (see {@link supersedes}). A stopped or replaced
 * poll's record is deleted; a record older than
 * {@link POLL_RECORD_MAX_AGE_MS} is dropped when its chat posts the next
 * poll, and the in-memory cache holds at most {@link MAX_CACHED_POLLS}.
 *
 * Limits, documented in the README:
 *  - multiple answers only when the kernel says so (`multipleAnswers`, since
 *    plugin-api 1.84.0 / channel-sdk 0.3.10, omadia#2155); without it every poll is
 *    single choice.
 *  - a retracted vote (`option_ids: []`) is not reported: the kernel has no
 *    form for "no answer", so the last ballot stays until it is changed.
 *  - an anonymous administrator votes as the chat (`voter_chat`, no `user`):
 *    no person is known, nothing is reported.
 */

import type { MemoryStoreShim } from './kernel-types.js';
import { KeyedQueue } from './keyedQueue.js';

const DIR = '/memories/pairings/polls';
/** Bot API sendPoll limits (https://core.telegram.org/bots/api#sendpoll). */
export const TELEGRAM_POLL_QUESTION_MAX = 300;
export const TELEGRAM_POLL_OPTION_MAX = 100;
export const TELEGRAM_POLL_OPTIONS_MIN = 2;
export const TELEGRAM_POLL_OPTIONS_MAX = 10;
/** A poll record older than this is dropped when its chat posts the next poll. */
export const POLL_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many polls are kept in memory; older ones are read from the store again. */
export const MAX_CACHED_POLLS = 500;
/** At most this many open polls are remembered per chat; the oldest go first. */
export const MAX_OPEN_POLLS_PER_CHAT = 20;

/** A poll this bot posted for the kernel. */
export interface PostedPoll {
  /** Telegram's poll id (`message.poll.id`), what `poll_answer.poll_id` names. */
  readonly telegramPollId: string;
  /** The kernel's poll id; comes back as `cardAnswer.cardId`. */
  readonly pollId: string;
  readonly chatId: number;
  /** The poll's `message_id`: the `messageId` of every answer event. */
  readonly messageId: number;
  /** Kernel option ids in Telegram's option order. */
  readonly optionIds: readonly string[];
  /** ISO 8601. */
  readonly postedAt: string;
  /** Posted as a multiple-answer poll (an approval vote). Absent = single choice. */
  readonly multipleAnswers?: boolean;
}

/** One chat's open polls, oldest first. */
interface ChatIndex {
  readonly polls: ReadonlyArray<{ readonly telegramPollId: string; readonly postedAt: string }>;
}

export class TelegramPollStore {
  private readonly loaded = new Map<string, PostedPoll>();
  /** Writes of one chat's index, one after another. */
  private readonly indexQueue = new KeyedQueue();

  constructor(
    private readonly memory: MemoryStoreShim,
    private readonly botId: number,
    private readonly now: () => number = Date.now,
  ) {}

  async remember(poll: PostedPoll): Promise<void> {
    this.cache(poll);
    try {
      await this.write(this.pathOf(poll.telegramPollId), JSON.stringify(poll, null, 2));
      await this.updateIndex(poll.chatId, (entries) => [
        ...entries.filter((e) => e.telegramPollId !== poll.telegramPollId),
        { telegramPollId: poll.telegramPollId, postedAt: poll.postedAt },
      ]);
    } catch (err) {
      // The poll is out and answers arrive until a restart; after one they
      // cannot be mapped any more. Text ballots still count.
      console.warn(`[telegram] poll ${poll.telegramPollId} not persisted: ${errorMessage(err)}`);
    }
  }

  async find(telegramPollId: string): Promise<PostedPoll | undefined> {
    const hit = this.loaded.get(telegramPollId);
    if (hit) return hit;
    const path = this.pathOf(telegramPollId);
    try {
      if (!(await this.memory.fileExists(path))) return undefined;
      const poll = parsePoll(JSON.parse(await this.memory.readFile(path)) as unknown);
      if (poll) this.cache(poll);
      return poll;
    } catch (err) {
      console.warn(`[telegram] poll ${telegramPollId} unreadable: ${errorMessage(err)}`);
      return undefined;
    }
  }

  /** The polls this bot posted into `chatId` and has not stopped, oldest first. */
  async openInChat(chatId: number): Promise<PostedPoll[]> {
    const entries = await this.readIndex(chatId);
    const polls = await Promise.all(entries.map((e) => this.find(e.telegramPollId)));
    return polls.filter((p): p is PostedPoll => p !== undefined && p.chatId === chatId);
  }

  /** Drop a stopped or replaced poll: its answers are not mapped any more. */
  async forget(poll: Pick<PostedPoll, 'telegramPollId' | 'chatId'>): Promise<void> {
    this.loaded.delete(poll.telegramPollId);
    try {
      await this.deleteRecord(poll.telegramPollId);
      await this.updateIndex(poll.chatId, (entries) => entries.filter((e) => e.telegramPollId !== poll.telegramPollId));
    } catch (err) {
      console.warn(`[telegram] poll ${poll.telegramPollId} not removed: ${errorMessage(err)}`);
    }
  }

  /** Bounded: the oldest cached poll goes first (it is still in the store). */
  private cache(poll: PostedPoll): void {
    this.loaded.delete(poll.telegramPollId);
    this.loaded.set(poll.telegramPollId, poll);
    while (this.loaded.size > MAX_CACHED_POLLS) {
      const oldest = this.loaded.keys().next().value;
      if (oldest === undefined) break;
      this.loaded.delete(oldest);
    }
  }

  /**
   * Change one chat's index. Entries past the age limit or beyond the per-chat
   * cap are dropped, and so are their records.
   */
  private updateIndex(
    chatId: number,
    change: (entries: ChatIndex['polls']) => ChatIndex['polls'],
  ): Promise<void> {
    return this.indexQueue.run(String(chatId), async () => {
      const changed = change(await this.readIndex(chatId));
      const cutoff = this.now() - POLL_RECORD_MAX_AGE_MS;
      const fresh = changed.filter((e) => Date.parse(e.postedAt) >= cutoff);
      const kept = fresh.slice(-MAX_OPEN_POLLS_PER_CHAT);
      const dropped = changed.filter((e) => !kept.includes(e));
      for (const e of dropped) {
        this.loaded.delete(e.telegramPollId);
        await this.deleteRecord(e.telegramPollId);
      }
      const index: ChatIndex = { polls: kept };
      await this.write(this.indexPathOf(chatId), JSON.stringify(index, null, 2));
    });
  }

  private async readIndex(chatId: number): Promise<ChatIndex['polls']> {
    const path = this.indexPathOf(chatId);
    try {
      if (!(await this.memory.fileExists(path))) return [];
      return parseIndex(JSON.parse(await this.memory.readFile(path)) as unknown);
    } catch (err) {
      console.warn(`[telegram] poll index of chat ${String(chatId)} unreadable: ${errorMessage(err)}`);
      return [];
    }
  }

  private async write(path: string, body: string): Promise<void> {
    if (await this.memory.fileExists(path)) await this.memory.writeFile(path, body);
    else await this.memory.createFile(path, body);
  }

  private async deleteRecord(telegramPollId: string): Promise<void> {
    const path = this.pathOf(telegramPollId);
    if (await this.memory.fileExists(path)) await this.memory.delete(path);
  }

  private pathOf(telegramPollId: string): string {
    return `${DIR}/${String(this.botId)}/${safeName(telegramPollId)}.json`;
  }

  private indexPathOf(chatId: number): string {
    return `${DIR}/${String(this.botId)}/chats/${String(chatId)}.json`;
  }
}

/**
 * The step a kernel poll id belongs to: everything before the last `:`. The
 * facilitator names a poll `<stepId>:<round>` (a runoff is the same step in a
 * new round). Undefined when the id has no such part.
 */
export function stepOfPollId(pollId: string): string | undefined {
  const cut = pollId.lastIndexOf(':');
  return cut > 0 ? pollId.slice(0, cut) : undefined;
}

/** Does a poll with `newPollId` replace the open poll `oldPollId` (same step, other round)? */
export function supersedes(newPollId: string, oldPollId: string): boolean {
  const step = stepOfPollId(newPollId);
  return step !== undefined && newPollId !== oldPollId && stepOfPollId(oldPollId) === step;
}

/** The kernel option ids a Telegram answer chose, or undefined when one index is unknown. */
export function chosenOptionIds(poll: PostedPoll, optionIndexes: readonly number[]): string[] | undefined {
  const ids = optionIndexes.map((i) => poll.optionIds[i]);
  return ids.every((id): id is string => typeof id === 'string') ? ids : undefined;
}

/** Shorten to Telegram's limit; options are matched by index, so a cut label loses nothing. */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function safeName(id: string): string {
  return id.replace(/[^0-9A-Za-z_-]/g, '_');
}

function parseIndex(raw: unknown): ChatIndex['polls'] {
  if (raw === null || typeof raw !== 'object') return [];
  const polls = (raw as { polls?: unknown }).polls;
  if (!Array.isArray(polls)) return [];
  return polls.filter(
    (e): e is ChatIndex['polls'][number] =>
      e !== null &&
      typeof e === 'object' &&
      typeof (e as Record<string, unknown>)['telegramPollId'] === 'string' &&
      typeof (e as Record<string, unknown>)['postedAt'] === 'string',
  );
}

function parsePoll(raw: unknown): PostedPoll | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const isValid =
    typeof p['telegramPollId'] === 'string' &&
    typeof p['pollId'] === 'string' &&
    typeof p['chatId'] === 'number' &&
    typeof p['messageId'] === 'number' &&
    Array.isArray(p['optionIds']) &&
    p['optionIds'].every((id) => typeof id === 'string') &&
    typeof p['postedAt'] === 'string' &&
    (p['multipleAnswers'] === undefined || typeof p['multipleAnswers'] === 'boolean');
  return isValid ? (p as unknown as PostedPoll) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
