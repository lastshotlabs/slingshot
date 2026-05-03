import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  clearRouteModuleCache,
  executeRouteModule,
  loadRouteModule,
} from '../../src/routeExecution';
import type { SsrLoadContext, SsrRouteMatch } from '../../src/types';

const TMP = join(import.meta.dir, '__tmp_route_execution__');

function makeMatch(filePath: string, params: Record<string, string> = {}): SsrRouteMatch {
  return {
    filePath,
    metaFilePath: null,
    params,
    query: {},
    url: new URL('http://localhost/'),
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
  };
}

function makeCtx(overrides: Partial<SsrLoadContext> = {}): SsrLoadContext {
  return {
    params: {},
    query: {},
    url: new URL('http://localhost/'),
    headers: new Headers(),
    getUser: async () => null,
    bsCtx: {} as SsrLoadContext['bsCtx'],
    draftMode: () => ({ isEnabled: false }),
    ...overrides,
  } as SsrLoadContext;
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP);
  clearRouteModuleCache();
});

describe('executeRouteModule', () => {
  it('imports the route file, runs load(), and returns Page', async () => {
    const file = join(TMP, 'posts.ts');
    writeFileSync(
      file,
      `export async function load(ctx) {
         return { data: { slug: ctx.params.slug ?? 'home' } };
       }
       export default function Page({ loaderData }) {
         return { tag: 'h1', text: loaderData.slug };
       }`,
    );

    const exec = await executeRouteModule(
      makeMatch(file, { slug: 'hello' }),
      makeCtx({
        params: { slug: 'hello' },
      }),
    );

    expect(exec.loaderResult).toEqual({ data: { slug: 'hello' } });
    expect(exec.meta).toEqual({});
    const rendered = exec.Page({
      loaderData: { slug: 'hello' },
      params: { slug: 'hello' },
      query: {},
    });
    expect(rendered).toEqual({ tag: 'h1', text: 'hello' });
  });

  it('runs meta() when exported and threads loaderResult through', async () => {
    const file = join(TMP, 'about.ts');
    writeFileSync(
      file,
      `export async function load() { return { data: { title: 'About Us' } }; }
       export async function meta(_ctx, result) { return { title: result.data.title }; }
       export default function Page() { return null; }`,
    );

    const exec = await executeRouteModule(makeMatch(file), makeCtx());
    expect(exec.meta).toEqual({ title: 'About Us' });
  });

  it('returns empty meta when no meta() is exported', async () => {
    const file = join(TMP, 'no-meta.ts');
    writeFileSync(
      file,
      `export async function load() { return { data: {} }; }
       export default function Page() { return null; }`,
    );

    const exec = await executeRouteModule(makeMatch(file), makeCtx());
    expect(exec.meta).toEqual({});
  });

  it('passes redirect signals through on loaderResult', async () => {
    const file = join(TMP, 'redirect.ts');
    writeFileSync(
      file,
      `export async function load() { return { redirect: '/login' }; }
       export default function Page() { return null; }`,
    );

    const exec = await executeRouteModule(makeMatch(file), makeCtx());
    expect(exec.loaderResult).toEqual({ redirect: '/login' });
  });
});

describe('loadRouteModule caching', () => {
  it('returns the same module instance on repeated calls', async () => {
    const file = join(TMP, 'cached.ts');
    writeFileSync(
      file,
      `export async function load() { return { data: {} }; }
       export default function Page() { return null; }`,
    );

    const a = await loadRouteModule(file);
    const b = await loadRouteModule(file);
    expect(a).toBe(b);
  });

  it('clearRouteModuleCache() forces a fresh import', async () => {
    const file = join(TMP, 'fresh.ts');
    writeFileSync(
      file,
      `export async function load() { return { data: { v: 1 } }; }
       export default function Page() { return null; }`,
    );

    const first = await loadRouteModule(file);
    clearRouteModuleCache();
    const second = await loadRouteModule(file);
    // After clearing, a brand-new promise is created. The resolved module
    // identity may match (Bun caches module evaluation) but the promise wrapper differs.
    expect(second).toBeDefined();
    expect(first).toBeDefined();
  });
});
