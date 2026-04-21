import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { type MultiEntityManifest, createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import { createPermissionsPlugin } from '@lastshotlabs/slingshot-permissions';
import { createApp } from '../../src/app';
import type { CreateAppConfig } from '../../src/app';

type OpenApiSpec = {
  paths?: Record<string, Record<string, unknown>>;
};

type JsonRecord = Record<string, unknown>;

type StoreCase = {
  label: 'memory' | 'sqlite';
  expectedStore: 'memory' | 'sqlite';
  db: NonNullable<CreateAppConfig['db']>;
  cleanupDir?: string;
};

function matrixManifest(namespace: string): MultiEntityManifest {
  return {
    manifestVersion: 1,
    namespace,
    entities: {
      MatrixItem: {
        routePath: 'items',
        fields: {
          id: { type: 'string', primary: true, default: 'uuid' },
          slug: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'enum', values: ['draft', 'published'], default: 'draft' },
          count: { type: 'integer', default: 0 },
          tags: { type: 'string[]', optional: true },
          metadata: { type: 'json', optional: true },
          createdAt: { type: 'date', default: 'now' },
          updatedAt: { type: 'date', default: 'now', onUpdate: 'now' },
        },
        indexes: [{ fields: ['status'] }],
        uniques: [{ fields: ['slug'] }],
        routes: {
          create: {
            event: { key: `${namespace}:matrix_item.created`, payload: ['id', 'slug'] },
          },
          list: {},
          get: {},
          update: {},
          delete: {},
          disable: ['delete'],
          operations: {
            publish: { method: 'post' },
            rename: { method: 'patch' },
            addTag: { method: 'post' },
            setTags: { method: 'put' },
            bumpCount: { method: 'post' },
            searchTitle: { method: 'get' },
            upsertBySlug: { method: 'put' },
            findBySlugAlias: { path: 'by-slug/:slug' },
          },
        },
        operations: {
          publish: {
            kind: 'transition',
            field: 'status',
            from: 'draft',
            to: 'published',
            match: { id: 'param:id' },
          },
          rename: {
            kind: 'fieldUpdate',
            match: { id: 'param:id' },
            set: ['title'],
          },
          addTag: { kind: 'arrayPush', field: 'tags', value: 'input:tag' },
          setTags: { kind: 'arraySet', field: 'tags', value: 'input:tags' },
          bumpCount: { kind: 'increment', field: 'count', by: 2 },
          searchTitle: {
            kind: 'search',
            fields: ['title'],
            filter: { status: 'param:status' },
            paginate: true,
          },
          findBySlug: {
            kind: 'lookup',
            fields: { slug: 'param:slug' },
            returns: 'one',
          },
          findBySlugAlias: {
            kind: 'lookup',
            fields: { slug: 'param:slug' },
            returns: 'one',
          },
          slugExists: {
            kind: 'exists',
            fields: { slug: 'param:slug' },
          },
          upsertBySlug: {
            kind: 'upsert',
            match: ['slug'],
            set: ['title', 'status'],
            onCreate: { id: 'uuid' },
          },
        },
      },
    },
  };
}

function storeCases(): StoreCase[] {
  const sqliteDir = join(
    process.cwd(),
    '.tmp',
    'entity-manifest-matrix',
    crypto.randomUUID(),
  ).replaceAll('\\', '/');
  mkdirSync(sqliteDir, { recursive: true });

  return [
    {
      label: 'memory',
      expectedStore: 'memory',
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
    },
    {
      label: 'sqlite',
      expectedStore: 'sqlite',
      cleanupDir: sqliteDir,
      db: {
        sqlite: `${sqliteDir}/app.db`,
        redis: false,
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
      },
    },
  ];
}

async function requestJson<T = unknown>(
  app: {
    request: (
      input: string | Request | URL,
      requestInit?: RequestInit,
    ) => Response | Promise<Response>;
  },
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; json: T }> {
  const response = await app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const json = (await response.json()) as T;
  return { response, json };
}

function expectOpenApiMethod(spec: OpenApiSpec, path: string, method: string): void {
  const colonPath = path.replace(/{([A-Za-z]\w*)}/g, ':$1');
  const actualPath = spec.paths?.[path] ? path : colonPath;
  expect(spec.paths, `OpenAPI paths should include ${path}`).toHaveProperty(actualPath);
  expect(spec.paths?.[actualPath], `OpenAPI ${actualPath} should include ${method}`).toHaveProperty(
    method,
  );
}

function getOpenApiPath(spec: OpenApiSpec, path: string): Record<string, unknown> | undefined {
  return spec.paths?.[path] ?? spec.paths?.[path.replace(/{([A-Za-z]\w*)}/g, ':$1')];
}

