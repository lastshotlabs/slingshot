const semaphores = new Map<string, { active: number; queue: Array<() => void> }>();

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
