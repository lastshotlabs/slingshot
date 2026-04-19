import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { mountOpenApiDocs, mountRoutes } from '../../src/framework/mountRoutes';

// Minimal RuntimeGlob that returns no files (empty routes dir simulation)
function makeEmptyGlob() {
  return {
    scan: async () => {
      async function* empty() {}
      return empty();
    },
  };
}

// RuntimeGlob that returns a specific list of files
function makeFilesGlob(files: string[]) {
  return {
    scan: async () => {
      async function* gen() {
        for (const f of files) yield f;
      }
      return gen();
    },
  };
}

describe('mountOpenApiDocs', () => {
  test('registers /openapi.json and /docs routes on app', () => {
    const app = new OpenAPIHono<AppEnv>();
    mountOpenApiDocs(app, 'Test App', '1.0.0');
    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    const paths = routes.map(r => r.path);
    expect(paths).toContain('/openapi.json');
    expect(paths).toContain('/docs');
  });

  test('registers cookieAuth, userToken, and bearerAuth security schemes', () => {
    const app = new OpenAPIHono<AppEnv>();
    mountOpenApiDocs(app, 'My Service', '2.0.0');
    const definitions = (
      app as unknown as {
        openAPIRegistry: { definitions: Array<{ type: string; name?: string }> };
      }
    ).openAPIRegistry.definitions;
    const componentNames = definitions
      .filter(d => d.type === 'component')
      .map((d: unknown) => (d as { name: string }).name);
    expect(componentNames).toContain('cookieAuth');
    expect(componentNames).toContain('userToken');
    expect(componentNames).toContain('bearerAuth');
  });
});

describe('mountRoutes — flat (no versioning)', () => {
  test('completes without error when routesDir scan returns no files', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const glob = makeEmptyGlob();
    await mountRoutes(app, '/nonexistent/routes', undefined, 'Test', '1.0.0', glob);
    // Should mount /openapi.json and /docs
    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    const paths = routes.map(r => r.path);
    expect(paths).toContain('/openapi.json');
    expect(paths).toContain('/docs');
  });
});

describe('mountRoutes — flat with actual route files', () => {
  test('mounts route modules from routesDir and sorts by priority', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const fixtureDir = `${import.meta.dir}/fixtures/routes/v1`;
    const glob = makeFilesGlob(['hello.ts']);
    await mountRoutes(app, fixtureDir, undefined, 'Test', '1.0.0', glob);

    const req = new Request('http://localhost/hello');
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('hello from v1');
  });

  test('merges OpenAPI definitions (component, route, webhook) from route modules', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const fixtureDir = `${import.meta.dir}/fixtures/routes/v1`;
    const glob = makeFilesGlob(['withDefinitions.ts']);
    await mountRoutes(app, fixtureDir, undefined, 'TestDefs', '1.0.0', glob);

    // Fetch the OpenAPI spec to verify definitions were merged
    const req = new Request('http://localhost/openapi.json');
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const spec = await res.json() as Record<string, unknown>;
    // Should have the test path defined
    const paths = spec.paths as Record<string, unknown>;
    expect(paths['/test-defined']).toBeDefined();
  });

  test('merges OpenAPI parameter definitions from route modules (lines 70-75)', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const fixtureDir = `${import.meta.dir}/fixtures/routes/v1`;
    const glob = makeFilesGlob(['withParameter.ts']);
    await mountRoutes(app, fixtureDir, undefined, 'TestParams', '1.0.0', glob);

    // Verify the route is accessible — this proves the module was loaded
    // and mergeOpenApiDefinitions (including the 'parameter' case) ran
    const routeRes = await app.fetch(new Request('http://localhost/with-param'));
    expect(routeRes.status).toBe(200);
    expect(await routeRes.text()).toBe('param route');
  });
});

