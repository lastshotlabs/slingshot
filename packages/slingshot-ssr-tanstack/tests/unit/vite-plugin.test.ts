import { describe, expect, it } from 'bun:test';
import { stripServerFiles } from '../../src/vite-plugin';

// The Vite plugin shape is two methods: resolveId + load. Both are sync hooks
// here, so we can call them as plain functions for unit testing without
// constructing a full Vite environment.

describe('stripServerFiles plugin', () => {
  const plugin = stripServerFiles();

  function callResolve(id: string, ssr = false) {
    const fn = plugin.resolveId as (
      id: string,
      importer: string | undefined,
      options: { ssr: boolean },
    ) => string | null;
    return fn.call({} as never, id, undefined, { ssr });
  }

  function callLoad(id: string) {
    const fn = plugin.load as (id: string) => string | null;
    return fn.call({} as never, id);
  }

  it('rewrites .server.ts imports in client builds', () => {
    const result = callResolve('/abs/path/to/route.server.ts', false);
    expect(result).not.toBeNull();
    expect(result!.startsWith('\0slingshot-ssr-tanstack:server-stub:')).toBe(true);
  });

  it('rewrites .server.tsx imports', () => {
    const result = callResolve('./foo.server.tsx', false);
    expect(result).not.toBeNull();
  });

  it('handles query strings (e.g. Vite HMR suffix)', () => {
    const result = callResolve('/abs/route.server.ts?v=12345', false);
    expect(result).not.toBeNull();
  });

  it('passes through SSR builds untouched', () => {
    expect(callResolve('/abs/path/route.server.ts', true)).toBeNull();
  });

  it('passes through non-server files', () => {
    expect(callResolve('/abs/path/route.tsx', false)).toBeNull();
    expect(callResolve('/abs/path/utils.ts', false)).toBeNull();
  });

  it('load returns the empty stub for virtual ids', () => {
    const stubId = '\0slingshot-ssr-tanstack:server-stub:/abs/route.server.ts';
    const body = callLoad(stubId);
    expect(body).toContain('export {};');
  });

  it('load returns null for non-virtual ids', () => {
    expect(callLoad('/abs/route.tsx')).toBeNull();
  });

  it('passes through .server.ts files inside node_modules', () => {
    // A node_modules package legitimately shipping a `.server.*` file should
    // NOT be silently stubbed — if it imports server-only deps it should fail
    // loudly. The convention belongs to application route trees, not vendor.
    expect(
      callResolve('/abs/proj/node_modules/some-pkg/dist/foo.server.ts', false),
    ).toBeNull();
    expect(
      callResolve('/abs/proj/node_modules/.bun/pkg@1/node_modules/x.server.js', false),
    ).toBeNull();
  });
});
