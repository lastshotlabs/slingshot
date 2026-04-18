import { collectSsgRoutes, renderSsgPages } from '../../../packages/slingshot-ssg/src/index.ts';
import { renderer } from '../src/renderer.ts';

const config = {
  serverRoutesDir: new URL('../server/routes/', import.meta.url).pathname,
  assetsManifest: new URL('../client-manifest.json', import.meta.url).pathname,
  outDir: new URL('../dist/static/', import.meta.url).pathname,
  concurrency: 4,
};

const paths = await collectSsgRoutes(config);
await renderSsgPages(paths, renderer, config);
