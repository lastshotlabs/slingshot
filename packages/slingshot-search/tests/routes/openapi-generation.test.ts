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
});
