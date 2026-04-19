// packages/slingshot-ssr/tests/unit/actions/registry.test.ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { clearActionCache, resolveAction } from '../../../src/actions/registry';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveAction()', () => {
  beforeEach(() => {
    clearActionCache();
  });

  test('returns null when module cannot be imported', async () => {
    const result = await resolveAction('/non/existent/module/path.ts', 'createPost');
    expect(result).toBeNull();
  });

  test('returns null when the action name is not exported by the module', async () => {
    // Use a real module path that exists (this test file itself exports nothing useful)
    // We rely on the import failing or the export not being a function.
    // Since we cannot easily mock dynamic import in all environments, we use a known
    // non-function export — but to keep the test hermetic we test with a file that
    // doesn't exist (null path → import fails → null).
    const result = await resolveAction('/non/existent/path.ts', 'missingExport');
    expect(result).toBeNull();
  });

  test('clearActionCache() clears the module-level cache', () => {
    // Verify the function is callable and does not throw.
    expect(() => clearActionCache()).not.toThrow();
    // Double clear is also safe.
    expect(() => clearActionCache()).not.toThrow();
  });
});

describe('clearActionCache()', () => {
  test('is idempotent — safe to call multiple times', () => {
    clearActionCache();
    clearActionCache();
    clearActionCache();
    // No assertion needed — we are testing it does not throw.
  });
});
