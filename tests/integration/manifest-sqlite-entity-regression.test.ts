import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';
import { getServerContext } from '../../src/server';

type TestServer = {
  port: number;
  stop(close?: boolean): void | Promise<void>;
};

type OpenApiSpec = {
  paths?: Record<string, Record<string, unknown>>;
};

function createTempManifest(): { dir: string; path: string } {
  const dir = join(
    process.cwd(),
    '.tmp',
    'manifest-sqlite-entity-regression',
    crypto.randomUUID(),
  ).replaceAll('\\', '/');
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/app.manifest.json`;

  writeFileSync(
    path,
    JSON.stringify(
      {
        manifestVersion: 1,
        port: 0,
        meta: { name: 'Manifest SQLite Entity Regression', version: '1.0.0' },
        db: {
          sqlite: `${dir}/app.db`,
          sessions: 'sqlite',
          auth: 'sqlite',
          redis: false,
        },
        security: { rateLimit: false },
        plugins: [
          { plugin: 'slingshot-permissions' },
          {
            plugin: 'slingshot-entity',
            config: {
              name: 'content-entity-plugin',
              mountPath: '/content',
              manifest: {
                manifestVersion: 1,
                namespace: 'content',
                entities: {
                  Article: {
                    fields: {
                      id: { type: 'string', primary: true, default: 'uuid' },
                      title: { type: 'string' },
                      body: { type: 'string' },
                      createdBy: { type: 'string' },
                      createdAt: { type: 'date', default: 'now' },
                    },
                    routes: { create: {}, list: {}, get: {} },
                  },
                  Tag: {
                    fields: {
                      id: { type: 'string', primary: true, default: 'uuid' },
                      name: { type: 'string' },
                    },
                    routes: { list: {} },
                  },
                },
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  return { dir, path };
}

describe('manifest sqlite entity regression', () => {
  test('boots sqlite-backed manifest plugins without implicit mongo secrets', async () => {
    const fixture = createTempManifest();
    let server: TestServer | undefined;

    try {
      server = (await createServerFromManifest(fixture.path)) as unknown as TestServer;
      const baseUrl = `http://localhost:${server.port}`;

      const listResponse = await fetch(`${baseUrl}/content/articles`);
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({ items: [] });

      const docsResponse = await fetch(`${baseUrl}/docs`);
      expect(docsResponse.status).toBe(200);

      const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
      expect(openApiResponse.status).toBe(200);
      const spec = (await openApiResponse.json()) as OpenApiSpec;
      expect(spec.paths).toHaveProperty('/content/articles');
      expect(spec.paths).toHaveProperty('/content/tags');
    } finally {
      const ctx = server ? getServerContext(server) : null;
      await server?.stop(true);
      await ctx?.destroy();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
