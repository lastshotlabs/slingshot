/**
 * Manifest discovery and DB connection resolution for `slingshot migrate`.
 *
 * Loads `app.manifest.json`, extracts the entity definitions and infrastructure
 * DB config, resolves entity definitions to `ResolvedEntityConfig`, and picks
 * the target backend + connection string for the migrate run.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { manifestEntitiesToConfigs } from '@lastshotlabs/slingshot-entity';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-entity';

export type Backend = 'postgres' | 'sqlite' | 'mongo';

export interface ResolvedManifest {
  manifestPath: string;
  entities: Record<string, ResolvedEntityConfig>;
  db: {
    postgres?: string;
    sqlite?: string;
    /**
     * Mongo connection comes from the `MONGO_URL` / `MONGODB_URI` env var or
     * `--db-url`, never from the manifest. This boolean only records whether
     * Mongo is enabled in the manifest's auto-connect setting.
     */
    mongoEnabled?: boolean;
  };
}

const DEFAULT_MANIFEST_PATHS = ['app.manifest.json', 'slingshot.manifest.json'];

export function loadManifest(manifestPath?: string): ResolvedManifest {
  const candidates = manifestPath ? [manifestPath] : DEFAULT_MANIFEST_PATHS;
  let resolvedPath: string | null = null;
  for (const candidate of candidates) {
    const abs = resolve(candidate);
    if (existsSync(abs)) {
      resolvedPath = abs;
      break;
    }
  }
  if (!resolvedPath) {
    throw new Error(
      `Manifest not found. Tried: ${candidates.map(p => resolve(p)).join(', ')}. ` +
        `Pass --manifest <path> to point at a specific file.`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(resolvedPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse manifest at ${resolvedPath}: ${msg}`);
  }

  const entitiesRaw = (raw.entities ?? {}) as Record<string, unknown>;
  const entities: Record<string, ResolvedEntityConfig> = {};
  if (Object.keys(entitiesRaw).length > 0) {
    const { entities: resolved } = manifestEntitiesToConfigs(
      entitiesRaw as Parameters<typeof manifestEntitiesToConfigs>[0],
    );
    for (const [name, { config }] of Object.entries(resolved)) {
      entities[name] = config;
    }
  }

  const infra = (raw.infrastructure ?? {}) as Record<string, unknown>;
  const dbSection = (infra.db ?? {}) as Record<string, unknown>;
  const mongoSetting = dbSection.mongo;
  const db = {
    postgres: typeof dbSection.postgres === 'string' ? dbSection.postgres : undefined,
    sqlite: typeof dbSection.sqlite === 'string' ? dbSection.sqlite : undefined,
    mongoEnabled:
      mongoSetting === 'single' || mongoSetting === 'separate' || mongoSetting === true,
  };

  return { manifestPath: resolvedPath, entities, db };
}

export function pickBackend(manifest: ResolvedManifest, override?: string): Backend {
  if (override === 'postgres' || override === 'sqlite' || override === 'mongo') return override;
  if (override) {
    throw new Error(
      `Unsupported backend '${override}'. Supported: postgres, sqlite, mongo.`,
    );
  }
  const configured: Backend[] = [];
  if (manifest.db.postgres) configured.push('postgres');
  if (manifest.db.mongoEnabled) configured.push('mongo');
  if (manifest.db.sqlite) configured.push('sqlite');
  if (configured.length === 0) {
    throw new Error(
      'No DB backend configured. Set infrastructure.db.postgres, .sqlite, or .mongo ' +
        'in your manifest, or pass --backend postgres|sqlite|mongo.',
    );
  }
  if (configured.length > 1) {
    throw new Error(
      `Multiple backends configured (${configured.join(', ')}). ` +
        `Pass --backend to choose which one to migrate against.`,
    );
  }
  return configured[0];
}

/**
 * Resolve a manifest value that may be a literal connection string or a
 * `${env:NAME}` / `${secret:NAME}` reference. References are looked up in
 * `process.env`. Returns `null` if a reference points at an unset env var.
 */
function expandReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^\$\{(env|secret):([A-Z0-9_]+)\}$/i.exec(value);
  if (!match) return value;
  const [, , varName] = match;
  return process.env[varName];
}

export function resolveConnectionString(
  manifest: ResolvedManifest,
  backend: Backend,
  override?: string,
): string {
  if (override) return override;

  if (backend === 'postgres') {
    const fromEnv = process.env.DATABASE_URL;
    if (fromEnv) return fromEnv;
    const fromManifest = expandReference(manifest.db.postgres);
    if (fromManifest) return fromManifest;
    throw new Error(
      'No Postgres connection string. Set DATABASE_URL env var, set ' +
        'infrastructure.db.postgres in the manifest, or pass --db-url.',
    );
  }

  if (backend === 'mongo') {
    const fromEnv = process.env.MONGODB_URI ?? process.env.MONGO_URL ?? process.env.DATABASE_URL;
    if (fromEnv) return fromEnv;
    throw new Error(
      'No Mongo connection string. Set MONGODB_URI / MONGO_URL env var, or pass --db-url.',
    );
  }

  // sqlite
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  const fromManifest = expandReference(manifest.db.sqlite);
  if (fromManifest) return fromManifest;
  throw new Error(
    'No SQLite path. Set infrastructure.db.sqlite in the manifest or pass --db-url.',
  );
}
