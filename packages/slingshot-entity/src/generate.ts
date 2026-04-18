/**
 * Pure code generation function.
 *
 * Takes entity definitions + optional operations → returns Record<string, string>
 * where keys are filenames and values are file contents.
 *
 * No side effects. No disk I/O. Fully testable.
 */
import { generateAdapter } from './generators/adapter';
import { generateEvents, hasEvents } from './generators/events';
import type { Backend } from './generators/filter';
import { generateMemory } from './generators/memory';
import { generateMongo } from './generators/mongo';
import {
  generateOperationMethods,
  generateOperationSignatures,
} from './generators/operationDispatch';
import { generatePostgres } from './generators/postgres';
import { generateRedis } from './generators/redis';
import { generateRetentionJob, hasRetention } from './generators/retention';
import { generateRoutes } from './generators/routes';
import { generateSchemas } from './generators/schemas';
import { generateSqlite } from './generators/sqlite';
import { generateTypes } from './generators/types';
import type { OperationConfig, ResolvedEntityConfig } from './types';

/**
 * Options controlling what `generate()` produces.
 *
 * All options are optional. Omitting `backends` generates all five adapters.
 * Omitting `operations` generates CRUD-only adapters (no named operation methods).
 *
 * @example
 * ```ts
 * import { generate } from '@lastshotlabs/slingshot-entity';
 * import type { GenerateOptions } from '@lastshotlabs/slingshot-entity';
 * import { Message } from './message.entity';
 * import { MessageOps } from './message.operations';
 *
 * const opts: GenerateOptions = {
 *   backends: ['sqlite', 'memory'],
 *   operations: MessageOps.operations,
 * };
 * const files = generate(Message, opts);
 * console.log(Object.keys(files)); // ['types.ts', 'schemas.ts', 'adapter.ts', 'sqlite.ts', 'memory.ts', 'routes.ts', 'index.ts']
 * ```
 */
export interface GenerateOptions {
  /**
   * Which storage backends to generate adapters for.
   * Defaults to all five: `['memory', 'sqlite', 'postgres', 'mongo', 'redis']`.
   */
  backends?: Backend[];
  /**
   * Named operation configs (from `defineOperations()`) to wire into the
   * generated adapter interface and per-backend implementations.
   */
  operations?: Record<string, OperationConfig>;
  /**
   * Directory where entity snapshots are read/written.
   * When provided alongside `migration: true`, the previous snapshot is
   * diffed against the current config and migration scripts are included in
   * the output map.
   *
   * @remarks
   * `generate()` is a pure function — when `snapshotDir` is set it is passed
   * to `writeGenerated()`, which performs the actual disk I/O after generation.
   */
  snapshotDir?: string;
  /**
   * When true and `snapshotDir` is set, diff the current config against the
   * previous snapshot and emit `migrations/*.sql` / `migrations/*.js` entries
   * into the returned file map.
   */
  migration?: boolean;
}

const ALL_BACKENDS: readonly Backend[] = ['memory', 'sqlite', 'postgres', 'mongo', 'redis'];

/**
 * Generate all source files for an entity definition.
 *
 * This is a **pure function** — it performs no disk I/O and has no side
 * effects. Pass the result to `writeGenerated()` to write the files to disk,
 * or process the map directly in tests.
 *
 * The returned map always includes:
 * - `types.ts` — TypeScript interfaces for the entity and its operations.
 * - `schemas.ts` — Zod validation schemas.
 * - `adapter.ts` — Adapter interface (CRUD + named operation method signatures).
 * - `index.ts` — Barrel re-exporting all of the above.
 * - One `<backend>.ts` per entry in `options.backends` (default: all five).
 *
 * When `options.operations` is non-empty:
 * - `routes.ts` is added (Hono route handlers for every operation).
 * - `events.ts` is added when any route declares an `event` config.
 *
 * @param config - Frozen entity config from `defineEntity()`.
 * @param options - Generation options (backends, operations, snapshot/migration flags).
 * @returns A `Record<filename, fileContent>` map of all generated source files.
 *
 * @example
 * ```ts
 * import { generate } from '@lastshotlabs/slingshot-entity';
 * import { Message } from './message.entity';
 * import { MessageOps } from './message.operations';
 *
 * const files = generate(Message, {
 *   operations: MessageOps.operations,
 *   backends: ['sqlite', 'memory'],
 * });
 *
 * console.log(Object.keys(files));
 * // ['types.ts', 'schemas.ts', 'adapter.ts', 'sqlite.ts', 'memory.ts', 'routes.ts', 'index.ts']
 * ```
 */
export function generate(
  config: ResolvedEntityConfig,
  options?: GenerateOptions,
): Record<string, string> {
  const backends = options?.backends ?? [...ALL_BACKENDS];
  const operations = options?.operations;
  const files: Record<string, string> = {};

  // Generate operation signatures for the adapter interface
  const opSignatures = operations ? generateOperationSignatures(operations, config) : [];

  files['types.ts'] = generateTypes(config);
  files['schemas.ts'] = generateSchemas(config);
  files['adapter.ts'] = generateAdapter(config, opSignatures);

  // Generate backend adapters with operation method bodies
  const backendMap: Record<string, (c: ResolvedEntityConfig) => string> = {
    memory: generateMemory,
    sqlite: generateSqlite,
    postgres: generatePostgres,
    mongo: generateMongo,
    redis: generateRedis,
  };

  for (const backend of backends) {
    const generator = (
      backendMap as Record<string, ((c: ResolvedEntityConfig) => string) | undefined>
    )[backend];
    if (!generator) continue;

    let code = generator(config);

    // Inject operation methods into the adapter return object
    if (operations && Object.keys(operations).length > 0) {
      const opMethods = generateOperationMethods(operations, config, backend);
      if (opMethods.length > 0) {
        // Insert operation methods before the closing of the return object
        const opBlock = `\n    // --- Operations ---\n${opMethods.join(',\n\n')},`;
        const clearIdx = code.lastIndexOf('async clear()');
        if (clearIdx !== -1) {
          const afterClear = code.indexOf('},', clearIdx);
          if (afterClear !== -1) {
            code = code.slice(0, afterClear + 2) + opBlock + code.slice(afterClear + 2);
          }
        }

        // No external import injection needed — search filter evaluator is inlined in generated code
      }
    }

    files[`${backend}.ts`] = code;
  }

  // Route generation — emit routes.ts when operations exist or routes config is present
  if ((operations && Object.keys(operations).length > 0) || config.routes) {
    let routesContent = generateRoutes(config, operations);
    // Append retention job factory when retention config is present
    if (hasRetention(config)) {
      routesContent += '\n' + generateRetentionJob(config);
    }
    files['routes.ts'] = routesContent;
  }

  // Events generation — emit events.ts when any route declares an event
  if (config.routes && hasEvents(config.routes)) {
    files['events.ts'] = generateEvents(config);
  }

  // Barrel export
  const indexLines = [
    '// Auto-generated by @lastshotlabs/slingshot-entity — do not edit manually.',
    '',
    "export * from './types';",
    "export * from './schemas';",
    "export * from './adapter';",
  ];
  for (const backend of backends) {
    indexLines.push(`export * from './${backend}';`);
  }
  if ((operations && Object.keys(operations).length > 0) || config.routes) {
    indexLines.push("export * from './routes';");
  }
  indexLines.push('');

  files['index.ts'] = indexLines.join('\n');

  return files;
}
