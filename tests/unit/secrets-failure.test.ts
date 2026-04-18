/**
 * Secret resolution failure scenarios.
 *
 * Tests the fail-fast behavior of resolveSecrets() when the backing
 * repository is unavailable, slow, or returns incomplete data.
 * All tests use mock repositories — no Docker required.
 */
import { describe, expect, test } from 'bun:test';
import type { SecretRepository, SecretSchema } from '@lastshotlabs/slingshot-core';
import { resolveSecrets } from '../../src/framework/secrets/resolveSecrets';

// ---------------------------------------------------------------------------
// Mock repository helpers
// ---------------------------------------------------------------------------

function makeRepo(
  values: Record<string, string>,
  opts?: { initThrows?: Error; getManyThrows?: Error; getManyDelayMs?: number },
): SecretRepository {
  return {
    name: 'mock',
    async initialize() {
      if (opts?.initThrows) throw opts.initThrows;
    },
    async getMany(keys: string[]): Promise<ReadonlyMap<string, string>> {
      if (opts?.getManyThrows) throw opts.getManyThrows;
      if (opts?.getManyDelayMs) {
        await new Promise(r => setTimeout(r, opts.getManyDelayMs));
      }
      const map = new Map<string, string>();
      for (const key of keys) {
        if (values[key] !== undefined) map.set(key, values[key]);
      }
      return map;
    },
    async get(key: string) {
      return values[key] ?? null;
    },
  };
}

const schema: SecretSchema = {
  dbPassword: { path: '/app/db/password', required: true },
  apiKey: { path: '/app/api/key', required: true },
  optionalFlag: { path: '/app/optional/flag', required: false },
};

// ---------------------------------------------------------------------------
// Missing required secrets
// ---------------------------------------------------------------------------

describe('resolveSecrets — missing required secrets', () => {
  test('throws with clear message when a required secret is absent', async () => {
    const repo = makeRepo({ '/app/api/key': 'key-value' }); // dbPassword missing
    await expect(resolveSecrets(repo, schema)).rejects.toThrow(/Missing required secrets/);
  });

  test('error message names every missing required field', async () => {
    const repo = makeRepo({}); // both required secrets missing
    await expect(resolveSecrets(repo, schema)).rejects.toThrow(
      /"dbPassword".*"apiKey"|"apiKey".*"dbPassword"/,
    );
  });

  test('throws even when optional secret is also missing', async () => {
    const repo = makeRepo({ '/app/api/key': 'k' }); // dbPassword + optionalFlag missing
    await expect(resolveSecrets(repo, schema)).rejects.toThrow(/"dbPassword"/);
  });

  test('resolves successfully when all required secrets are present', async () => {
    const repo = makeRepo({
      '/app/db/password': 'secret',
      '/app/api/key': 'key',
    });
    const result = await resolveSecrets(repo, schema);
    expect(result.dbPassword).toBe('secret');
    expect(result.apiKey).toBe('key');
  });
});

// ---------------------------------------------------------------------------
// Optional secret missing → undefined, not empty string
// ---------------------------------------------------------------------------

describe('resolveSecrets — optional secrets', () => {
  test('optional secret absent → undefined (not empty string)', async () => {
    const repo = makeRepo({
      '/app/db/password': 'pw',
      '/app/api/key': 'k',
      // optionalFlag intentionally absent
    });
    const result = await resolveSecrets(repo, schema);
    expect(result.optionalFlag).toBeUndefined();
    expect(result.optionalFlag).not.toBe('');
  });

  test('optional secret with default uses default when absent', async () => {
    const schemaWithDefault: SecretSchema = {
      mode: { path: '/app/mode', required: false, default: 'production' },
    };
    const repo = makeRepo({});
    const result = await resolveSecrets(repo, schemaWithDefault);
    expect(result.mode).toBe('production');
  });

  test('optional secret present overrides default', async () => {
    const schemaWithDefault: SecretSchema = {
      mode: { path: '/app/mode', required: false, default: 'production' },
    };
    const repo = makeRepo({ '/app/mode': 'staging' });
    const result = await resolveSecrets(repo, schemaWithDefault);
    expect(result.mode).toBe('staging');
  });
});

// ---------------------------------------------------------------------------
// Repository failures
// ---------------------------------------------------------------------------

describe('resolveSecrets — repository failures', () => {
  test('initialize() throwing propagates immediately', async () => {
    const repo = makeRepo(
      { '/app/db/password': 'pw', '/app/api/key': 'k' },
      { initThrows: new Error('SSM unreachable') },
    );
    await expect(resolveSecrets(repo, schema)).rejects.toThrow('SSM unreachable');
  });

  test('getMany() throwing propagates immediately', async () => {
    const repo = makeRepo({}, { getManyThrows: new Error('network timeout') });
    await expect(resolveSecrets(repo, schema)).rejects.toThrow('network timeout');
  });

  test('caller can impose a timeout using Promise.race', async () => {
    // resolveSecrets has no built-in timeout — demonstrate the pattern
    const DELAY = 200;
    const TIMEOUT = 50;
    const repo = makeRepo(
      { '/app/db/password': 'pw', '/app/api/key': 'k' },
      { getManyDelayMs: DELAY },
    );
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('secrets timed out')), TIMEOUT),
    );
    await expect(Promise.race([resolveSecrets(repo, schema), timeout])).rejects.toThrow(
      'secrets timed out',
    );
  });
});

// ---------------------------------------------------------------------------
// Returned object is frozen
// ---------------------------------------------------------------------------

describe('resolveSecrets — frozen result', () => {
  test('result is frozen — mutations throw in strict mode', async () => {
    const repo = makeRepo({ '/app/db/password': 'pw', '/app/api/key': 'k' });
    const result = await resolveSecrets(repo, schema);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as any).dbPassword = 'hacked';
    }).toThrow();
  });
});
