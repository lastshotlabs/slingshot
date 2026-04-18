/**
 * Environment variable secret repository.
 *
 * Reads secrets from process.env. Covers:
 * - Local .env files (loaded by Bun automatically)
 * - GitHub Actions secrets (injected as env vars in CI)
 * - Any platform that maps secrets to environment variables
 *
 * Factory pattern: closure-owned prefix, no module-level state.
 */
import type { SecretRepository } from '@lastshotlabs/slingshot-core';

/**
 * Create a `SecretRepository` that reads secrets from `process.env`.
 *
 * Each `get(key)` call looks up `process.env[prefix + key]`, making it
 * compatible with any platform that injects secrets as environment variables:
 * local `.env` files (loaded automatically by Bun), GitHub Actions secrets,
 * Railway, Render, Fly.io, and so on.
 *
 * Factory pattern: the `prefix` is captured in the closure — no module-level
 * state, no singletons. Each call to `createEnvSecretRepository` produces an
 * independent repository instance.
 *
 * @param opts - Optional configuration object.
 * @param opts.prefix - A string prepended to every key before the `process.env`
 *   lookup (e.g. `'MYAPP_'` maps the logical key `'JWT_SECRET'` to the env var
 *   `'MYAPP_JWT_SECRET'`). Defaults to `''` (no prefix).
 * @returns A `SecretRepository` named `'env'` that reads from `process.env`.
 *
 * @example
 * // No prefix — reads REDIS_HOST directly
 * const repo = createEnvSecretRepository();
 *
 * // With prefix — reads MY_APP_REDIS_HOST for the logical key 'REDIS_HOST'
 * const repo = createEnvSecretRepository({ prefix: 'MY_APP_' });
 */
export function createEnvSecretRepository(opts?: {
  /** Optional prefix stripped from env var names (e.g., 'MYAPP_') */
  prefix?: string;
}): SecretRepository {
  const prefix = opts?.prefix ?? '';

  return {
    name: 'env',

    get(key) {
      return Promise.resolve(process.env[prefix + key] ?? null);
    },

    getMany(keys) {
      const result = new Map<string, string>();
      for (const key of keys) {
        const val = process.env[prefix + key];
        if (val !== undefined) result.set(key, val);
      }
      return Promise.resolve(result);
    },
  };
}