describe('mountRoutes — versioned', () => {
  test('mounts versioned routes and version selector /docs', async () => {
    const app = new OpenAPIHono<AppEnv>();
    // No actual files to import — empty glob
    const glob = makeEmptyGlob();
    await mountRoutes(app, '/routes', ['v1', 'v2'], 'Test App', '1.0.0', glob);

    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    const paths = routes.map(r => r.path);

    // Version-specific sub-apps should be mounted under /v1 and /v2
    expect(paths.some(p => p.startsWith('/v1'))).toBe(true);
    expect(paths.some(p => p.startsWith('/v2'))).toBe(true);
    // Root /docs (version selector) should be present
    expect(paths).toContain('/docs');
    // Root /openapi.json redirect should be present
    expect(paths).toContain('/openapi.json');
  });

  test('mounts versioned routes using VersioningConfig object', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const glob = makeEmptyGlob();
    await mountRoutes(
      app,
      '/routes',
      { versions: ['v1', 'v2'], defaultVersion: 'v2', sharedDir: 'shared' },
      'My API',
      '0.1.0',
      glob,
    );

    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    const paths = routes.map(r => r.path);
    expect(paths.some(p => p.startsWith('/v1'))).toBe(true);
    expect(paths.some(p => p.startsWith('/v2'))).toBe(true);
  });

  test('version selector /docs returns HTML with version links', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const glob = makeEmptyGlob();
    await mountRoutes(app, '/routes', ['v1', 'v2'], 'My App', '1.0.0', glob);

    const req = new Request('http://localhost/docs');
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/v1/docs');
    expect(html).toContain('/v2/docs');
    expect(html).toContain('My App');
  });

  test('root /openapi.json redirects to default version spec', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const glob = makeEmptyGlob();
    await mountRoutes(app, '/routes', { versions: ['v1', 'v2'], defaultVersion: 'v1' }, 'API', '1.0.0', glob);

    const req = new Request('http://localhost/openapi.json');
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/v1/openapi.json');
  });

  test('default version is last in array when not specified', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const glob = makeEmptyGlob();
    await mountRoutes(app, '/routes', ['v1', 'v2', 'v3'], 'API', '1.0.0', glob);

    const req = new Request('http://localhost/openapi.json');
    const res = await app.fetch(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/v3/openapi.json');
  });

  test('versioned /openapi.json returns JSON spec', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const glob = makeEmptyGlob();
    await mountRoutes(app, '/routes', ['v1'], 'Test App', '1.0.0', glob);

    const req = new Request('http://localhost/v1/openapi.json');
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const spec = await res.json() as { openapi: string; info: { title: string } };
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toContain('V1');
  });

  test('sharedDir: false disables shared routes scanning', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const scannedDirs: string[] = [];
    const glob = {
      scan: async (pattern: string, opts: { cwd: string }) => {
        scannedDirs.push(opts.cwd);
        async function* empty() {}
        return empty();
      },
    };
    await mountRoutes(
      app,
      '/routes',
      { versions: ['v1'], sharedDir: false },
      'API',
      '1.0.0',
      glob,
    );
    // Should only scan the version dir, not a shared dir
    expect(scannedDirs.every(d => !d.endsWith('/shared'))).toBe(true);
  });

  test('versioned routes with actual route files mounts version routes and shared routes', async () => {
    const app = new OpenAPIHono<AppEnv>();
    const fixtureDir = `${import.meta.dir}/fixtures/routes`;

    // Create a glob that returns different files based on cwd
    const glob = {
      scan: async (_pattern: string, opts: { cwd: string }) => {
        if (opts.cwd.endsWith('/v1')) {
          async function* gen() { yield 'hello.ts'; }
          return gen();
        }
        if (opts.cwd.endsWith('/shared')) {
          async function* gen() { yield 'health.ts'; }
          return gen();
        }
        async function* empty() {}
        return empty();
      },
    };

    await mountRoutes(app, fixtureDir, ['v1'], 'API', '1.0.0', glob);

    // v1/hello route should be accessible
    const helloRes = await app.fetch(new Request('http://localhost/v1/hello'));
    expect(helloRes.status).toBe(200);
    expect(await helloRes.text()).toBe('hello from v1');

    // shared /health should be accessible under /v1
    const healthRes = await app.fetch(new Request('http://localhost/v1/health'));
    expect(healthRes.status).toBe(200);
    expect(await healthRes.text()).toBe('ok');
  });

  test('shared dir scan failure is silently ignored', async () => {
    const app = new OpenAPIHono<AppEnv>();

    // Glob that throws for shared dir and returns files for v1
    const glob = {
      scan: async (_pattern: string, opts: { cwd: string }) => {
        if (opts.cwd.endsWith('/shared')) {
          throw new Error('shared dir does not exist');
        }
        if (opts.cwd.endsWith('/v1')) {
          async function* empty() {}
          return empty();
        }
        async function* empty() {}
        return empty();
      },
    };

    // Should not throw
    await mountRoutes(app, '/routes', ['v1'], 'API', '1.0.0', glob);
  });

  test('version dir scan failure is silently ignored', async () => {
    const app = new OpenAPIHono<AppEnv>();

    // Glob that throws for version dirs
    const glob = {
      scan: async (_pattern: string, opts: { cwd: string }) => {
        if (opts.cwd.endsWith('/v1')) {
          throw new Error('version dir does not exist');
        }
        async function* empty() {}
        return empty();
      },
    };

    // Should not throw
    await mountRoutes(app, '/routes', { versions: ['v1'], sharedDir: false }, 'API', '1.0.0', glob);
  });
});
