// packages/slingshot-ssg/src/index.ts

export type {
  SsgConfig,
  SsgPageError,
  SsgPageResult,
  SsgResult,
  SsgStaticPathsFn,
} from './types';
export { resolveExitCode } from './cli';

export { ssgConfigSchema, parseSsgConfig } from './config.schema';
export type { SsgConfigParsed } from './config.schema';

export { collectSsgRoutes } from './crawler';

export { renderSsgPage, renderSsgPages } from './renderer';
