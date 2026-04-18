/**
 * Snapshot store — read/write entity definition snapshots for diffing.
 *
 * Snapshots are stored as JSON files in a configurable directory
 * (default: .slingshot/snapshots/).
 */
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ResolvedEntityConfig } from '../types';
import type { EntitySnapshot } from './types';

function snapshotFilename(config: ResolvedEntityConfig): string {
  return `${config._storageName}.json`;
}

/**
 * Load the most recent entity snapshot from `snapshotDir`.
 *
 * The snapshot file is located by the entity's `_storageName` (e.g.
 * `.slingshot/snapshots/chat_messages.json`). Returns `null` when no snapshot
 * exists yet (first run).
 *
 * @param snapshotDir - Directory where snapshot files are stored.
 * @param config - Current entity config used to derive the snapshot filename.
 * @returns The saved `EntitySnapshot`, or `null` if no snapshot exists.
 *
 * @example
 * ```ts
 * import { loadSnapshot } from '@lastshotlabs/slingshot-entity';
 *
 * const snapshot = loadSnapshot('.slingshot/snapshots', MessageConfig);
 * if (snapshot) {
 *   console.log('Previous snapshot from', snapshot.timestamp);
 * }
 * ```
 */
export function loadSnapshot(
  snapshotDir: string,
  config: ResolvedEntityConfig,
): EntitySnapshot | null {
  const filePath = join(snapshotDir, snapshotFilename(config));
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as EntitySnapshot;
}

/**
 * Persist the current entity definition as a snapshot file.
 *
 * The snapshot is written atomically: content is serialized to a randomly
 * named `.tmp` file in the same directory, then renamed into place. On POSIX
 * systems `rename(2)` is atomic, so concurrent CLI invocations will always
 * see a complete snapshot — never a partially written file.
 *
 * The snapshot directory is created recursively if it does not exist.
 *
 * @param snapshotDir - Directory where snapshot files are stored.
 * @param config - The current entity config to persist.
 *
 * @example
 * ```ts
 * import { saveSnapshot } from '@lastshotlabs/slingshot-entity';
 *
 * saveSnapshot('.slingshot/snapshots', MessageConfig);
 * ```
 */
export function saveSnapshot(snapshotDir: string, config: ResolvedEntityConfig): void {
  mkdirSync(snapshotDir, { recursive: true });
  const snapshot: EntitySnapshot = {
    snapshotVersion: 1,
    timestamp: new Date().toISOString(),
    entity: config,
  };
  const filePath = join(snapshotDir, snapshotFilename(config));
  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}
