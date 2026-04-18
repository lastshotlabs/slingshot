/**
 * The rendered output of an email template.
 * Contains the final HTML body, an optional plain-text alternative, and an optional subject line.
 */
export interface RenderResult {
  /**
   * Email subject line rendered by the template, or `undefined` if the template does not
   * supply one.
   *
   * @remarks
   * When `undefined`, the mail plugin falls back to the subject configured statically in
   * the `EmailTemplate` registration (e.g. `addEmailTemplates({ welcome: { subject: '...' } })`).
   * If neither the `RenderResult` nor the registration provides a subject, the mail plugin
   * will use an empty string — callers should always provide at least one of these.
   */
  subject?: string;
  /** HTML body of the rendered email. */
  html: string;
  /** Plain-text alternative for clients that cannot render HTML. */
  text?: string;
}

/**
 * Thrown by `MailRenderer.render()` when the requested template name does not exist
 * in the renderer's template store.
 *
 * @example
 * ```ts
 * import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
 *
 * try {
 *   await renderer.render('welcome', { name: 'Alice' });
 * } catch (err) {
 *   if (err instanceof TemplateNotFoundError) {
 *     console.error('Missing template:', err.templateName);
 *   }
 * }
 * ```
 */
export class TemplateNotFoundError extends Error {
  constructor(public readonly templateName: string) {
    super(`Template not found: ${templateName}`);
    this.name = 'TemplateNotFoundError';
  }
}

/**
 * A swappable email template renderer.
 *
 * Implement this interface to connect any template engine (Handlebars, MJML, React Email, etc.)
 * to the Slingshot mail infrastructure. Registered via the mail plugin configuration.
 *
 * @example
 * ```ts
 * import type { MailRenderer, RenderResult } from '@lastshotlabs/slingshot-core';
 * import Handlebars from 'handlebars';
 *
 * export const handlebarsRenderer: MailRenderer = {
 *   name: 'handlebars',
 *   async render(template, data): Promise<RenderResult> {
 *     const html = Handlebars.compile(getTemplate(template))(data);
 *     return { html };
 *   },
 * };
 * ```
 */
export interface MailRenderer {
  /** Human-readable renderer name (used in error messages and debug logs). */
  name: string;
  /**
   * Render a template with the given data.
   * @param template - Template identifier (e.g. `'welcome'` or `'password-reset'`).
   * @param data - Template variables passed to the rendering engine.
   * @returns The rendered HTML, optional text, and optional subject.
   * @throws `TemplateNotFoundError` if the template does not exist in this renderer.
   *
   * @remarks
   * Implementations may also throw rendering-engine-specific errors (e.g., a Handlebars
   * compile error or a missing partial). Callers should catch both `TemplateNotFoundError`
   * and generic errors when resilience is required. The mail plugin wraps `render()` errors
   * in a structured log entry and re-throws — it does not swallow rendering failures.
   */
  render(template: string, data: Record<string, unknown>): Promise<RenderResult>;
  /**
   * Return all available template names, if the renderer supports discovery.
   * Used by admin tooling and health-checks.
   *
   * @remarks
   * This method is optional. Renderers that do not support discovery (e.g., dynamically
   * computed templates) may omit it. Callers should check for presence before invoking:
   * `if (renderer.listTemplates) { const names = await renderer.listTemplates(); }`.
   *
   * Safe to call at any time after the renderer is constructed — it does not depend on a
   * running server or an active request context.
   */
  listTemplates?(): Promise<string[]>;
}
