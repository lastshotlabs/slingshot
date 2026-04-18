/**
 * Notification-scoped rate-limit backend contract.
 */
export interface RateLimitBackend {
  check(key: string, limit: number, windowMs: number): Promise<boolean>;
  clear?(): void;
  close?(): Promise<void>;
}

/**
 * Closure-owned in-memory fixed-window backend.
 */
export function createInMemoryRateLimitBackend(): RateLimitBackend {
  interface Entry {
    count: number;
    windowStart: number;
  }

  const entries = new Map<string, Entry>();

  return {
    check(key, limit, windowMs) {
      const now = Date.now();
      const entry = entries.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        entries.set(key, { count: 1, windowStart: now });
        return Promise.resolve(true);
      }

      if (entry.count >= limit) return Promise.resolve(false);
      entry.count += 1;
      return Promise.resolve(true);
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * Backend that never rate-limits.
 */
export function createNoopRateLimitBackend(): RateLimitBackend {
  return {
    check() {
      return Promise.resolve(true);
    },
  };
}
