import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';
import { defineEntity, field } from '@lastshotlabs/slingshot-core';
import { encodeEntityEtag } from '../../src/concurrency/etag';
import { createEntityFactories } from '../../src/configDriven';
import { buildBareEntityRoutes } from '../../src/routing/buildBareEntityRoutes';
import { planEntityRoutes } from '../../src/routing/entityRoutePlanning';

const VersionedDocument = defineEntity('HttpVersionedDocument', {
  concurrency: { strategy: 'version' },
  routes: {},
  dto: {
    default: record => ({
      title: (record as Record<string, unknown>).title,
    }),
  },
  fields: {
    id: field.string({ primary: true }),
    title: field.string(),
  },
});

describe('entity HTTP conditional writes', () => {
  test('emits pre-projection ETags and maps 400/404/412/428 for guarded writes', async () => {
    const adapter = createEntityFactories(VersionedDocument).memory();
    const router = buildBareEntityRoutes(VersionedDocument, undefined, adapter);

    const created = await router.request('/http-versioned-documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'doc-1', title: 'first' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ title: 'first' });
    const versionOne = encodeEntityEtag(VersionedDocument._storageName, 'doc-1', 1);
    expect(created.headers.get('etag')).toBe(versionOne);

    const fetched = await router.request('/http-versioned-documents/doc-1');
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('etag')).toBe(versionOne);
    expect(await fetched.json()).toEqual({ title: 'first' });

    const update = (ifMatch?: string, id = 'doc-1') =>
      router.request(`/http-versioned-documents/${id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
        },
        body: JSON.stringify({ title: 'second' }),
      });

    expect((await update()).status).toBe(428);
    for (const invalid of ['*', `W/${versionOne}`, `${versionOne}, ${versionOne}`, '"bad"']) {
      expect((await update(invalid)).status).toBe(400);
    }
    expect(
      (await update(encodeEntityEtag(VersionedDocument._storageName, 'other', 1))).status,
    ).toBe(412);
    expect((await update(versionOne, 'missing')).status).toBe(412);
    expect(
      (await update(encodeEntityEtag(VersionedDocument._storageName, 'missing', 1), 'missing'))
        .status,
    ).toBe(404);

    const updated = await update(versionOne);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ title: 'second' });
    const versionTwo = encodeEntityEtag(VersionedDocument._storageName, 'doc-1', 2);
    expect(updated.headers.get('etag')).toBe(versionTwo);
    expect((await update(versionOne)).status).toBe(412);

    const missingTagDelete = await router.request('/http-versioned-documents/doc-1', {
      method: 'DELETE',
    });
    expect(missingTagDelete.status).toBe(428);
    const staleDelete = await router.request('/http-versioned-documents/doc-1', {
      method: 'DELETE',
      headers: { 'if-match': versionOne },
    });
    expect(staleDelete.status).toBe(412);
    const deleted = await router.request('/http-versioned-documents/doc-1', {
      method: 'DELETE',
      headers: { 'if-match': versionTwo },
    });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('etag')).toBeNull();
  });

  test('leaves entities without concurrency headers and write behavior unchanged', async () => {
    const Legacy = defineEntity('HttpLegacyDocument', {
      routes: {},
      fields: {
        id: field.string({ primary: true }),
        title: field.string(),
      },
    });
    const router = buildBareEntityRoutes(Legacy, undefined, createEntityFactories(Legacy).memory());
    const created = await router.request('/http-legacy-documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'legacy-1', title: 'first' }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBeNull();
    const updated = await router.request('/http-legacy-documents/legacy-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'second' }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).toBeNull();
  });

  test('permits omitted If-Match for optional guards while still incrementing', async () => {
    const Optional = defineEntity('HttpOptionalVersion', {
      concurrency: { strategy: 'version', requiredOnWrite: false },
      routes: {},
      fields: {
        id: field.string({ primary: true }),
        title: field.string(),
      },
    });
    const router = buildBareEntityRoutes(
      Optional,
      undefined,
      createEntityFactories(Optional).memory(),
    );
    await router.request('/http-optional-versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'optional-1', title: 'first' }),
    });
    const updated = await router.request('/http-optional-versions/optional-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'second' }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).toBe(
      encodeEntityEtag(Optional._storageName, 'optional-1', 2),
    );
  });

  test('planned routes and generated OpenAPI expose the same conditional contract', async () => {
    const adapter = createEntityFactories(VersionedDocument).memory();
    const plannedRoutes = planEntityRoutes(VersionedDocument, undefined);
    const router = buildBareEntityRoutes(VersionedDocument, undefined, adapter, new OpenAPIHono(), {
      plannedRoutes,
    });
    router.doc('/openapi.json', {
      openapi: '3.1.0',
      info: { title: 'Conditional entity test', version: '1' },
    });

    const created = await router.request('/http-versioned-documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'planned-1', title: 'first' }),
    });
    const firstTag = encodeEntityEtag(VersionedDocument._storageName, 'planned-1', 1);
    expect(created.headers.get('etag')).toBe(firstTag);
    expect(
      (
        await router.request('/http-versioned-documents/planned-1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'missing precondition' }),
        })
      ).status,
    ).toBe(428);
    const updated = await router.request('/http-versioned-documents/planned-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': firstTag },
      body: JSON.stringify({ title: 'second' }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).toBe(
      encodeEntityEtag(VersionedDocument._storageName, 'planned-1', 2),
    );

    type OpenApiOperation = {
      parameters?: Array<Record<string, unknown>>;
      responses: Record<string, { headers?: Record<string, unknown> }>;
    };
    const spec = (await (await router.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, OpenApiOperation>>;
    };
    const update = spec.paths['/http-versioned-documents/{id}'].patch;
    expect(update.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'header', name: 'if-match', required: true }),
      ]),
    );
    expect(Object.keys(update.responses)).toEqual(
      expect.arrayContaining(['200', '400', '404', '412', '428']),
    );
    expect(update.responses['200'].headers).toHaveProperty('ETag');
    const remove = spec.paths['/http-versioned-documents/{id}'].delete;
    expect(Object.keys(remove.responses)).toEqual(
      expect.arrayContaining(['204', '400', '404', '412', '428']),
    );
  });
});
