/**
 * Route discovery and mounting — extracted from createApp().
 *
 * Handles both versioned (routes/v1/, routes/v2/, ...) and non-versioned
 * (routes/**) discovery. Each versioned sub-app gets its own OpenAPI spec,
 * Scalar docs, and schema stripping pass.
 */
import { getRefId } from '@asteasolutions/zod-to-openapi';
import type { VersioningConfig } from '@config/types/versioning';
import { stripUnreferencedSchemas } from '@framework/lib/stripUnreferencedSchemas';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { defaultHook } from '@lastshotlabs/slingshot-core';
import type { AppEnv, RuntimeGlob } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Route module shape
// ---------------------------------------------------------------------------

/** Shape of a dynamically imported route module. */
interface RouteModule {
  router?: OpenAPIHono<AppEnv>;
  priority?: number;
}

type OpenApiDefinition =
  | {
      type: 'component';
      componentType: Parameters<OpenAPIHono<AppEnv>['openAPIRegistry']['registerComponent']>[0];
      name: string;
      component: unknown;
    }
  | {
      type: 'route';
      route: Parameters<OpenAPIHono<AppEnv>['openAPIRegistry']['registerPath']>[0];
    }
  | {
      type: 'webhook';
      webhook: Parameters<OpenAPIHono<AppEnv>['openAPIRegistry']['registerWebhook']>[0];
    }
  | {
      type: 'parameter';
      schema: Parameters<OpenAPIHono<AppEnv>['openAPIRegistry']['registerParameter']>[1];
    };

function mergeOpenApiDefinitions(
  target: OpenAPIHono<AppEnv>,
  router: RouteModule['router'] | undefined,
): void {
  const definitions = (router as { openAPIRegistry?: { definitions?: unknown[] } } | undefined)
    ?.openAPIRegistry?.definitions;
  if (!Array.isArray(definitions)) return;

  for (const definition of definitions as OpenApiDefinition[]) {
    try {
      switch (definition.type) {
        case 'component':
          target.openAPIRegistry.registerComponent(
            definition.componentType,
            definition.name,
            definition.component,
          );
          break;
        case 'route':
          target.openAPIRegistry.registerPath(definition.route);
          break;
        case 'webhook':
          target.openAPIRegistry.registerWebhook(definition.webhook);
          break;
        case 'parameter': {
          const refId = getRefId(definition.schema);
          if (refId) {
            target.openAPIRegistry.registerParameter(refId, definition.schema);
          }
          break;
        }
      }
    } catch {
      // Definitions may already be present when a router is mounted on an
      // OpenAPIHono instance that successfully merged its registry internally.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function registerSecuritySchemes(registry: OpenAPIHono<AppEnv>['openAPIRegistry']): void {
  registry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: 'token',
    description: 'Session cookie set automatically on login/register.',
  });
  registry.registerComponent('securitySchemes', 'userToken', {
    type: 'apiKey',
    in: 'header',
    name: 'x-user-token',
    description:
      'JWT session token passed as the x-user-token request header (alternative to the session cookie).',
  });
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description:
      'API key passed as Authorization: Bearer <token>. Required on all endpoints unless bearer auth is disabled in CreateAppConfig or the path is in the bypass list.',
  });
}

// ---------------------------------------------------------------------------
// Helpers (exported)
// ---------------------------------------------------------------------------

/**
 * Register the OpenAPI JSON spec endpoint and the Scalar docs UI on `app`.
 *
 * Called by `mountFlatRoutes` for apps with a `routesDir`, and directly by
 * `createApp` for manifest-driven apps that have no `routesDir` but still
 * need `/openapi.json` and `/docs`.
 *
 * @param app - The `OpenAPIHono` app to mount the endpoints on.
 * @param appName - Application name for the OpenAPI document title.
 * @param openApiVersion - Semantic version string for OpenAPI `info.version`.
 */
