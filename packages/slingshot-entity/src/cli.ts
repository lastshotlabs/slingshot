/**
 * CLI wrapper — calls generate(), handles snapshot lifecycle, writes files to disk.
 *
 * Usage:
 *   slingshot-data generate --definition ./src/entities/message.ts --outdir ./src/generated/message
 *
 * Or programmatically:
 *   import { writeGenerated } from '@lastshotlabs/slingshot-entity';
 *   writeGenerated(messageConfig, { outDir: './src/generated/message' });
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { generate } from './generate';
import type { GenerateOptions } from './generate';
import { generateMigrations } from './migrations/index';
import { loadSnapshot, saveSnapshot } from './migrations/snapshotStore';
import type { EntitySnapshot } from './migrations/types';
import type { ResolvedEntityConfig } from './types';

/**
 * Options for `writeGenerated()` — extends `GenerateOptions` with disk I/O
 * controls.
 *
 * @example
 * ```ts
 * import { writeGenerated } from '@lastshotlabs/slingshot-entity';
 * import type { WriteOptions } from '@lastshotlabs/slingshot-entity';
 * import { Message } from './message.entity';
 * import { MessageOps } from './message.operations';
 *
 * const opts: WriteOptions = {
 *   outDir: './src/generated/message',
 *   operations: MessageOps.operations,
 *   backends: ['sqlite', 'memory'],
 *   snapshotDir: '.slingshot/snapshots',
 *   migration: true,
 *   dryRun: false,
 * };
 * writeGenerated(Message, opts);
 * ```
 */
export interface WriteOptions extends GenerateOptions {
  /** Absolute or relative output directory. All generated files are written here. */
  outDir: string;
  /**
   * When true, run the full generation pipeline but skip writing to disk.
   * The returned file map is identical to a real run.
   */
  dryRun?: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (aKeys.some((key, index) => key !== bKeys[index])) return false;
  return aKeys.every(key =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * Generate source files for an entity and write them to disk.
 *
 * Wraps `generate()` with file-system I/O:
 * 1. Calls `generate(config, options)` to produce the file map.
 * 2. If `options.snapshotDir` and `options.migration` are both set, loads the
 *    previous snapshot, diffs it against `config`, and adds migration scripts
 *    to the file map **before** writing.
 * 3. Writes each file only when its content has changed (avoids unnecessary git
 *    diffs on unchanged files).
 * 4. After all files are written successfully, saves the current config as the
 *    new snapshot (so the next run can diff against it).
 *
 * @param config - Frozen entity config from `defineEntity()`.
 * @param options - Write options including the required `outDir`.
 * @returns The same `Record<filename, fileContent>` map that `generate()` returns.
 *
 * @throws {Error} When `outDir` cannot be created or a file write fails.
 *
 * @example
 * ```ts
 * import { writeGenerated } from '@lastshotlabs/slingshot-entity';
 * import { Message } from './message.entity';
 * import { MessageOps } from './message.operations';
 *
 * writeGenerated(Message, {
 *   outDir: './src/generated/message',
 *   operations: MessageOps.operations,
 *   snapshotDir: '.slingshot/snapshots',
 *   migration: true,
 * });
 * ```
 *
 * @remarks
 * The snapshot is saved **after** all writes succeed. If a write throws, the
 * snapshot is not updated — the next run will re-generate from the last
 * successful state and produce accurate migration scripts.
 */
export function writeGenerated(
  config: ResolvedEntityConfig,
  options: WriteOptions,
): Record<string, string> {
  const files = generate(config, options);

  // Migration script generation (disk read — kept out of pure generate()).
  // We diff against the prior snapshot BEFORE saving the new one so the diff
  // sees the actual previous state.
  const snapshotDir = options.snapshotDir ? resolve(options.snapshotDir) : undefined;
  const previousSnapshot: EntitySnapshot | null = snapshotDir
    ? loadSnapshot(snapshotDir, config)
    : null;

  if (snapshotDir && options.migration && previousSnapshot) {
    const migrations = generateMigrations(previousSnapshot.entity, config, options.backends);
    for (const [filename, script] of Object.entries(migrations)) {
      if (script.trim()) {
        const normalizedName = filename.startsWith('migration.')
          ? filename.slice('migration.'.length)
          : filename;
        files[`migrations/${normalizedName}`] = script;
      }
    }
  }

  if (options.dryRun) return files;

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(outDir, filename);
    // Create subdirectories (e.g. migrations/) if needed
    if (filename.includes('/')) {
      const fileDir = join(outDir, filename.split('/').slice(0, -1).join('/'));
      mkdirSync(fileDir, { recursive: true });
    }
    // Only write if content changed — avoids unnecessary git diffs
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      if (existing === content) continue;
    }
    writeFileSync(filePath, content, 'utf-8');
  }

  // Snapshot saved only after all files are written successfully — if a write
  // throws, the snapshot stays behind actual on-disk state and the next run
  // will regenerate correctly.
  const shouldAdvanceSnapshot =
    snapshotDir &&
    (options.migration ||
      previousSnapshot === null ||
      deepEqual(previousSnapshot.entity, config));

  if (shouldAdvanceSnapshot) {
    saveSnapshot(snapshotDir, config);
  }

  return files;
}
