import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createEntityPlugin } from '../../packages/slingshot-entity/src/index';
import { defineApp } from '../../src/defineApp';
import { createServer, getServerContext } from '../../src/server';

type TestServer = {
  port: number;
  stop(close?: boolean): void | Promise<void>;
};

type OpenApiSpec = {
  paths?: Record<string, Record<string, unknown>>;
};

describe('defineApp + createEntityPlugin entity wiring', () => {
  test('boots a canonical app.config.ts equivalent of manifest top-level entities', async () => {
    const dir = join(
      process.cwd(),
      '.tmp',
      'defineApp-entities',
      crypto.randomUUID(),
    ).replaceAll('\\', '/');
    mkdirSync(dir, { recursive: true });
    let server: TestServer | undefined;

    try {
      const config = defineApp({
        port: 0,
        meta: { name: 'defineApp Entities', version: '1.0.0' },
        db: {
          sqlite: `${dir}/app.db`,
          sessions: 'sqlite',
          auth: 'sqlite',
          redis: false,
        },
        plugins: [
          createEntityPlugin({
            name: 'app-entities',
            manifest: {
              manifestVersion: 1,
              entities: {
                Article: {
                  fields: {
                    id: { type: 'string', primary: true, default: 'uuid' },
                    title: { type: 'string' },
                    body: { type: 'string' },
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
          }),
        ],
      });

      server = (await createServer(config)) as unknown as TestServer;
      const baseUrl = `http://localhost:${server.port}`;

      const articlesResponse = await fetch(`${baseUrl}/articles`);
      expect(articlesResponse.status).toBe(200);
      expect(await articlesResponse.json()).toMatchObject({ items: [] });

      const docsResponse = await fetch(`${baseUrl}/docs`);
      expect(docsResponse.status).toBe(200);

      const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
      expect(openApiResponse.status).toBe(200);
      const spec = (await openApiResponse.json()) as OpenApiSpec;
      expect(spec.paths).toHaveProperty('/articles');
      expect(spec.paths).toHaveProperty('/tags');
    } finally {
      const ctx = server ? getServerContext(server) : null;
      await server?.stop(true);
      await ctx?.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
