/** Runs `tasks` with at most `limit` in flight at once, preserving input→output order.
 *  Rejects as soon as any task throws (Promise.all semantics): the rejection propagates
 *  immediately — already-running tasks are NOT awaited, they keep running un-awaited and their
 *  eventual results/errors are discarded. Use only when a single failure should abort the batch. */
export async function runWithLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
