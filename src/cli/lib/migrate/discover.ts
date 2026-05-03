/**
 * Config discovery and DB connection resolution for `slingshot migrate`.
 *
 * Loads `app.config.ts`, walks the plugins array to find `createEntityPlugin`
 * instances, extracts their entity definitions, and resolves the DB backend
 * + connection string for the migrate run.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  getEntityPluginToolingMetadata,
  manifestEntitiesToConfigs,
} from '@lastshotlabs/slingshot-entity';
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
     * `--db-url`, never from the config. This boolean only records whether
     * Mongo is enabled in the config's auto-connect setting.
     */
    mongoEnabled?: boolean;
  };
}

const DEFAULT_CONFIG_PATHS = ['app.config.ts', 'app.config.js'];

function addManifestEntities(
  target: Record<string, ResolvedEntityConfig>,
  entitiesRaw: Record<string, unknown>,
): void {
  const { entities: resolved } = manifestEntitiesToConfigs(
    entitiesRaw as Parameters<typeof manifestEntitiesToConfigs>[0],
  );
  for (const [name, { config: resolvedConfig }] of Object.entries(resolved)) {
    target[name] = resolvedConfig;
  }
}

export async function loadManifest(configPath?: string): Promise<ResolvedManifest> {
  const candidates = configPath ? [configPath] : DEFAULT_CONFIG_PATHS;
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
      `App config not found. Tried: ${candidates.map(p => resolve(p)).join(', ')}. ` +
        `Pass --config <path> to point at a specific file.`,
    );
  }

  let mod: { default?: unknown };
  try {
    mod = (await import(resolvedPath)) as { default?: unknown };
  } catch (err) {
    throw new Error(`Failed to load app config at ${resolvedPath}`, { cause: err });
  }

  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(
      `${resolvedPath} must export a default value from defineApp(...). ` +
        `Example: export default defineApp({ ... });`,
    );
  }

  const config = mod.default as { plugins?: unknown[]; db?: Record<string, unknown> };

  const entities: Record<string, ResolvedEntityConfig> = {};
  for (const plugin of config.plugins ?? []) {
    const metadata = getEntityPluginToolingMetadata(plugin);
    if (!metadata) continue;

    if (metadata.manifest) {
      addManifestEntities(entities, metadata.manifest.entities as Record<string, unknown>);
      continue;
    }

    for (const entry of metadata.entries) {
      entities[entry.config.name] = entry.config;
    }
  }

  const dbSection = (config.db ?? {}) as Record<string, unknown>;
  const mongoSetting = dbSection.mongo;
  const db = {
    postgres: typeof dbSection.postgres === 'string' ? dbSection.postgres : undefined,
    sqlite: typeof dbSection.sqlite === 'string' ? dbSection.sqlite : undefined,
    mongoEnabled: mongoSetting === 'single' || mongoSetting === 'separate' || mongoSetting === true,
  };

  return { manifestPath: resolvedPath, entities, db };
}

export function pickBackend(manifest: ResolvedManifest, override?: string): Backend {
  if (override === 'postgres' || override === 'sqlite' || override === 'mongo') return override;
  if (override) {
    throw new Error(`Unsupported backend '${override}'. Supported: postgres, sqlite, mongo.`);
  }
  const configured: Backend[] = [];
  if (manifest.db.postgres) configured.push('postgres');
  if (manifest.db.mongoEnabled) configured.push('mongo');
  if (manifest.db.sqlite) configured.push('sqlite');
  if (configured.length === 0) {
    throw new Error(
      'No DB backend configured. Set db.postgres, db.sqlite, or db.mongo in your ' +
        'app.config.ts, or pass --backend postgres|sqlite|mongo.',
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
 * Resolve a config value that may be a literal connection string or a
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
    const fromConfig = expandReference(manifest.db.postgres);
    if (fromConfig) return fromConfig;
    throw new Error(
      'No Postgres connection string. Set DATABASE_URL env var, set ' +
        'db.postgres in app.config.ts, or pass --db-url.',
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
  const fromConfig = expandReference(manifest.db.sqlite);
  if (fromConfig) return fromConfig;
  throw new Error('No SQLite path. Set db.sqlite in app.config.ts or pass --db-url.');
}
