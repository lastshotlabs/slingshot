/**
 * Cross-adapter parity tests for refresh-token lookup behavior.
 *
 * The current adapter contract returns session metadata plus `fromGrace`.
 * Lookup calls do not expose a plaintext replacement refresh token.
 */
import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { createSqliteAuthAdapter } from '@auth/adapters/sqliteAuth';
import { createAuthResolvedConfig } from '@auth/config/authConfig';
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const graceConfig = createAuthResolvedConfig({ refreshToken: { rotationGraceSeconds: 30 } });
const shortGraceConfig = createAuthResolvedConfig({ refreshToken: { rotationGraceSeconds: 1 } });

// ---------------------------------------------------------------------------
// Shared scenario runner
// ---------------------------------------------------------------------------

type AdapterFns = {
  createSession: (userId: string, token: string, sessionId: string) => void | Promise<void>;
  setRefreshToken: (sessionId: string, refreshToken: string) => void | Promise<void>;
  getSessionByRefreshToken: (refreshToken: string) => any | Promise<any>;
  rotateRefreshToken: (
    sessionId: string,
    newRefreshToken: string,
    newAccessToken: string,
  ) => void | Promise<void>;
  useShortGraceWindow: () => void;
};

function runParityTests(adapterName: string, adapter: AdapterFns) {
  describe(`[${adapterName}] refresh token grace window parity`, () => {
    test('current token lookup does not expose a replacement token', async () => {
      await adapter.createSession('user1', 'access-1', 'sid-parity-1');
      await adapter.setRefreshToken('sid-parity-1', 'refresh-plain-1');

      const result = await adapter.getSessionByRefreshToken('refresh-plain-1');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sid-parity-1');
      expect(result!.userId).toBe('user1');
      expect(result!.fromGrace).toBe(false);
      expect('newRefreshToken' in result!).toBe(false);
    });

    test('grace window lookup marks the result as coming from grace', async () => {
      await adapter.createSession('user1', 'access-1', 'sid-parity-2');
      await adapter.setRefreshToken('sid-parity-2', 'refresh-1');
      await adapter.rotateRefreshToken('sid-parity-2', 'refresh-2', 'access-2');

      const graceResult = await adapter.getSessionByRefreshToken('refresh-1');
      expect(graceResult).not.toBeNull();
      expect(graceResult!.sessionId).toBe('sid-parity-2');
      expect(graceResult!.userId).toBe('user1');
      expect(graceResult!.fromGrace).toBe(true);
      expect('newRefreshToken' in graceResult!).toBe(false);
    });

    test('new token after rotation resolves without grace metadata', async () => {
      await adapter.createSession('user1', 'access-1', 'sid-parity-3');
      await adapter.setRefreshToken('sid-parity-3', 'refresh-1');
      await adapter.rotateRefreshToken('sid-parity-3', 'refresh-2', 'access-2');

      const result = await adapter.getSessionByRefreshToken('refresh-2');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sid-parity-3');
      expect(result!.userId).toBe('user1');
      expect(result!.fromGrace).toBe(false);
      expect('newRefreshToken' in result!).toBe(false);
    });

    test('token before last rotation returns null (not in grace window)', async () => {
      await adapter.createSession('user1', 'access-1', 'sid-parity-4');
      await adapter.setRefreshToken('sid-parity-4', 'refresh-1');
      await adapter.rotateRefreshToken('sid-parity-4', 'refresh-2', 'access-2');
      await adapter.rotateRefreshToken('sid-parity-4', 'refresh-3', 'access-3');

      const result = await adapter.getSessionByRefreshToken('refresh-1');
      expect(result).toBeNull();
    });

    test('old token after grace window expiry triggers theft detection (session deleted)', async () => {
      adapter.useShortGraceWindow();

      await adapter.createSession('user1', 'access-1', 'sid-parity-5');
      await adapter.setRefreshToken('sid-parity-5', 'refresh-1');
      await adapter.rotateRefreshToken('sid-parity-5', 'refresh-2', 'access-2');

      await Bun.sleep(1100);

      const result = await adapter.getSessionByRefreshToken('refresh-1');
      expect(result).toBeNull();
    });

    test('unknown token returns null', async () => {
      const result = await adapter.getSessionByRefreshToken('completely-unknown-token');
      expect(result).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// Register tests for each adapter
// ---------------------------------------------------------------------------

describe('memory adapter', () => {
  let currentConfig = graceConfig;
  const getConfig = () => currentConfig;

  beforeEach(() => {
    currentConfig = graceConfig;
    memAdapter = createMemoryAuthAdapter(getConfig);
  });

  let memAdapter: ReturnType<typeof createMemoryAuthAdapter>;

  runParityTests('memory', {
    createSession: (userId, token, sessionId) => {
      memAdapter.memoryCreateSession(userId, token, sessionId);
    },
    setRefreshToken: (sessionId, refreshToken) => {
      memAdapter.memorySetRefreshToken(sessionId, refreshToken);
    },
    getSessionByRefreshToken: refreshToken => {
      return memAdapter.memoryGetSessionByRefreshToken(refreshToken);
    },
    rotateRefreshToken: (sessionId, newRefreshToken, newAccessToken) => {
      memAdapter.memoryRotateRefreshToken(sessionId, newRefreshToken, newAccessToken);
    },
    useShortGraceWindow: () => {
      currentConfig = shortGraceConfig;
    },
  });
});

describe('sqlite adapter', () => {
  let sqlResult: ReturnType<typeof createSqliteAuthAdapter>;
  let currentGetConfig = () => graceConfig;

  beforeEach(() => {
    currentGetConfig = () => graceConfig;
    sqlResult = createSqliteAuthAdapter(new Database(':memory:'));
    sqlResult.db.run('DELETE FROM sessions');
  });

  runParityTests('sqlite', {
    createSession: (userId, token, sessionId) => {
      sqlResult.createSession(userId, token, sessionId, currentGetConfig);
    },
    setRefreshToken: (sessionId, refreshToken) => {
      sqlResult.setRefreshToken(sessionId, refreshToken);
    },
    getSessionByRefreshToken: refreshToken => {
      return sqlResult.getSessionByRefreshToken(refreshToken, currentGetConfig);
    },
    rotateRefreshToken: (sessionId, newRefreshToken, newAccessToken) => {
      sqlResult.rotateRefreshToken(sessionId, newRefreshToken, newAccessToken, currentGetConfig);
    },
    useShortGraceWindow: () => {
      currentGetConfig = () => shortGraceConfig;
    },
  });
});
