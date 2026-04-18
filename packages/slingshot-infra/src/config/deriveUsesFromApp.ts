/**
 * Derives the `uses` resource list from a runtime app config object.
 *
 * This is a best-effort heuristic that inspects the shape of a `createApp()` /
 * `createServer()` config to determine which shared infrastructure resources
 * the application needs. It is NOT a strict contract -- users can always
 * override with an explicit `uses` array in `slingshot.infra.ts`.
 *
 * Usage in `slingshot.infra.ts`:
 * ```ts
 * import { defineInfra, deriveUsesFromAppConfig } from '@lastshotlabs/slingshot-infra';
 * import appConfig from './src/appConfig';
 *
 * export default defineInfra({
 *   stacks: ['main'],
 *   uses: deriveUsesFromAppConfig(appConfig),
 * });
 * ```
 */

type MaybeDb = {
  redis?: unknown;
  mongo?: unknown;
  sqlite?: unknown;
  sessions?: unknown;
  oauthState?: unknown;
  cache?: unknown;
  auth?: unknown;
};

type MaybeSsr = {
  isr?: { adapter?: unknown };
};

/**
 * Inspect a runtime app config object and return the list of shared
 * infrastructure resource names it requires (e.g. `['postgres', 'redis']`).
 *
 * Detection rules:
 * - `db.redis` is truthy (not `false`)           -> `'redis'`
 * - `db.mongo` is truthy (not `false`)            -> `'mongo'`
 * - Any `db.*` store field equals `'postgres'`    -> `'postgres'`
 * - `jobs` is configured (BullMQ needs Redis)     -> `'redis'`
 * - `ssr.isr.adapter` is `'redis'` or object      -> `'redis'`
 *
 * The function never throws — unknown shapes are silently ignored.
 *
 * @param appConfig - A `createApp()` / `createServer()` config object cast to
 *   `Record<string, unknown>`. No validation is performed on the shape.
 * @returns Deduplicated list of resource type names.
 *
 * @example
 * ```ts
 * import { deriveUsesFromAppConfig } from '@lastshotlabs/slingshot-infra';
 * import appConfig from './src/appConfig';
 *
 * const uses = deriveUsesFromAppConfig(appConfig);
 * // uses might be ['postgres', 'redis']
 * ```
 */
export function deriveUsesFromAppConfig(appConfig: Record<string, unknown>): string[] {
  const uses = new Set<string>();

  const db = appConfig.db as MaybeDb | undefined;

  if (db) {
    // Redis: db.redis is truthy (defaults to true in the framework, so
    // we only exclude it when explicitly set to false).
    if (db.redis !== false && db.redis !== undefined) {
      uses.add('redis');
    }

    // Mongo: db.mongo is 'single' | 'separate' (truthy string)
    if (db.mongo !== false && db.mongo !== undefined) {
      uses.add('mongo');
    }

    // Postgres: any store field set to 'postgres'
    const storeFields: (keyof MaybeDb)[] = ['sessions', 'oauthState', 'cache', 'auth'];
    for (const field of storeFields) {
      if (db[field] === 'postgres') {
        uses.add('postgres');
        break;
      }
    }
  }

  // Jobs config implies BullMQ which requires Redis
  if (appConfig.jobs != null) {
    uses.add('redis');
  }

  // SSR ISR adapter: if configured as 'redis' or an object (handler ref to a
  // Redis-backed adapter), the app needs Redis for incremental static regeneration.
  const ssr = appConfig.ssr as MaybeSsr | undefined;
  if (ssr?.isr?.adapter != null && ssr.isr.adapter !== 'memory') {
    if (ssr.isr.adapter === 'redis' || typeof ssr.isr.adapter === 'object') {
      uses.add('redis');
    }
  }

  return Array.from(uses);
}

/**
 * Structured diagnostics produced by `compareInfraResources()`.
 *
 * Suitable for direct rendering in the `slingshot infra check` CLI output.
 */
export interface InfraCheckDiagnostics {
  /**
   * Resources declared in `uses` that are not defined in the platform `resources` map.
   *
   * This indicates a misconfiguration: the app claims to consume a resource that the
   * platform has not provisioned. Each entry has `resource` (the name) and `message`
   * (a human-readable description for CLI display).
   */
  warnings: { resource: string; message: string }[];
  /**
   * Resources defined in the platform `resources` map that are not referenced by any `uses`.
   *
   * Informational only — the resource exists but no app declares a dependency on it.
   * May indicate an unused provisioned resource or a missing `uses` entry. Each entry has
   * `resource` (the name) and `message` (a human-readable description for CLI display).
   */
  infos: { resource: string; message: string }[];
  /**
   * Resources auto-derived from the app config that are missing from the explicit `uses` array.
   *
   * Suggests that the developer should add these resources to `uses` in `slingshot.infra.ts`
   * so the deploy pipeline knows to provision them. Each entry has `resource` (the name)
   * and `message` (a human-readable description for CLI display).
   */
  suggestions: { resource: string; message: string }[];
}

/**
 * Compare what infra declares in `uses` against what the platform provides
 * in `resources`, and what the app config would auto-derive.
 *
 * Returns structured diagnostics suitable for the `slingshot infra check` CLI.
 *
 * @param opts.infraUses - The `uses` array from `slingshot.infra.ts` (may be empty).
 * @param opts.platformResources - Keys of `resources` from `slingshot.platform.ts`.
 * @param opts.derivedUses - Auto-derived uses from the app config (from
 *   {@link deriveUsesFromAppConfig}).
 * @returns `InfraCheckDiagnostics` with warnings, infos, and suggestions.
 *
 * @example
 * ```ts
 * import { compareInfraResources, deriveUsesFromAppConfig } from '@lastshotlabs/slingshot-infra';
 * import appConfig from './src/appConfig';
 * import platform from './slingshot.platform';
 * import infra from './slingshot.infra';
 *
 * const diagnostics = compareInfraResources({
 *   infraUses: infra.uses ?? [],
 *   platformResources: Object.keys(platform.resources ?? {}),
 *   derivedUses: deriveUsesFromAppConfig(appConfig),
 * });
 * ```
 */
export function compareInfraResources(opts: {
  /** The `uses` array from slingshot.infra.ts (or empty) */
  infraUses: string[];
  /** The keys of `resources` from slingshot.platform.ts */
  platformResources: string[];
  /** Auto-derived uses from the app config (via deriveUsesFromAppConfig) */
  derivedUses: string[];
}): InfraCheckDiagnostics {
  const { infraUses, platformResources, derivedUses } = opts;

  const platformSet = new Set(platformResources);
  const usesSet = new Set(infraUses);

  const warnings: InfraCheckDiagnostics['warnings'] = [];
  const infos: InfraCheckDiagnostics['infos'] = [];
  const suggestions: InfraCheckDiagnostics['suggestions'] = [];

  // Resources declared in uses but not provided by the platform
  for (const resource of infraUses) {
    if (!platformSet.has(resource)) {
      warnings.push({
        resource,
        message: `"${resource}" is declared in uses but not defined in platform resources`,
      });
    }
  }

  // Resources in platform but not referenced by any app's uses
  for (const resource of platformResources) {
    if (!usesSet.has(resource)) {
      infos.push({
        resource,
        message: `"${resource}" is defined in platform resources but not referenced in uses`,
      });
    }
  }

  // Resources that would be auto-derived but aren't in uses
  for (const resource of derivedUses) {
    if (!usesSet.has(resource)) {
      suggestions.push({
        resource,
        message: `"${resource}" was detected in app config but is not listed in uses`,
      });
    }
  }

  return { warnings, infos, suggestions };
}
