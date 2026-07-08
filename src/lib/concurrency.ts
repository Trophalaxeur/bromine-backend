/** Runs `tasks` with at most `limit` in flight at once, preserving input→output order.
 *  Rejects as soon as any task throws (Promise.all semantics): the first rejection is what the
 *  caller sees and the batch is failed from that point. The other in-flight workers are NOT
 *  cancelled — they run to completion and their results (and any later errors) are discarded, but
 *  Promise.all still tracks them, so those errors never surface as unhandled rejections.
 *  Use only when a single failure should abort the batch. */
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
