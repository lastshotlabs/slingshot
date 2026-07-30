import type { PostgresBundle, SlingshotEvents } from '@lastshotlabs/slingshot-core';
import {
  createEventDefinitionRegistry,
  createEventPublisher,
  createEventSchemaRegistry,
  createEventVersionRegistry,
  createInProcessAdapter,
} from '@lastshotlabs/slingshot-core';
import type { EventReliabilityOperations } from '@lastshotlabs/slingshot-events';
import type { EventReplayValidator } from '@lastshotlabs/slingshot-events';
import {
  createEventReplayValidator,
  createPostgresEventReliabilityOperations,
  createSqliteEventReliabilityOperations,
} from '@lastshotlabs/slingshot-events';
import { loadManifest, resolveConnectionString } from '../migrate/discover';

export interface EventOperationsHandle {
  readonly appName: string;
  readonly store: 'postgres' | 'sqlite';
  readonly operations: EventReliabilityOperations;
  close(): Promise<void>;
}

/** Build the CLI replay validator from the same pure contract callback used at app boot. */
export function createCliEventReplayValidator(
  registerContracts: ((events: SlingshotEvents) => void) | undefined,
): EventReplayValidator | undefined {
  if (!registerContracts) return undefined;
  const schemas = createEventSchemaRegistry();
  const definitions = createEventDefinitionRegistry({ schemaRegistry: schemas });
  const versions = createEventVersionRegistry();
  const events = createEventPublisher({
    definitions,
    schemas,
    versions,
    bus: createInProcessAdapter({ schemaRegistry: schemas, validation: 'off' }),
  });
  registerContracts(events);
  definitions.freeze();
  versions.freeze();
  return createEventReplayValidator({ definitions, schemas, versions });
}

/** Resolve the configured reliability store and open one CLI-owned connection. */
export async function openEventOperations(input: {
  config?: string;
  dbUrl?: string;
}): Promise<EventOperationsHandle> {
  const manifest = await loadManifest(input.config);
  const store = manifest.events?.reliability?.store;
  if (store !== 'postgres' && store !== 'sqlite') {
    throw new Error('events.reliability.store must be configured as postgres or sqlite.');
  }
  const connectionString = resolveConnectionString(manifest, store, input.dbUrl);
  const replayValidator = createCliEventReplayValidator(manifest.events?.registerContracts);
  if (store === 'postgres') {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString });
    return {
      appName: manifest.appName,
      store,
      operations: createPostgresEventReliabilityOperations(
        {
          pool,
        } as unknown as PostgresBundle,
        { replayValidator },
      ),
      async close() {
        await pool.end();
      },
    };
  }
  const { nodeRuntime } = await import('@lastshotlabs/slingshot-runtime-node');
  const db = nodeRuntime().sqlite.open(connectionString);
  return {
    appName: manifest.appName,
    store,
    operations: createSqliteEventReliabilityOperations(db, { replayValidator }),
    async close() {
      db.close();
    },
  };
}

/** Parse an operator duration such as `30m`, `24h`, or `7d`. */
export function durationBefore(value: string, now = Date.now()): string {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) throw new Error("Duration must use '<integer>m', '<integer>h', or '<integer>d'.");
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Duration must be positive.');
  const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return new Date(now - amount * unitMs).toISOString();
}

export function requireExactConfirmation(actual: string, supplied: string | undefined): void {
  if (supplied !== actual) {
    throw new Error(`Refusing mutation: pass --confirm ${JSON.stringify(actual)} exactly.`);
  }
}
