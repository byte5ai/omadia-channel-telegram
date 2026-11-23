/**
 * When this bot last posted into each chat. A facilitator's turn posts through
 * the bot itself while the turn runs (the handshake, a ballot); the pace
 * acknowledgement after that would announce work that was already shown
 * (telegram#8 live run). Telegram does not echo a bot's own messages back, so
 * the bot's send path records them here.
 */
export class OwnPosts {
  readonly #lastAt = new Map<number, number>();

  record(chatId: number, at: number): void {
    const previous = this.#lastAt.get(chatId);
    if (previous === undefined || at > previous) this.#lastAt.set(chatId, at);
  }

  /** Did the bot post into the chat at or after `sinceMs`? */
  since(chatId: number, sinceMs: number): boolean {
    const at = this.#lastAt.get(chatId);
    return at !== undefined && at >= sinceMs;
  }
}
