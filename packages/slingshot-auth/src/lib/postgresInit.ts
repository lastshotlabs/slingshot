import type { Pool, PoolClient } from 'pg';

export function createPostgresInitializer(
  pool: Pool,
  initSchema: (client: PoolClient) => Promise<void>,
): () => Promise<void> {
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;

  return async () => {
    if (initialized) return;
    if (initializationPromise) {
      await initializationPromise;
      return;
    }

    initializationPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await initSchema(client);
        await client.query('COMMIT');
        initialized = true;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original bootstrap failure.
        }
        throw error;
      } finally {
        client.release();
      }
    })();

    try {
      await initializationPromise;
    } finally {
      initializationPromise = null;
    }
  };
}
