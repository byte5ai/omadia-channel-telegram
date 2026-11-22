/**
 * Runs async work one after another per key, in the order it was queued.
 *
 * Used where Telegram delivers updates concurrently (a webhook does not wait
 * for the previous request) but their order matters: two answers of one
 * person in one poll, two writes of one chat's poll index. Different keys run
 * in parallel. A failing job never blocks the next one; its error goes to the
 * caller of `run`, not to the queue.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(job, job);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Forget the key once nothing is queued behind this job.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with queued or running work (for tests and diagnostics). */
  get size(): number {
    return this.tails.size;
  }
}
