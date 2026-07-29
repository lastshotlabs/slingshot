import { EventReliabilityTopologyError } from '../errors';
import type { EventReliabilityMigration } from './types';

/** Minimal package-internal migration session implemented by each SQL provider. */
export interface EventReliabilityMigrationSession {
  readonly applied: ReadonlyMap<number, string>;
  execute(statement: string): Promise<void>;
  record(version: number, checksum: string): Promise<void>;
}

/** Opens one provider-owned transaction protected by its migration coordinator. */
export interface EventReliabilityMigrationProvider {
  transaction(
    callback: (session: EventReliabilityMigrationSession) => Promise<void>,
  ): Promise<void>;
}

/** Apply checksum-versioned event reliability migrations exactly once. */
export async function applyEventReliabilityMigrations(
  provider: EventReliabilityMigrationProvider,
  migrations: readonly EventReliabilityMigration[],
): Promise<void> {
  await provider.transaction(async session => {
    for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
      const appliedChecksum = session.applied.get(migration.version);
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== migration.checksum) {
          throw new EventReliabilityTopologyError(
            `Event reliability migration ${migration.version} checksum mismatch.`,
          );
        }
        continue;
      }
      for (const statement of migration.statements) {
        await session.execute(statement);
      }
      await session.record(migration.version, migration.checksum);
    }
  });
}
