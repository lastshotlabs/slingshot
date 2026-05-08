// End-to-end integration test for the TanStack route-source pipeline:
//   scan routes directory
//     → resolve a URL to a match (with loadModule hook)
//       → pass match to slingshot-ssr's executeRouteModule
//         → assert load() ran, meta() ran, and Page is the component
//
// This is the contract between the route source and slingshot-ssr's
// renderer-facing helpers. The unit tests in source.test.ts call
// `match.loadModule()` directly; this one routes through the actual
// `executeRouteModule` consumer to catch shape mismatches.

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeRouteModule, type SsrLoadContext } from '@lastshotlabs/slingshot-ssr';
import { createTanStackRouteSource } from '../../src/source';

function mkFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tanstack-integration-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('TanStack source → executeRouteModule', () => {
  it('loads a route module via the source hook and runs load + meta + Page', async () => {
    const dir = mkFixture({
      '__root.tsx': `export const Route = { options: { component: () => null } };`,
      '_public.tsx': `export const Route = { options: { component: () => null } };`,
      '_public/u/$handle.tsx': `
        export const Route = {
          options: {
            component: function ProfilePage(props) {
              return { kind: 'profile', loaderData: props.loaderData };
            },
          },
        };
      `,
      '_public/u/$handle.server.ts': `
        export async function load(ctx) {
          return {
            data: { handle: ctx.params.handle, q: ctx.query.q ?? null },
            tags: ['profile:' + ctx.params.handle],
          };
        }
        export async function meta(ctx, loaderResult) {
          return { title: '@' + loaderResult.data.handle };
        }
      `,
    });

    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const match = source.resolve('/u/jdd');
    expect(match).not.toBeNull();
    expect(match!.loadModule).toBeDefined();

    const ctx: SsrLoadContext = {
      params: { ...match!.params },
      query: { q: 'hello' },
      url: new URL('http://localhost/u/jdd?q=hello'),
      headers: new Headers(),
      getUser: async () => null,
      bsCtx: {} as never,
      draftMode: () => ({ isEnabled: false }),
      after: () => {},
    };

    const exec = await executeRouteModule(match!, ctx);

    // load() ran with the right context shape.
    expect(exec.loaderResult).toMatchObject({
      data: { handle: 'jdd', q: 'hello' },
      tags: ['profile:jdd'],
    });

    // meta() ran with both ctx and loaderResult.
    expect(exec.meta).toEqual({ title: '@jdd' });

    // Page is the component from the .tsx file (the route's component option).
    expect(typeof exec.Page).toBe('function');
    const rendered = exec.Page({ loaderData: { handle: 'jdd', q: 'hello' } } as never);
    expect(rendered).toEqual({
      kind: 'profile',
      loaderData: { handle: 'jdd', q: 'hello' },
    });
  });

  it('passes loader signals (notFound, redirect) through unchanged', async () => {
    const dir = mkFixture({
      '_public/gone.tsx': `export const Route = { options: { component: () => null } };`,
      '_public/gone.server.ts': `
        export async function load() { return { notFound: true }; }
      `,
      '_public/go.tsx': `export const Route = { options: { component: () => null } };`,
      '_public/go.server.ts': `
        export async function load() { return { redirect: '/elsewhere', status: 302 }; }
      `,
    });

    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();

    const ctx: SsrLoadContext = {
      params: {},
      query: {},
      url: new URL('http://localhost/gone'),
      headers: new Headers(),
      getUser: async () => null,
      bsCtx: {} as never,
      draftMode: () => ({ isEnabled: false }),
      after: () => {},
    };

    const goneMatch = source.resolve('/gone')!;
    const goneExec = await executeRouteModule(goneMatch, ctx);
    // Loader signals are part of SsrLoaderReturn, a wider type than the
    // SsrLoadResult that executeRouteModule narrows to. Cast to inspect.
    expect(goneExec.loaderResult as unknown).toEqual({ notFound: true });

    const goMatch = source.resolve('/go')!;
    const goExec = await executeRouteModule(goMatch, {
      ...ctx,
      url: new URL('http://localhost/go'),
    });
    expect(goExec.loaderResult as unknown).toEqual({
      redirect: '/elsewhere',
      status: 302,
    });
  });

  it('omits meta when the companion does not export it', async () => {
    const dir = mkFixture({
      '_public/p.tsx': `export const Route = { options: { component: () => null } };`,
      '_public/p.server.ts': `
        export async function load() { return { data: { x: 1 } }; }
      `,
    });

    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();

    const match = source.resolve('/p')!;
    const exec = await executeRouteModule(match, {
      params: {},
      query: {},
      url: new URL('http://localhost/p'),
      headers: new Headers(),
      getUser: async () => null,
      bsCtx: {} as never,
      draftMode: () => ({ isEnabled: false }),
      after: () => {},
    });
    expect(exec.loaderResult).toMatchObject({ data: { x: 1 } });
    // executeRouteModule defaults meta to {} when the module has no export.
    expect(exec.meta).toEqual({});
  });
});
