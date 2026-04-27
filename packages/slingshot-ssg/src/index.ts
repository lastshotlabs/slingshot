// packages/slingshot-ssg/src/index.ts

export type { SsgConfig, SsgPageResult, SsgResult, SsgStaticPathsFn } from './types';

export { ssgConfigSchema, parseSsgConfig } from './config.schema';
export type { SsgConfigParsed } from './config.schema';

export { collectSsgRoutes } from './crawler';

export { renderSsgPage, renderSsgPages } from './renderer';
