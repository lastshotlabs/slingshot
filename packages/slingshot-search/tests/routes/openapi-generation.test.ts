/**
 * Regression: OpenAPI generation must not blow the stack on the recursive
 * `SearchFilterSchema` used by the federated search route.
 *
 * Previously, `SearchFilterSchema` was an unnamed `z.lazy()` cycle. When the
 * OpenAPI spec is rendered (e.g. via `app.getOpenAPIDocument(...)`),
 * `zod-to-openapi` walked the schema graph and tried to inline-expand the
 * cycle, throwing `RangeError: Maximum call stack size exceeded`.
 *
 * The fix registers `SearchFilterSchema` as a named OpenAPI component via
 * `registerSchema('SearchFilter', ...)` so the generator emits a `$ref` at
 * each use site instead.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'bun:test';
import type { AppEnv, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { createFederatedRouter } from '../../src/routes/federated';
import { createSearchManager } from '../../src/searchManager';
import { createSearchTransformRegistry } from '../../src/transformRegistry';
import type { SearchPluginConfig } from '../../src/types/config';

describe('search OpenAPI generation', () => {
  it('generates the federated search OpenAPI spec without stack overflow', async () => {
    const config: SearchPluginConfig = { providers: { default: { provider: 'db-native' } } };
    const manager = createSearchManager({
      pluginConfig: config,
      transformRegistry: createSearchTransformRegistry(),
    });
    await manager.initialize([
      {
        name: 'Article',
        _pkField: 'id',
        _storageName: 'articles',
        fields: { id: { type: 'string', optional: false, primary: true, immutable: true } },
        search: { fields: {} },
      } as unknown as ResolvedEntityConfig,
    ]);

    const app = new OpenAPIHono<AppEnv>();
    app.route('/search', createFederatedRouter(manager, config));

    // The bug previously surfaced as RangeError during this call.
    const doc = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '0.0.0' },
    });

    expect(doc.paths).toBeDefined();
    expect(doc.paths?.['/search/multi']).toBeDefined();

    // Verify the recursive schema is emitted as a named $ref component, not inlined.
    const components = doc.components?.schemas ?? {};
    expect(components['SearchFilter']).toBeDefined();
  });

  it('emits brace-form OpenAPI paths for parameterized search routes', async () => {
    // The federated, suggest, and admin search routes use `:entity` segments
    // internally. After the source migration to brace literals, the OpenAPI doc
    // must emit `/search/{entity}` (and matching admin/suggest paths) rather
    // than `/search/:entity`. Snapshot codegen depends on the brace form.
    const config: SearchPluginConfig = { providers: { default: { provider: 'db-native' } } };
    const manager = createSearchManager({
      pluginConfig: config,
      transformRegistry: createSearchTransformRegistry(),
    });
    await manager.initialize([
      {
        name: 'Article',
        _pkField: 'id',
        _storageName: 'articles',
        fields: { id: { type: 'string', optional: false, primary: true, immutable: true } },
        search: { fields: {} },
      } as unknown as ResolvedEntityConfig,
    ]);

    const { createSearchRouter } = await import('../../src/routes/search');
    const { createSuggestRouter } = await import('../../src/routes/suggest');
    const { createAdminRouter } = await import('../../src/routes/admin');

    const app = new OpenAPIHono<AppEnv>();
    app.route('/search', createSearchRouter(manager, config, false));
    app.route('/search', createSuggestRouter(manager, config, false));
    app.route('/', createAdminRouter(manager, config));

    const doc = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '0.0.0' },
    });
    const paths = Object.keys(doc.paths ?? {});

    // Brace form must be present.
    expect(paths).toContain('/search/{entity}');
    expect(paths).toContain('/search/{entity}/suggest');
    expect(paths).toContain('/admin/indexes/{entity}/health');
    expect(paths).toContain('/admin/indexes/{entity}/rebuild');

    // Colon form must not leak.
    for (const path of paths) {
      expect(path).not.toContain(':');
    }
  });
});
