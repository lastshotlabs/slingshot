import type { SlingshotContext } from '../../../packages/slingshot-core/src/index.ts';
import type {
  PageLoaderResult,
  SlingshotSsrRenderer,
  SsrRouteChain,
  SsrRouteMatch,
  SsrShell,
} from '../../../packages/slingshot-ssr/src/index.ts';

function htmlResponse(title: string, body: string, shell: SsrShell): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>${title}</title>${shell.headTags}${shell.assetTags}</head><body>${body}</body></html>`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

export const renderer: SlingshotSsrRenderer = {
  async resolve(_url: URL, _bsCtx: SlingshotContext): Promise<SsrRouteMatch | null> {
    return null;
  },

  async render(match: SsrRouteMatch, shell: SsrShell, _bsCtx: SlingshotContext): Promise<Response> {
    return htmlResponse(
      'Content Platform',
      `<main><h1>SSR page</h1><p>${match.url.pathname}</p></main>`,
      shell,
    );
  },

  async renderChain(
    chain: SsrRouteChain,
    shell: SsrShell,
    _bsCtx: SlingshotContext,
  ): Promise<Response> {
    return htmlResponse(
      'Content Platform',
      `<main><h1>SSR route chain</h1><p>${chain.page.url.pathname}</p></main>`,
      shell,
    );
  },

  async renderPage(
    result: PageLoaderResult,
    shell: SsrShell,
    _bsCtx: SlingshotContext,
  ): Promise<Response> {
    return htmlResponse(
      'Content Platform',
      `<main><h1>Page declaration</h1><p>${result.declaration.key}</p></main>`,
      shell,
    );
  },
};
