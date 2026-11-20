/**
 * Questions this bot posted as numbered text and still waits answers for
 * (spec 2042 §5.14 channel parity, criterion 30).
 *
 * Telegram renders no question cards, so a card or a poll goes out as text
 * (`renderCardAsText`) and is answered by a typed reply, parsed by the SDK's
 * `parseCardReply` into the same typed values a card submission carries. This
 * store remembers what was asked, so that a reply can be matched to it:
 *
 *  - in a group a reply counts only when it is a Telegram *reply to the card
 *    message*. Telegram delivers such replies to the bot even with BotFather
 *    privacy mode on, and a loose "1" in a group is just a message;
 *  - in a private chat the next message answers the question when exactly one
 *    is open there.
 *
 * Open questions survive a restart (persisted next to the pairings), so a vote
 * posted before a deploy still counts. A question is closed by its `closesAt`
 * or, without one, expires after {@link DEFAULT_OPEN_MS}.
 */

import type { CardQuestion } from '@omadia/plugin-api';

import type { MemoryStoreShim } from './kernel-types.js';

const DIR = '/memories/pairings/open-cards';

/** How long a question without `closesAt` stays answerable. */
export const DEFAULT_OPEN_MS = 14 * 24 * 60 * 60 * 1000;

/** At most this many open questions are kept per chat; the oldest drops first. */
export const MAX_OPEN_PER_CHAT = 20;

export interface OpenCard {
  /** `cardAnswer.cardId`: the card's id, or the poll's id. */
  readonly cardId: string;
  readonly kind: 'card' | 'poll';
  readonly chatId: number;
  /** The Bot API `message_id` of the posted text. */
  readonly messageId: number;
  /** The single question (the channel declares `maxQuestions: 1`). */
  readonly question: CardQuestion;
  readonly proposalId?: string;
  readonly proposalVersion?: number;
  /** ISO 8601. */
  readonly closesAt: string;
  readonly changeable: boolean;
  /** Telegram user ids that already answered (for `changeable: false`). */
  readonly answeredBy: readonly number[];
}

export class OpenCardStore {
  private readonly cache = new Map<number, readonly OpenCard[]>();
  private readonly hydrated = new Set<number>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly memory: MemoryStoreShim | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read the stored questions of a chat into memory (once). */
  async hydrate(chatId: number): Promise<void> {
    if (this.hydrated.has(chatId)) return;
    this.hydrated.add(chatId);
    if (!this.memory) return;
    const path = cardsPath(chatId);
    try {
      if (!(await this.memory.fileExists(path))) return;
      const stored = JSON.parse(await this.memory.readFile(path)) as OpenCard[];
      const live = this.cache.get(chatId) ?? [];
      const liveIds = new Set(live.map((c) => c.cardId));
      this.cache.set(chatId, [...stored.filter((c) => !liveIds.has(c.cardId)), ...live]);
    } catch (err) {
      console.warn(`[telegram] open questions of chat ${String(chatId)} unreadable: ${errorMessage(err)}`);
    }
  }

  /** Remember a question just posted; a card with the same id is replaced. */
  async add(card: Omit<OpenCard, 'answeredBy'>): Promise<void> {
    await this.hydrate(card.chatId);
    const kept = (this.cache.get(card.chatId) ?? []).filter((c) => c.cardId !== card.cardId);
    this.write(card.chatId, [...kept, { ...card, answeredBy: [] }].slice(-MAX_OPEN_PER_CHAT));
  }

  /** The question a message answers, or `undefined`. See the file header for the rules. */
  async match(input: {
    readonly chatId: number;
    readonly isPrivate: boolean;
    readonly replyToMessageId?: number;
  }): Promise<{ readonly card: OpenCard; readonly isClosed: boolean } | undefined> {
    await this.hydrate(input.chatId);
    const all = this.cache.get(input.chatId) ?? [];
    const candidates =
      input.replyToMessageId !== undefined
        ? all.filter((c) => c.messageId === input.replyToMessageId)
        : input.isPrivate
          ? all.filter((c) => Date.parse(c.closesAt) > this.now())
          : [];
    if (input.replyToMessageId === undefined && candidates.length !== 1) return undefined;
    const card = candidates[0];
    if (!card) return undefined;
    return { card, isClosed: Date.parse(card.closesAt) <= this.now() };
  }

  /** Record that a person answered (`changeable: false` refuses a second answer). */
  markAnswered(card: OpenCard, userId: number): void {
    const list = this.cache.get(card.chatId) ?? [];
    this.write(
      card.chatId,
      list.map((c) =>
        c.cardId === card.cardId && !c.answeredBy.includes(userId)
          ? { ...c, answeredBy: [...c.answeredBy, userId] }
          : c,
      ),
    );
  }

  /** Resolves when every queued write has been attempted (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writes;
  }

  private write(chatId: number, list: readonly OpenCard[]): void {
    const live = list.filter((c) => Date.parse(c.closesAt) + DEFAULT_OPEN_MS > this.now());
    this.cache.set(chatId, live);
    if (!this.memory) return;
    const memory = this.memory;
    this.writes = this.writes.then(async () => {
      const path = cardsPath(chatId);
      const body = JSON.stringify(live, null, 2);
      try {
        if (await memory.fileExists(path)) await memory.writeFile(path, body);
        else await memory.createFile(path, body);
      } catch (err) {
        console.warn(`[telegram] open questions of chat ${String(chatId)} not persisted: ${errorMessage(err)}`);
      }
    });
  }
}

function cardsPath(chatId: number): string {
  return `${DIR}/${String(chatId).replace(/[^0-9A-Za-z-]/g, '_')}.json`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
