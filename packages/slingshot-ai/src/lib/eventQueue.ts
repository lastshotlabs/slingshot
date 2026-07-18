/** A single-consumer async queue used by streaming provider transports. */
export function createEventQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;

  const notify = (): void => {
    wake?.();
    wake = null;
  };

  return {
    push(item: T): void {
      items.push(item);
      notify();
    },
    finish(): void {
      finished = true;
      notify();
    },
    fail(error: unknown): void {
      failure = error;
      finished = true;
      notify();
    },
    async *drain(): AsyncGenerator<T> {
      let cursor = 0;
      for (;;) {
        while (cursor < items.length) yield items[cursor++] as T;
        if (failure) throw failure;
        if (finished) return;
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    },
  };
}
