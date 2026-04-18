import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { MiddlewareHandler } from 'hono';
import { join } from 'path';
import { createApp } from '../../src/app';
import type { CreateAppConfig } from '../../src/app';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import { createServer } from '../../src/server';
import type { CreateServerConfig } from '../../src/server';

type TestServer = {
  port: number;
  stop(close?: boolean): void | Promise<void>;
};

type TestHandle = {
  request(path: string): Promise<Response>;
  cleanup(): Promise<void>;
};

type OpenApiSpec = {
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

type Fixture = {
  root: string;
  routesDir: string;
  schemasDir: string;
  slug: string;
  pascal: string;
  tempDirs: string[];
};

function toPascal(slug: string): string {
  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function createDomainFixture(slug: string): Fixture {
  const pascal = toPascal(slug);
  const fixturesRoot = join(process.cwd(), '.tmp', 'domain-registration-tests');
  mkdirSync(fixturesRoot, { recursive: true });
  const root = mkdtempSync(join(fixturesRoot, `${slug}-`)).replaceAll('\\', '/');
  const routesDir = `${root}/routes`;
  const schemasDir = `${root}/schemas`;
  mkdirSync(routesDir, { recursive: true });
  mkdirSync(schemasDir, { recursive: true });

  writeFileSync(
    `${schemasDir}/explicit.ts`,
    `
import { z } from 'zod';
import { registerSchema } from '@lastshotlabs/slingshot-core';

export const ${pascal}ExplicitDomainSchema = registerSchema(
  '${pascal}ExplicitDomain',
  z.object({
    id: z.string(),
    mode: z.literal('explicit'),
  }),
);
`.trimStart(),
    'utf-8',
  );

  writeFileSync(
    `${schemasDir}/schemaDir.ts`,
    `
import { z } from 'zod';

export const ${pascal}SchemaDirDomainSchema = z.object({
  id: z.string(),
  mode: z.literal('schema-dir'),
});
`.trimStart(),
    'utf-8',
  );

  writeFileSync(
    `${routesDir}/domain.ts`,
    `
import { z } from 'zod';
import { createRoute, createRouter } from '@lastshotlabs/slingshot-core';
import { ${pascal}ExplicitDomainSchema } from '../schemas/explicit';
import { ${pascal}SchemaDirDomainSchema } from '../schemas/schemaDir';

export const router = createRouter();

const ${pascal}RouteAutoDomainSchema = z.object({
  id: z.string(),
  mode: z.literal('route-auto'),
});

const ${pascal}RouteAutoRoute = createRoute({
  method: 'get',
  path: '/${slug}/route-auto',
  responses: {
    200: {
      description: 'Route auto-registered domain response',
      content: { 'application/json': { schema: ${pascal}RouteAutoDomainSchema } },
    },
  },
});

const ${pascal}SchemaDirRoute = createRoute({
  method: 'get',
  path: '/${slug}/schema-dir',
  responses: {
    200: {
      description: 'Schema-directory domain response',
      content: { 'application/json': { schema: ${pascal}SchemaDirDomainSchema } },
    },
  },
});

const ${pascal}ExplicitRoute = createRoute({
  method: 'get',
  path: '/${slug}/explicit',
  responses: {
    200: {
      description: 'Explicitly registered domain response',
      content: { 'application/json': { schema: ${pascal}ExplicitDomainSchema } },
    },
  },
});

router.openapi(${pascal}RouteAutoRoute, c =>
  c.json({ id: '${slug}-route-auto-1', mode: 'route-auto' as const }),
);
router.openapi(${pascal}SchemaDirRoute, c =>
  c.json({ id: '${slug}-schema-dir-1', mode: 'schema-dir' as const }),
);
router.openapi(${pascal}ExplicitRoute, c =>
  c.json({ id: '${slug}-explicit-1', mode: 'explicit' as const }),
);
`.trimStart(),
    'utf-8',
  );

  return { root, routesDir, schemasDir, slug, pascal, tempDirs: [root] };
}

const baseConfig = {
  meta: { name: 'Domain Registration Test', version: '1.2.3' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: { rateLimit: { windowMs: 60_000, max: 1000 } },
  logging: { onLog: () => {} },
};

function appConfigFor(fixture: Fixture): CreateAppConfig {
  return {
    ...baseConfig,
    routesDir: fixture.routesDir,
    modelSchemas: { paths: fixture.schemasDir, registration: 'auto' as const },
  };
}

function serverConfigFor(fixture: Fixture): CreateServerConfig {
  return {
    ...appConfigFor(fixture),
    port: 0,
  };
}

function jsonManifestPath(fixture: Fixture): string {
  const manifestsRoot = join(process.cwd(), '.tmp', 'domain-registration-manifests');
  mkdirSync(manifestsRoot, { recursive: true });
  const manifestDir = mkdtempSync(join(manifestsRoot, `${fixture.slug}-`));
  fixture.tempDirs.push(manifestDir);
  const manifestPath = join(manifestDir, 'app.manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        manifestVersion: 1,
        routesDir: fixture.routesDir,
        modelSchemas: { paths: fixture.schemasDir, registration: 'auto' },
        meta: baseConfig.meta,
        db: baseConfig.db,
        security: baseConfig.security,
        logging: { onLog: { handler: 'onLog' } },
        middleware: [{ handler: 'markBootPath', params: { value: 'manifest' } }],
        port: 0,
      },
      null,
      2,
    ),
    'utf-8',
  );
  return manifestPath;
}

function cleanupFixture(fixture: Fixture): void {
  for (const dir of fixture.tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function headerMiddleware(value: string): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('x-slingshot-boot-path', value);
  };
}

async function startCodeDrivenApp(fixture: Fixture): Promise<TestHandle> {
  const { app } = await createApp({
    ...appConfigFor(fixture),
    middleware: [headerMiddleware('code-app')],
  } satisfies CreateAppConfig);
  return {
    request: path => Promise.resolve(app.request(path)),
    cleanup: async () => cleanupFixture(fixture),
  };
}

async function startCodeDrivenServer(fixture: Fixture): Promise<TestHandle> {
  const server = (await createServer({
    ...serverConfigFor(fixture),
    middleware: [headerMiddleware('code-server')],
  } satisfies CreateServerConfig)) as unknown as TestServer;
  const baseUrl = `http://localhost:${server.port}`;
  return {
    request: path => fetch(`${baseUrl}${path}`),
    cleanup: async () => {
      await server.stop(true);
      cleanupFixture(fixture);
    },
  };
}

async function startManifestDrivenServer(fixture: Fixture): Promise<TestHandle> {
  const registry = createManifestHandlerRegistry();
  registry.registerHandler('onLog', () => () => {});
  registry.registerHandler('markBootPath', params => headerMiddleware(String(params?.value)));
  const server = (await createServerFromManifest(
    jsonManifestPath(fixture),
    registry,
  )) as unknown as TestServer;
  const baseUrl = `http://localhost:${server.port}`;
  return {
    request: path => fetch(`${baseUrl}${path}`),
    cleanup: async () => {
      await server.stop(true);
      cleanupFixture(fixture);
    },
  };
}

async function readJson(handle: TestHandle, path: string): Promise<unknown> {
  const response = await handle.request(path);
  expect(response.status).toBe(200);
  return response.json();
}

function getResponseRef(spec: OpenApiSpec, path: string): string | undefined {
  const operation = spec.paths?.[path]?.get as
    | { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> }
    | undefined;
  return operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
}

describe('manifest and code driven domain registration', () => {
  const cases = [
    ['code driven createApp', 'domain-code-app', startCodeDrivenApp, 'code-app'],
    ['code driven createServer', 'domain-code-server', startCodeDrivenServer, 'code-server'],
    [
      'manifest driven createServerFromManifest',
      'domain-manifest-server',
      startManifestDrivenServer,
      'manifest',
    ],
  ] as const;

  test.each(cases)(
    '%s serves routes and OpenAPI docs with all schema registration modes',
    async (_label, slug, startServer, bootPath) => {
      const fixture = createDomainFixture(slug);
      const handle = await startServer(fixture);
      const routeAutoPath = `/${slug}/route-auto`;
      const schemaDirPath = `/${slug}/schema-dir`;
      const explicitPath = `/${slug}/explicit`;
      const routeAutoSchema = `Get${fixture.pascal}RouteAutoResponse`;
      const schemaDirSchema = `${fixture.pascal}SchemaDirDomain`;
      const schemaDirFallback = `Get${fixture.pascal}SchemaDirResponse`;
      const explicitSchema = `${fixture.pascal}ExplicitDomain`;

      try {
        const routeAuto = await readJson(handle, routeAutoPath);
        expect(routeAuto).toEqual({ id: `${slug}-route-auto-1`, mode: 'route-auto' });

        const schemaDir = await readJson(handle, schemaDirPath);
        expect(schemaDir).toEqual({ id: `${slug}-schema-dir-1`, mode: 'schema-dir' });

        const explicit = await readJson(handle, explicitPath);
        expect(explicit).toEqual({ id: `${slug}-explicit-1`, mode: 'explicit' });

        const routeResponse = await handle.request(routeAutoPath);
        expect(routeResponse.headers.get('x-slingshot-boot-path')).toBe(bootPath);

        const docsResponse = await handle.request('/docs');
        expect(docsResponse.status).toBe(200);
        expect(await docsResponse.text()).toContain('<!doctype html');

        const spec = (await readJson(handle, '/openapi.json')) as OpenApiSpec;
        expect(spec.info).toEqual({ title: 'Domain Registration Test', version: '1.2.3' });
        expect(spec.paths).toHaveProperty(routeAutoPath);
        expect(spec.paths).toHaveProperty(schemaDirPath);
        expect(spec.paths).toHaveProperty(explicitPath);

        expect(spec.components?.schemas).toHaveProperty(routeAutoSchema);
        expect(spec.components?.schemas).toHaveProperty(schemaDirSchema);
        expect(spec.components?.schemas).not.toHaveProperty(schemaDirFallback);
        expect(spec.components?.schemas).toHaveProperty(explicitSchema);

        expect(getResponseRef(spec, routeAutoPath)).toBe(`#/components/schemas/${routeAutoSchema}`);
        expect(getResponseRef(spec, schemaDirPath)).toBe(`#/components/schemas/${schemaDirSchema}`);
        expect(getResponseRef(spec, explicitPath)).toBe(`#/components/schemas/${explicitSchema}`);
      } finally {
        await handle.cleanup();
      }
    },
  );

  test('schema-dir imports fall back to route auto-names when modelSchemas is not configured', async () => {
    const fixture = createDomainFixture('domain-no-preload');
    const server = (await createServer({
      ...serverConfigFor(fixture),
      modelSchemas: undefined,
      middleware: [headerMiddleware('no-preload')],
    } satisfies CreateServerConfig)) as unknown as TestServer;
    const handle: TestHandle = {
      request: path => fetch(`http://localhost:${server.port}${path}`),
      cleanup: async () => {
        await server.stop(true);
        cleanupFixture(fixture);
      },
    };
    const schemaDirPath = `/${fixture.slug}/schema-dir`;
    const fallbackSchema = `Get${fixture.pascal}SchemaDirResponse`;
    const schemaDirSchema = `${fixture.pascal}SchemaDirDomain`;

    try {
      const spec = (await readJson(handle, '/openapi.json')) as OpenApiSpec;
      expect(spec.paths).toHaveProperty(schemaDirPath);
      expect(spec.components?.schemas).toHaveProperty(fallbackSchema);
      expect(spec.components?.schemas).not.toHaveProperty(schemaDirSchema);
      expect(getResponseRef(spec, schemaDirPath)).toBe(`#/components/schemas/${fallbackSchema}`);
    } finally {
      await handle.cleanup();
    }
  });
});
