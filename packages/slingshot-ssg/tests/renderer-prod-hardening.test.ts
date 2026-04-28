// Integration test for P-SSG-5: per-page errors include structured details
// (`errorDetail`) on the result object so build summaries can list failures
// without scraping `console.error` lines.
import { mkdirSync, rmSync } from 'node:fs';
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

const TMP = join(import.meta.dir, '__tmp_renderer_prod__');

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

function makeFailingRenderer(message = 'render boom'): SlingshotSsrRenderer {
  return {
    async resolve(url): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(): Promise<Response> {
      throw new Error(message);
    },
    async renderChain(_chain: SsrRouteChain, _shell: SsrShell): Promise<Response> {
      throw new Error(message);
    },
  };
}

function makeOkRenderer(): SlingshotSsrRenderer {
  return {
    async resolve(url): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(): Promise<Response> {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    async renderChain(): Promise<Response> {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP);
});

describe('renderSsgPage — structured per-page error details (P-SSG-5)', () => {
  it('attaches errorDetail mirroring the Error fields when render throws', async () => {
    const result = await renderSsgPage('/explode', makeFailingRenderer('render boom'), makeConfig());
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('render boom');
    expect(result.errorDetail).toBeDefined();
    expect(result.errorDetail?.message).toBe('render boom');
    expect(result.errorDetail?.name).toBe('Error');
    expect(result.errorDetail?.route).toBe('/explode');
    expect(typeof result.errorDetail?.stack).toBe('string');
  });

  it('attaches errorDetail when the renderer returns a non-200 response', async () => {
    const renderer: SlingshotSsrRenderer = {
      async resolve(url): Promise<SsrRouteMatch> {
        return makeRouteMatch(url);
      },
      async render(): Promise<Response> {
        return new Response('forbidden', { status: 403 });
      },
      async renderChain(): Promise<Response> {
        return new Response('forbidden', { status: 403 });
      },
    };
    const result = await renderSsgPage('/restricted', renderer, makeConfig());
    expect(result.errorDetail).toBeDefined();
    expect(result.errorDetail?.route).toBe('/restricted');
    expect(result.errorDetail?.message).toContain('HTTP 403');
  });

  it('does not attach errorDetail on success', async () => {
    const result = await renderSsgPage('/ok', makeOkRenderer(), makeConfig());
    expect(result.error).toBeUndefined();
    expect(result.errorDetail).toBeUndefined();
  });

  it('renderSsgPages aggregates structured per-page errors across mixed outcomes', async () => {
    const renderer: SlingshotSsrRenderer = {
      async resolve(url): Promise<SsrRouteMatch> {
        return makeRouteMatch(url);
      },
      async render(match): Promise<Response> {
        if (match.url.pathname === '/bad') throw new Error('bad page boom');
        return new Response('<html>ok</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
      async renderChain(chain): Promise<Response> {
        if (chain.page.url.pathname === '/bad') throw new Error('bad page boom');
        return new Response('<html>ok</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    };
    const result = await renderSsgPages(['/good', '/bad'], renderer, makeConfig());
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    const failedPages = result.pages.filter(p => p.errorDetail);
    expect(failedPages).toHaveLength(1);
    expect(failedPages[0].errorDetail?.route).toBe('/bad');
    expect(failedPages[0].errorDetail?.message).toBe('bad page boom');
  });
});
