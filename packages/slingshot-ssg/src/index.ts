/**
 * Static site generation config, page result, error, and path resolver types.
 */
export type { SsgConfig, SsgPageError, SsgPageResult, SsgResult, SsgStaticPathsFn } from './types';
/**
 * Resolve the process exit code for an SSG run result.
 */
export { resolveExitCode } from './cli';

/**
 * Runtime schema and parser for SSG configuration.
 */
export { ssgConfigSchema, parseSsgConfig } from './config.schema';
/**
 * Parsed SSG configuration shape after schema validation.
 */
export type { SsgConfigParsed } from './config.schema';

/**
 * Collect route entries that should be rendered during static generation.
 */
export { collectSsgRoutes } from './crawler';

/**
 * Render one or more SSG pages through the configured application renderer.
 */
export { renderSsgPage, renderSsgPages } from './renderer';
/**
 * Typed error classes thrown by the SSG package.
 */
export {
  SsgCliArgError,
  SsgConfigError,
  SsgCrawlError,
  SsgError,
  SsgRenderError,
} from './errors';
