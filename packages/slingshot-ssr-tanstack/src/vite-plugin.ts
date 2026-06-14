// packages/slingshot-ssr-tanstack/src/vite-plugin.ts
//
// Vite plugin: strip `*.server.{ts,tsx,js,jsx}` modules from the client bundle.
//
// Companion-file convention requires that server-only loaders live in files
// named `<route>.server.{ts,tsx}`. The server side of the build (slingshot's
// route source) imports them via Bun directly. The client side of the build
// (Vite's CSR entry) must NEVER bundle them — they may import database
// drivers, slingshot-core, or other server-only modules whose presence in the
// client bundle either fails the build or leaks server code to the browser.
//
// This plugin intercepts client-build resolution: any module whose path ends
// in `.server.{ts,tsx,js,jsx}` (with or without query params) is rewritten to
// a tiny virtual module exporting nothing. Code that called those exports
// will get `undefined` at runtime — but that code should never run client-side
// because it lives in the SSR-only loader path.
//
// Usage in apps/web/vite.config.ts:
//
// ```ts
// import { stripServerFiles } from '@lastshotlabs/slingshot-ssr-tanstack/vite';
//
// export default defineConfig({
//   plugins: [
//     stripServerFiles(),
//     react(),
//     // ...
//   ],
// });
// ```
import type { Plugin } from 'vite';

const SERVER_FILE_RE = /\.server\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)(\?[^?]*)?$/;
const VIRTUAL_PREFIX = '\0slingshot-ssr-tanstack:server-stub:';

/** Empty module returned in place of any `.server.*` file in the client build. */
const STUB_BODY = [
  '// This module was a .server.* file, replaced by',
  "// @lastshotlabs/slingshot-ssr-tanstack's Vite plugin because we are in a",
  '// CLIENT build. Server-only loaders never run in the browser.',
  'export {};',
  '',
].join('\n');

/**
 * Vite plugin: replace `.server.{ts,tsx,js,jsx,mts,cts,mjs,cjs}` imports with
 * an empty module in the client build. SSR builds pass through unchanged.
 */
export function stripServerFiles(): Plugin {
  return {
    name: 'slingshot-ssr-tanstack:strip-server-files',
    enforce: 'pre',

    resolveId(id, _importer, options) {
      // Vite passes `{ ssr: true }` for the SSR build. We only want to strip
      // when building/serving the CLIENT bundle.
      if (options?.ssr) return null;
      // Don't stub `.server.*` files that live in `node_modules` — that
      // convention belongs to *application* route trees. A package legitimately
      // shipping a `.server.*` filename (rare but possible) should not be
      // silently emptied; if it imports server-only deps it'll fail loudly,
      // which is the correct outcome.
      if (id.includes('/node_modules/')) return null;
      if (!SERVER_FILE_RE.test(id)) return null;
      return VIRTUAL_PREFIX + id;
    },

    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      return STUB_BODY;
    },
  };
}
