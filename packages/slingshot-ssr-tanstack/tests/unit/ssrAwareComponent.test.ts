// Tests for ssrAwareComponent's per-render source selection.
//
// The wrapper must pick the right loaderData source in three contexts:
//   1. SSR render        — no `window`, host passes `loaderData` prop.
//   2. SSR hydration     — `window` EXISTS, host passes `loaderData` prop,
//                          and there is NO TanStack RouterProvider. Calling
//                          `useLoaderData()` here throws and blanks the page
//                          (the regression this file guards against).
//   3. Soft client nav   — `window` exists, TanStack mounted the component,
//                          no prop; `useLoaderData()` is the only source.
//
// `useLoaderData` is module-mocked with a swappable implementation so each
// test controls whether the router hook is available or throws like it does
// outside a RouterProvider.
import { afterEach, describe, expect, it, mock } from 'bun:test';

type UseLoaderDataImpl = (opts: { from: string }) => unknown;

const routerlessThrow: UseLoaderDataImpl = () => {
  // Mirrors TanStack's real failure mode outside a RouterProvider.
  throw new TypeError("Cannot read properties of null (reading 'stores')");
};

let useLoaderDataImpl: UseLoaderDataImpl = routerlessThrow;
const useLoaderDataSpy = mock((opts: { from: string }) => useLoaderDataImpl(opts));
let routerPresent = false;
const useRouterSpy = mock(() => (routerPresent ? { stores: {} } : null));

mock.module('@tanstack/react-router', () => ({
  useLoaderData: useLoaderDataSpy,
  useRouter: useRouterSpy,
}));

const { ssrAwareComponent } = await import('../../src/client');

interface PageProps {
  loaderData: unknown;
}

function makePage() {
  const calls: PageProps[] = [];
  const Page = (props: PageProps) => {
    calls.push(props);
    return `rendered:${JSON.stringify(props.loaderData)}`;
  };
  return { Page, calls };
}

const hasOwnWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');

function withWindow<T>(fn: () => T): T {
  (globalThis as Record<string, unknown>)['window'] = {};
  try {
    return fn();
  } finally {
    if (!hasOwnWindow) delete (globalThis as Record<string, unknown>)['window'];
  }
}

afterEach(() => {
  useLoaderDataImpl = routerlessThrow;
  routerPresent = false;
  useLoaderDataSpy.mockClear();
  useRouterSpy.mockClear();
});

describe('ssrAwareComponent', () => {
  it('SSR render: no window → uses the loaderData prop, never calls the hook', () => {
    const { Page, calls } = makePage();
    const Component = ssrAwareComponent(Page, '/_public/u/$handle');

    const out = Component({ loaderData: { profile: 'jdd' } });

    expect(out).toBe('rendered:{"profile":"jdd"}');
    expect(calls[0]?.loaderData).toEqual({ profile: 'jdd' });
    expect(useLoaderDataSpy).not.toHaveBeenCalled();
  });

  it('SSR render: missing prop normalises to null', () => {
    const { Page, calls } = makePage();
    const Component = ssrAwareComponent(Page, '/_public/search');

    Component();

    expect(calls[0]?.loaderData).toBeNull();
    expect(useLoaderDataSpy).not.toHaveBeenCalled();
  });

  it('hydration: window exists + prop passed → uses the prop; hook (which would throw) is not called', () => {
    const { Page, calls } = makePage();
    const Component = ssrAwareComponent(Page, '/_public/c/$slug');

    const out = withWindow(() => Component({ loaderData: { container: 'c1' } }));

    expect(out).toBe('rendered:{"container":"c1"}');
    expect(calls[0]?.loaderData).toEqual({ container: 'c1' });
    expect(useLoaderDataSpy).not.toHaveBeenCalled();
  });

  it('hydration: an explicit null prop still counts as host-supplied data', () => {
    const { Page, calls } = makePage();
    const Component = ssrAwareComponent(Page, '/_public/c/$slug');

    withWindow(() => Component({ loaderData: null }));

    expect(calls[0]?.loaderData).toBeNull();
    expect(useLoaderDataSpy).not.toHaveBeenCalled();
  });

  it('soft client nav: window exists + no prop → reads from useLoaderData with the route path', () => {
    const { Page, calls } = makePage();
    const Component = ssrAwareComponent(Page, '/_public/u/$handle');
    routerPresent = true;
    useLoaderDataImpl = () => ({ profile: 'from-router' });

    const out = withWindow(() => Component({}));

    expect(out).toBe('rendered:{"profile":"from-router"}');
    expect(calls[0]?.loaderData).toEqual({ profile: 'from-router' });
    expect(useLoaderDataSpy).toHaveBeenCalledTimes(1);
    expect(useLoaderDataSpy.mock.calls[0]?.[0]).toEqual({ from: '/_public/u/$handle' });
  });

  it('router-owned SSR: no window + router context → reads TanStack loader data', () => {
    const { Page, calls } = makePage();
    const Component = ssrAwareComponent(Page, '/_public/search');
    routerPresent = true;
    useLoaderDataImpl = () => ({ results: ['nba'] });

    Component({});

    expect(calls[0]?.loaderData).toEqual({ results: ['nba'] });
    expect(useLoaderDataSpy).toHaveBeenCalledTimes(1);
  });
});
