/**
 * Isolated test for SSR Windows-style serverActionsDir path resolution.
 *
 * Uses mock.module to replace the registry so the router's dynamic import
 * attempt does not fail when resolving a Windows-style path on Linux/macOS.
 *
 * Must run in an isolated bun test invocation to avoid mock.module hoisting
 * contaminating other test files that import from the same registry module.
 */
import path from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const resolveAction = mock(async () => async () => ({ ok: true }));
mock.module('../../packages/slingshot-ssr/src/actions/registry', () => ({
  resolveAction,
  clearActionCache: () => {},
}));

const { buildActionRouter } = await import(
  '../../packages/slingshot-ssr/src/actions/routes?windows-style-actions-dir'
);

describe('buildActionRouter() — Windows-style serverActionsDir resolution', () => {
  test('uses win32 path semantics for Windows-style action directories', async () => {
    resolveAction.mockClear();

    const app = new Hono();
    app.route(
      '/_snapshot',
      buildActionRouter({
        trustedOrigins: [],
        serverActionsDir: 'C:\\temp\\actions',
      }),
    );

    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        module: 'posts',
        action: 'createPost',
        args: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(resolveAction).toHaveBeenCalledTimes(1);
    expect(resolveAction.mock.calls[0]?.[0]).toBe(
      path.win32.resolve('C:\\temp\\actions', 'posts'),
    );
  });
});