describe('entity manifest matrix', () => {
  test.each(storeCases())(
    '$label store registers and serves manifest routes, operations, and OpenAPI docs',
    async ({ label, expectedStore, db, cleanupDir }) => {
      const { app, ctx } = await createApp({
        meta: { name: `Entity Manifest Matrix ${label}`, version: '1.0.0' },
        db,
        security: {},
        logging: { onLog: () => {} },
        plugins: [
          createPermissionsPlugin(),
          createEntityPlugin({
            name: `matrix-${label}`,
            mountPath: `/${label}`,
            manifest: matrixManifest(`matrix_${label}`),
          }),
        ],
      });
      const base = `/${label}/items`;

      try {
        expect(ctx.config.resolvedStores.authStore).toBe(expectedStore);
        expect(ctx.config.resolvedStores.sessions).toBe(expectedStore);
        expect(ctx.plugins.map(plugin => plugin.name)).toEqual([
          'slingshot-permissions',
          `matrix-${label}`,
        ]);

        const created = await requestJson<JsonRecord>(app, base, {
          method: 'POST',
          body: JSON.stringify({
            slug: `${label}-alpha`,
            title: 'Alpha doc',
            tags: [],
            metadata: { source: label },
          }),
        });
        expect(created.response.status).toBe(201);
        expect(created.json.slug).toBe(`${label}-alpha`);
        expect(created.json.status).toBe('draft');
        expect(created.json.count).toBe(0);
        const id = String(created.json.id);

        const listed = await requestJson<{ items: JsonRecord[] }>(app, base);
        expect(listed.response.status).toBe(200);
        expect(listed.json.items).toHaveLength(1);

        const fetched = await requestJson<JsonRecord>(app, `${base}/${id}`);
        expect(fetched.response.status).toBe(200);
        expect(fetched.json.id).toBe(id);

        const updated = await requestJson<JsonRecord>(app, `${base}/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: 'Alpha patched' }),
        });
        expect(updated.response.status).toBe(200);
        expect(updated.json.title).toBe('Alpha patched');

        const renamed = await requestJson<JsonRecord>(app, `${base}/rename`, {
          method: 'PATCH',
          body: JSON.stringify({ id, title: 'Alpha renamed' }),
        });
        expect(renamed.response.status).toBe(200);
        expect(renamed.json.title).toBe('Alpha renamed');

        const tagged = await requestJson<JsonRecord>(app, `${base}/add-tag`, {
          method: 'POST',
          body: JSON.stringify({ id, tag: 'red' }),
        });
        expect(tagged.response.status).toBe(200);
        expect(tagged.json.tags).toEqual(['red']);

        const retagged = await requestJson<JsonRecord>(app, `${base}/set-tags`, {
          method: 'PUT',
          body: JSON.stringify({ id, tags: ['red', 'blue', 'blue'] }),
        });
        expect(retagged.response.status).toBe(200);
        expect(retagged.json.tags).toEqual(['red', 'blue']);

        const bumped = await requestJson<JsonRecord>(app, `${base}/bump-count`, {
          method: 'POST',
          body: JSON.stringify({ id }),
        });
        expect(bumped.response.status).toBe(200);
        expect(bumped.json.count).toBe(2);

        const search = await requestJson<{ items: JsonRecord[]; hasMore: boolean }>(
          app,
          `${base}/search-title?q=Alpha&status=draft&limit=10`,
        );
        expect(search.response.status).toBe(200);
        expect(search.json.items.map(item => item.id)).toContain(id);
        expect(search.json.hasMore).toBe(false);

        const foundBySlug = await requestJson<JsonRecord>(
          app,
          `${base}/find-by-slug/${label}-alpha`,
        );
        expect(foundBySlug.response.status).toBe(200);
        expect(foundBySlug.json.id).toBe(id);

        const aliasedBySlug = await requestJson<JsonRecord>(app, `${base}/by-slug/${label}-alpha`);
        expect(aliasedBySlug.response.status).toBe(200);
        expect(aliasedBySlug.json.id).toBe(id);

        const missingBySlug = await app.request(`${base}/find-by-slug/missing`);
        expect(missingBySlug.status).toBe(404);

        const slugExists = await app.request(`${base}/slug-exists/${label}-alpha`, {
          method: 'HEAD',
        });
        expect(slugExists.status).toBe(200);

        const missingSlug = await app.request(`${base}/slug-exists/missing`, { method: 'HEAD' });
        expect(missingSlug.status).toBe(404);

        const upserted = await requestJson<JsonRecord>(app, `${base}/upsert-by-slug`, {
          method: 'PUT',
          body: JSON.stringify({
            slug: `${label}-beta`,
            title: 'Beta doc',
            status: 'draft',
          }),
        });
        expect(upserted.response.status).toBe(200);
        expect(upserted.json.slug).toBe(`${label}-beta`);
        expect(upserted.json.title).toBe('Beta doc');

        const published = await requestJson<JsonRecord>(app, `${base}/publish`, {
          method: 'POST',
          body: JSON.stringify({ id }),
        });
        expect(published.response.status).toBe(200);
        expect(published.json.status).toBe('published');

        const deleteResponse = await app.request(`${base}/${id}`, { method: 'DELETE' });
        expect(deleteResponse.status).toBe(404);

        const specResponse = await app.request('/openapi.json');
        expect(specResponse.status).toBe(200);
        const spec = (await specResponse.json()) as OpenApiSpec;
        expectOpenApiMethod(spec, base, 'post');
        expectOpenApiMethod(spec, base, 'get');
        expectOpenApiMethod(spec, `${base}/{id}`, 'get');
        expectOpenApiMethod(spec, `${base}/{id}`, 'patch');
        expect(getOpenApiPath(spec, `${base}/{id}`)).not.toHaveProperty('delete');
        expectOpenApiMethod(spec, `${base}/publish`, 'post');
        expectOpenApiMethod(spec, `${base}/rename`, 'patch');
        expectOpenApiMethod(spec, `${base}/add-tag`, 'post');
        expectOpenApiMethod(spec, `${base}/set-tags`, 'put');
        expectOpenApiMethod(spec, `${base}/bump-count`, 'post');
        expectOpenApiMethod(spec, `${base}/search-title`, 'get');
        expectOpenApiMethod(spec, `${base}/find-by-slug/{slug}`, 'get');
        expectOpenApiMethod(spec, `${base}/by-slug/{slug}`, 'get');
        expectOpenApiMethod(spec, `${base}/slug-exists/{slug}`, 'head');
        expectOpenApiMethod(spec, `${base}/upsert-by-slug`, 'put');
      } finally {
        await ctx.destroy();
        if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
      }
    },
  );
});
