// packages/slingshot-ssg/tests/renderer.test.ts
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type {
  SlingshotSsrRenderer,
  SsrRouteChain,
  SsrRouteMatch,
  SsrShell,
} from '@lastshotlabs/slingshot-ssr';
import { renderSsgPage, renderSsgPages } from '../src/renderer';
import type { SsgConfig } from '../src/types';

const TMP = join(import.meta.dir, '__tmp_renderer__');

function makeConfig(overrides?: Partial<SsgConfig>): SsgConfig {
  return Object.freeze({
    serverRoutesDir: join(TMP, 'routes'),
    assetsManifest: join(TMP, 'manifest.json'),
    outDir: join(TMP, 'out'),
    concurrency: 2,
    ...overrides,
  });
}

function makeRouteMatch(url: URL): SsrRouteMatch {
  return {
    filePath: '/fake/route.ts',
    metaFilePath: null,
    params: {},
    query: {},
    url,
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
  };
}

/** Build a renderer stub that always returns a 200 HTML response. */
function makeOkRenderer(html = '<html><body>hello</body></html>'): SlingshotSsrRenderer {
  return {
    async resolve(url): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(_match: SsrRouteMatch, shell: SsrShell): Promise<Response> {
      return new Response(`${html}<!-- assets:${shell.assetTags} -->`, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    async renderChain(chain: SsrRouteChain, shell: SsrShell): Promise<Response> {
      return new Response(
        `${html}<!-- chain:${chain.page.url.pathname} --><!-- assets:${shell.assetTags} -->`,
        {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        },
      );
    },
  };
}

/** Renderer that returns null from resolve() — simulates unmatched route. */
function makeNullRenderer(): SlingshotSsrRenderer {
  return {
    async resolve() {
      return null;
    },
    async render(): Promise<Response> {
      throw new Error('render should never be called when resolve returns null');
    },
    async renderChain(): Promise<Response> {
      throw new Error('renderChain should never be called when resolve returns null');
    },
  };
}

/** Renderer that returns a 302 redirect. */
function makeRedirectRenderer(): SlingshotSsrRenderer {
  return {
    async resolve(url): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(): Promise<Response> {
      return new Response(null, { status: 302, headers: { Location: '/login' } });
    },
    async renderChain(): Promise<Response> {
      return new Response(null, { status: 302, headers: { Location: '/login' } });
    },
  };
}

/** Renderer that throws from render(). */
function makeThrowingRenderer(): SlingshotSsrRenderer {
  return {
    async resolve(url): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(): Promise<Response> {
      throw new Error('simulated render failure');
    },
    async renderChain(): Promise<Response> {
      throw new Error('simulated render failure');
    },
  };
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(join(TMP, 'out'), { recursive: true, force: true });
});

describe('renderSsgPage — success path', () => {
  it('writes index.html for a simple path', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/about', makeOkRenderer(), config);

    expect(result.path).toBe('/about');
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const written = join(config.outDir, 'about', 'index.html');
    expect(existsSync(written)).toBe(true);
    const content = readFileSync(written, 'utf8');
    expect(content).toContain('<body>hello</body>');
  });

  it('writes index.html for root /', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/', makeOkRenderer(), config);

    expect(result.error).toBeUndefined();
    const written = join(config.outDir, 'index.html');
    expect(existsSync(written)).toBe(true);
  });

  it('writes nested paths correctly', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/posts/hello-world', makeOkRenderer(), config);

    expect(result.error).toBeUndefined();
    const written = join(config.outDir, 'posts', 'hello-world', 'index.html');
    expect(existsSync(written)).toBe(true);
  });

  it('injects assetTagsHtml into the shell', async () => {
    const config = makeConfig();
    await renderSsgPage('/page', makeOkRenderer(), config, '<script src="/app.js"></script>');

    const written = join(config.outDir, 'page', 'index.html');
    const content = readFileSync(written, 'utf8');
    expect(content).toContain('<script src="/app.js"></script>');
  });

  it('creates output directory if it does not exist', async () => {
    const config = makeConfig({ outDir: join(TMP, 'out', 'deep', 'nested') });
    const result = await renderSsgPage('/page', makeOkRenderer(), config);
    expect(result.error).toBeUndefined();
    expect(existsSync(join(config.outDir, 'page', 'index.html'))).toBe(true);
  });

  it('returns filePath in the result', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/faq', makeOkRenderer(), config);
    expect(result.filePath).toBe(join(config.outDir, 'faq', 'index.html'));
  });
});

describe('renderSsgPage — error paths', () => {
  it('returns error when resolve() returns null', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/missing', makeNullRenderer(), config);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('No route matched');
  });

  it('returns error for non-200 response (redirect)', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/redirect', makeRedirectRenderer(), config);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('HTTP 302');
  });

  it('returns error when render() throws', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/crash', makeThrowingRenderer(), config);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('simulated render failure');
  });

  it('still returns a result with path and filePath on error', async () => {
    const config = makeConfig();
    const result = await renderSsgPage('/broken', makeNullRenderer(), config);
    expect(result.path).toBe('/broken');
    expect(result.filePath).toBeTruthy();
  });
});

describe('renderSsgPages — batch rendering', () => {
  it('renders multiple pages and returns aggregate result', async () => {
    const config = makeConfig({ concurrency: 2 });
    const result = await renderSsgPages(['/a', '/b', '/c'], makeOkRenderer(), config);

    expect(result.pages).toHaveLength(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts failed pages without aborting the run', async () => {
    // Mix of OK and null-resolver paths — null renderer fails all
    const config = makeConfig({ concurrency: 2 });
    const result = await renderSsgPages(['/x', '/y'], makeNullRenderer(), config);

    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.pages).toHaveLength(2);
  });

  it('returns empty result for empty paths array', async () => {
    const config = makeConfig();
    const result = await renderSsgPages([], makeOkRenderer(), config);
    expect(result.pages).toHaveLength(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('respects concurrency — renders more pages than concurrency limit', async () => {
    const config = makeConfig({ concurrency: 2 });
    const paths = ['/p1', '/p2', '/p3', '/p4', '/p5'];
    const result = await renderSsgPages(paths, makeOkRenderer(), config);
    expect(result.succeeded).toBe(5);
  });
});
