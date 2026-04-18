// packages/slingshot-ssg/src/index.ts

export type { SsgConfig, SsgPageResult, SsgResult, SsgStaticPathsFn } from './types';

export { collectSsgRoutes } from './crawler';

export { renderSsgPage, renderSsgPages } from './renderer';
