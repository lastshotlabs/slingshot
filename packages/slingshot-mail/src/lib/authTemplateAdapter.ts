/**
 * Returns all email templates registered via slingshot-core's EmailTemplateRegistry.
 *
 * Auth (or any plugin) registers templates during setupPost(). This function
 * reads from the shared registry — no direct slingshot-auth import needed.
 *
 * The returned map is compatible with `createRawHtmlRenderer({ templates: ... })`.
 *
 * IMPORTANT: Call this after all plugins have run setupPost(). Templates are registered
 * during that phase. Calling earlier will return an empty or partial map and produce
 * silent delivery failures.
 */
import { createConsoleLogger, getEmailTemplates } from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import type { RawHtmlTemplate } from '../renderers/rawHtml';

const logger: Logger = createConsoleLogger({ base: { component: 'slingshot-mail' } });

/**
 * Returns a templates map suitable for `createRawHtmlRenderer` that contains all
 * registered email templates from any plugin, keyed by their registered name.
 *
 * Must be called after all plugins have completed setupPost().
 */
export function adaptRegisteredTemplates(app: object): Promise<Record<string, RawHtmlTemplate>> {
  const templates = getEmailTemplates(app);
  const result: Record<string, RawHtmlTemplate> = {};

  for (const [key, tpl] of Object.entries(templates)) {
    result[key] = { subject: tpl.subject, html: tpl.html, text: tpl.text };
  }

  if (Object.keys(result).length === 0) {
    logger.warn(
      '[slingshot-mail] adaptRegisteredTemplates: no templates found — ensure this is called after all plugins have run setupPost()',
    );
  }

  return Promise.resolve(result);
}
