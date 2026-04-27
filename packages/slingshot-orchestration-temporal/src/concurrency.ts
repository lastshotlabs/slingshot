const semaphores = new Map<string, { active: number; queue: Array<() => void> }>();

/**
 * Execute `fn` subject to a per-task concurrency cap.
 *
 * **Concurrency limits are enforced per worker process.**
 * If multiple Temporal workers run the same task type, each worker enforces its
 * own limit independently. There is no cross-process coordination — the total
 * in-flight count across N workers can reach `limit * N`.
 *
 * Pass `limit = undefined` (or `0`) to run with no concurrency restriction.
 */
export async function withTaskConcurrency<T>(
  taskName: string,
  limit: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!limit || limit < 1) {
    return fn();
  }

  const state = semaphores.get(taskName) ?? { active: 0, queue: [] };
  semaphores.set(taskName, state);

  if (state.active >= limit) {
    await new Promise<void>(resolve => {
      state.queue.push(resolve);
    });
  }

  state.active += 1;
  try {
    return await fn();
  } finally {
    state.active -= 1;
    const next = state.queue.shift();
    next?.();
  }
}
