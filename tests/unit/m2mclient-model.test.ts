import { describe, expect, test } from 'bun:test';

describe('M2MClient model import', () => {
  test("M2MClient can be imported without a 'Cannot find module' error", async () => {
    // This test specifically guards against the wrong-path require bug.
    // The import will succeed (no module-not-found error).
    // Accessing a property may throw 'authConnection not initialized' — that is expected
    // and CORRECT (means the import path is right, just no Mongo connection in tests).
    let importError: Error | null = null;
    try {
      const mod = (await import('@auth/models/M2MClient')) as any;
      const { M2MClient } = mod;
      // Trigger the proxy getter to exercise the import path
      try {
        void M2MClient?.modelName;
      } catch (proxyErr: any) {
        // Expected: mongoose may throw about no connection, but NOT about a missing module
        if ((proxyErr?.message ?? '').includes('Cannot find module')) {
          importError = proxyErr;
        }
      }
    } catch (err: any) {
      importError = err;
    }

    expect(importError).toBeNull();
  });
});
