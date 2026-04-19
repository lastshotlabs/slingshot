import { getPostgresPoolRuntime } from '@lastshotlabs/slingshot-core';

interface PostgresQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

interface PostgresClient extends PostgresQueryable {
  release(): void;
}

interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresClient>;
}

export function createPostgresInitializer(
  pool: PostgresPool,
  initSchema: (client: PostgresClient) => Promise<void>,
): () => Promise<void> {
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;

  return async () => {
    if (initialized) return;
    if (getPostgresPoolRuntime(pool)?.migrationMode === 'assume-ready') {
      initialized = true;
      return;
    }
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
