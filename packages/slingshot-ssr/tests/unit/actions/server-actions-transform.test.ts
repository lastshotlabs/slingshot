// packages/slingshot-ssr/tests/unit/actions/server-actions-transform.test.ts
//
// Tests for the Vite server-actions transform plugin.
// We test it via snapshot/src/vite/server-actions.ts but since that lives in a
// different package, these tests focus on the behaviours implemented in this
// package's route and registry layers. Integration-level transform tests live
// in snapshot/src/ssr/__tests__/action-client.test.ts.
//
// This file is intentionally minimal — the detailed transform tests are in the
// snapshot package where the plugin lives.
import { describe, expect, test } from 'bun:test';
import { ActionRedirect, buildActionRouter } from '../../../src/actions/routes';

describe('ActionRedirect (exported from actions/routes)', () => {
  test('is an Error subclass', () => {
    const err = new ActionRedirect('/home');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof ActionRedirect).toBe(true);
  });

  test('stores the destination', () => {
    expect(new ActionRedirect('/foo').destination).toBe('/foo');
    expect(new ActionRedirect('/bar/baz').destination).toBe('/bar/baz');
  });

  test('has the correct name', () => {
    expect(new ActionRedirect('/').name).toBe('ActionRedirect');
  });
});

describe('buildActionRouter() — config freeze', () => {
  test('returns a Hono instance', () => {
    const router = buildActionRouter({
      trustedOrigins: [],
      serverActionsDir: '/tmp/actions',
    });
    // Hono instances have a .fetch method used by the Hono runtime.
    expect(typeof router.fetch).toBe('function');
  });

  test('does not mutate the input config object', () => {
    const config = { trustedOrigins: ['safe.com'] as readonly string[], serverActionsDir: '/tmp' };
    const original = { ...config };
    buildActionRouter(config);
    expect(config.trustedOrigins).toEqual(original.trustedOrigins);
    expect(config.serverActionsDir).toBe(original.serverActionsDir);
  });
});
