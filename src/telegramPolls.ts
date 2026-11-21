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
 * Limits, documented in the README:
 *  - single choice only: `SendPoll` does not say whether a vote takes several
 *    options, and a multiple-answer poll would let a single-choice voter cast
 *    a ballot the engine refuses. Several approvals can still be written as
 *    a text ballot.
 *  - a retracted vote (`option_ids: []`) is not reported: the kernel has no
 *    form for "no answer", so the last ballot stays until it is changed.
 *  - an anonymous administrator votes as the chat (`voter_chat`, no `user`):
 *    no person is known, nothing is reported.
 */

import type { MemoryStoreShim } from './kernel-types.js';

const DIR = '/memories/pairings/polls';
/** Bot API sendPoll limits (https://core.telegram.org/bots/api#sendpoll). */
export const TELEGRAM_POLL_QUESTION_MAX = 300;
export const TELEGRAM_POLL_OPTION_MAX = 100;
export const TELEGRAM_POLL_OPTIONS_MIN = 2;
export const TELEGRAM_POLL_OPTIONS_MAX = 10;

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
}

export class TelegramPollStore {
  private readonly loaded = new Map<string, PostedPoll>();

  constructor(
    private readonly memory: MemoryStoreShim,
    private readonly botId: number,
  ) {}

  async remember(poll: PostedPoll): Promise<void> {
    this.loaded.set(poll.telegramPollId, poll);
    const path = this.pathOf(poll.telegramPollId);
    const body = JSON.stringify(poll, null, 2);
    try {
      if (await this.memory.fileExists(path)) await this.memory.writeFile(path, body);
      else await this.memory.createFile(path, body);
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
      if (poll) this.loaded.set(telegramPollId, poll);
      return poll;
    } catch (err) {
      console.warn(`[telegram] poll ${telegramPollId} unreadable: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private pathOf(telegramPollId: string): string {
    const safe = telegramPollId.replace(/[^0-9A-Za-z_-]/g, '_');
    return `${DIR}/${String(this.botId)}/${safe}.json`;
  }
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
    typeof p['postedAt'] === 'string';
  return isValid ? (p as unknown as PostedPoll) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
