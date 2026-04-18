/**
 * `@lastshotlabs/slingshot-embeds` — URL unfurling plugin for slingshot.
 *
 * Fetches a URL server-side, parses Open Graph and meta tag metadata,
 * and returns structured data suitable for rendering link previews.
 *
 * @example
 * ```ts
 * import { createEmbedsPlugin } from '@lastshotlabs/slingshot-embeds';
 *
 * // Register as a slingshot plugin
 * const embeds = createEmbedsPlugin({ cacheTtlMs: 60_000 });
 * ```
 *
 * @example
 * ```ts
 * // Use the unfurl function directly
 * import { unfurl } from '@lastshotlabs/slingshot-embeds';
 *
 * const result = await unfurl('https://example.com', {
 *   timeoutMs: 5000,
 *   maxResponseBytes: 1_048_576,
 * });
 * ```
 *
 * @packageDocumentation
 */

/* --- Plugin ------------------------------------------------------------ */
export { createEmbedsPlugin } from './plugin';

/* --- Types ------------------------------------------------------------- */
export type { UnfurlResult, EmbedsPluginConfig } from './types';
export { embedsPluginConfigSchema } from './types';

/* --- Lib (advanced usage) ---------------------------------------------- */
export { unfurl } from './lib/unfurl';
export { parseOgMetadata } from './lib/htmlParser';
export { validateUrl } from './lib/ssrfGuard';
