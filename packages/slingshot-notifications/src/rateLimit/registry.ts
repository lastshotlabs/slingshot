import {
  type RateLimitBackend,
  createInMemoryRateLimitBackend,
  createNoopRateLimitBackend,
} from './backend';

const registry = new Map<string, () => RateLimitBackend>([
  ['memory', createInMemoryRateLimitBackend],
  ['noop', createNoopRateLimitBackend],
]);

/**
 * Register a named notification rate-limit backend.
 *
 * @param name - Backend name.
 * @param factory - Factory creating a fresh backend instance.
 */
export function registerRateLimitBackend(name: string, factory: () => RateLimitBackend): void {
  registry.set(name, factory);
}

/**
 * Resolve a named notification rate-limit backend.
 *
 * @param name - Backend name.
 * @returns A fresh backend instance.
 */
export function resolveRateLimitBackend(name: string): RateLimitBackend {
  const factory = registry.get(name);
  if (!factory) {
    const known = [...registry.keys()].sort().join(', ');
    throw new Error(
      `[slingshot-notifications] Unknown rate-limit backend "${name}". Known: ${known}`,
    );
  }
  return factory();
}
