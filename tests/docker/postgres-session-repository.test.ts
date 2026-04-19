import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import { createAuthResolvedConfig } from '../../packages/slingshot-auth/src/config/authConfig';
import { createPostgresSessionRepository } from '../../packages/slingshot-auth/src/lib/session/postgresStore';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

describe('Postgres session repository (docker)', () => {
  let pool: Pool;
  let repo: ReturnType<typeof createPostgresSessionRepository>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    repo = createPostgresSessionRepository(pool);
    await repo.createSession('bootstrap-user', 'bootstrap-token', 'bootstrap-session');
    await repo.deleteSession('bootstrap-session');
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM auth_sessions');
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS auth_sessions');
    await pool.end();
  });

  it('keeps concurrent login bursts for one user at maxSessions', async () => {
    const cfg = createAuthResolvedConfig({ persistSessionMetadata: false });
    const userId = `burst-user-${Date.now()}`;
    const maxSessions = 3;

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.atomicCreateSession(userId, `token-${i}`, `sess-${i}`, maxSessions, undefined, cfg),
      ),
    );

    expect(await repo.getActiveSessionCount(userId, cfg)).toBe(maxSessions);

    const sessions = await repo.getUserSessions(userId, cfg);
    expect(sessions.filter(session => session.isActive)).toHaveLength(maxSessions);
    expect(new Set(sessions.map(session => session.sessionId)).size).toBe(maxSessions);
  });
});