export function mountOpenApiDocs(
  app: OpenAPIHono<AppEnv>,
  appName: string,
  openApiVersion: string,
): void {
  registerSecuritySchemes(app.openAPIRegistry);
  app.doc('/openapi.json', { openapi: '3.0.0', info: { title: appName, version: openApiVersion } });
  app.get('/docs', Scalar({ url: '/openapi.json' }));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Discover and mount all route modules from `routesDir` on the Hono app.
 *
 * Delegates to `mountVersionedRoutes` when `versioning` is provided, or
 * `mountFlatRoutes` for a single-version flat layout.
 *
 * @param app - The `OpenAPIHono` app instance to mount routes on.
 * @param routesDir - Absolute path to the directory containing route modules.
 * @param versioning - Version config (`VersioningConfig` or `string[]` of
 *   version names) for multi-version APIs.  Pass `undefined` for a flat layout.
 * @param appName - Application name used in generated OpenAPI document titles.
 * @param openApiVersion - Semantic version string for the OpenAPI `info.version`
 *   field (e.g. `"1.0.0"`).
 * @param glob - `RuntimeGlob` implementation used to discover route files.
 * @returns A promise that resolves after all route modules have been imported
 *   and mounted.
 */
export async function mountRoutes(
  app: OpenAPIHono<AppEnv>,
  routesDir: string,
  versioning: VersioningConfig | string[] | undefined,
  appName: string,
  openApiVersion: string,
  glob: RuntimeGlob,
): Promise<void> {
  if (versioning) {
    await mountVersionedRoutes(app, routesDir, versioning, appName, openApiVersion, glob);
  } else {
    await mountFlatRoutes(app, routesDir, appName, openApiVersion, glob);
  }
}

/**
 * Mount route modules from version-specific subdirectories on the Hono app.
 *
 * For each version in `versioning.versions`:
 * - A fresh `OpenAPIHono` sub-app is created and all route modules from
 *   `routesDir/<version>/` are imported and mounted.
 * - Shared routes from `routesDir/<sharedDir>/` (default `"shared"`) are
 *   mounted on every versioned sub-app.
 * - A version-specific `GET /openapi.json` and `GET /docs` (Scalar) are added.
 * - The sub-app is mounted at `/<version>` on the parent app.
 *
 * The root `GET /docs` serves an HTML version-selector page.
 * The root `GET /openapi.json` redirects to the default version's spec.
 *
 * Route modules are sorted by their exported `priority` field (ascending)
 * before mounting.  Modules without a `priority` export sort last.
 *
 * @param app - The parent `OpenAPIHono` app instance.
 * @param routesDir - Absolute path to the directory containing version subdirs.
 * @param versioning - Version config specifying version names, shared dir, and
 *   default version.  Also accepts a plain `string[]` of version names.
 * @param appName - Application name for OpenAPI document titles.
 * @param openApiVersion - Semantic version string for OpenAPI `info.version`.
 * @param glob - `RuntimeGlob` used to scan route files.
 * @returns A promise that resolves after all versioned routes are mounted.
 */
async function mountVersionedRoutes(
  app: OpenAPIHono<AppEnv>,
  routesDir: string,
  versioning: VersioningConfig | string[],
  appName: string,
  openApiVersion: string,
  glob: RuntimeGlob,
): Promise<void> {
  const {
    versions,
    sharedDir = 'shared',
    defaultVersion = versions[versions.length - 1],
  } = Array.isArray(versioning) ? { versions: versioning } : versioning;

  // Import shared routes with no prefix — schemas stay unprefixed (version-agnostic)
  let sharedMods: Array<{ file: string; mod: RouteModule }> = [];
  if (sharedDir !== false) {
    const sharedRoutesDir = `${routesDir}/${sharedDir}`;
    const sharedFiles: string[] = [];
    try {
      const files = await glob.scan('**/*.ts', { cwd: sharedRoutesDir });
      for await (const file of files) {
        sharedFiles.push(file);
      }
    } catch {
      // sharedDir doesn't exist — fine
    }
    sharedMods = await Promise.all(
      sharedFiles.map(async file => ({
        file,
        mod: (await import(`${sharedRoutesDir}/${file}`)) as RouteModule,
      })),
    );
  }

  // For each version: import routes, mount on isolated OpenAPIHono
  for (const version of versions) {
    const vApp = new OpenAPIHono<AppEnv>({ defaultHook });
    const versionRoutesDir = `${routesDir}/${version}`;
    const versionFiles: string[] = [];
    try {
      const files = await glob.scan('**/*.ts', { cwd: versionRoutesDir });
      for await (const file of files) {
        versionFiles.push(file);
      }
    } catch {
      // version dir doesn't exist — fine
    }

    // Import all version route files in parallel
    const versionMods: Array<{ file: string; mod: RouteModule }> = await Promise.all(
      versionFiles.map(async file => ({
        file,
        mod: (await import(`${versionRoutesDir}/${file}`)) as RouteModule,
      })),
    );

    // Mount version-specific routes (sorted by priority)
    versionMods
      .sort((a, b) => (a.mod.priority ?? Infinity) - (b.mod.priority ?? Infinity))
      .forEach(({ mod }) => {
        if (mod.router) {
          vApp.route('/', mod.router);
          mergeOpenApiDefinitions(vApp, mod.router);
        }
      });

    // Mount shared routes on this versioned app
    for (const { mod } of sharedMods) {
      if (mod.router) {
        vApp.route('/', mod.router);
        mergeOpenApiDefinitions(vApp, mod.router);
      }
    }

    registerSecuritySchemes(vApp.openAPIRegistry);

    // Serve per-version spec stripped of schemas from other versions
    vApp.get('/openapi.json', c => {
      const spec = vApp.getOpenAPIDocument({
        openapi: '3.0.0',
        info: { title: `${appName} ${version.toUpperCase()}`, version: openApiVersion },
      });
      return c.json(stripUnreferencedSchemas(spec as unknown as Record<string, unknown>));
    });

    // Per-version Scalar docs
    vApp.get('/docs', Scalar({ url: `/${version}/openapi.json` }));

    // Mount versioned app under /v1, /v2, etc.
    app.route(`/${version}`, vApp);
  }

  // Root /docs → version selector page
  app.get('/docs', c => {
    const links = versions
      .map(v => `<li><a href="/${v}/docs" style="font-size:1.1em">${v.toUpperCase()}</a></li>`)
      .join('\n');
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${appName} — API Docs</title>
<style>body{font-family:sans-serif;padding:2rem}ul{list-style:none;padding:0}li{margin:.5rem 0}</style>
</head>
<body>
<h1>${appName}</h1>
<h2>API Documentation</h2>
<ul>${links}</ul>
</body></html>`;
    return c.html(html);
  });

  // Root /openapi.json → 302 to default version (no merged spec exists)
  app.get('/openapi.json', c => c.redirect(`/${defaultVersion}/openapi.json`, 302));
}

/**
 * Mount all route modules from `routesDir` directly on the Hono app (no versioning).
 *
 * All TypeScript files in `routesDir` are imported, sorted by their exported
 * `priority` field (ascending, modules without `priority` sort last), and mounted
 * at the root of `app`.  A single `GET /openapi.json` and `GET /docs` (Scalar)
 * endpoint are added for the combined spec.
 *
 * @param app - The `OpenAPIHono` app instance to mount routes on.
 * @param routesDir - Absolute path to the flat routes directory.
 * @param appName - Application name for the OpenAPI document title.
 * @param openApiVersion - Semantic version string for OpenAPI `info.version`.
 * @param glob - `RuntimeGlob` used to scan route files.
 * @returns A promise that resolves after all route modules have been mounted.
 */
async function mountFlatRoutes(
  app: OpenAPIHono<AppEnv>,
  routesDir: string,
  appName: string,
  openApiVersion: string,
  glob: RuntimeGlob,
): Promise<void> {
  const serviceFiles: string[] = [];
  const files = await glob.scan('**/*.ts', { cwd: routesDir });
  for await (const file of files) {
    serviceFiles.push(file);
  }

  const serviceMods: Array<{ file: string; mod: RouteModule }> = await Promise.all(
    serviceFiles.map(async file => ({
      file,
      mod: (await import(`${routesDir}/${file}`)) as RouteModule,
    })),
  );

  serviceMods
    .sort((a, b) => (a.mod.priority ?? Infinity) - (b.mod.priority ?? Infinity))
    .forEach(({ mod }) => {
      if (mod.router) {
        app.route('/', mod.router);
        mergeOpenApiDefinitions(app, mod.router);
      }
    });

  mountOpenApiDocs(app, appName, openApiVersion);
}
