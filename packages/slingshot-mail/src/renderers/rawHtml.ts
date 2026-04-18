import type { MailRenderer, RenderResult } from '@lastshotlabs/slingshot-core';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';

/**
 * A static HTML template with optional `{{variable}}` interpolation placeholders.
 *
 * Variable syntax: `{{key}}` - all values are coerced to strings safely.
 * Missing keys render as empty strings rather than throwing.
 */
export interface RawHtmlTemplate {
  /** Email subject with optional `{{key}}` placeholders. Overrides `MailSubscription.subject`. */
  subject?: string;
  /** HTML body with optional `{{key}}` placeholders. */
  html: string;
  /** Plain-text fallback body with optional `{{key}}` placeholders. */
  text?: string;
}

interface RawHtmlRendererConfig {
  templates: Record<string, RawHtmlTemplate>;
}

function resolveSync<T>(operation: () => T): Promise<T> {
  return Promise.resolve().then(operation);
}

function interpolate(str: string, data: Record<string, unknown>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = data[key as string];
    if (value == null) return '';
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      value instanceof Date
    ) {
      return String(value);
    }
    if (typeof value === 'symbol' || typeof value === 'function') {
      return '';
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  });
}

/**
 * Creates a `MailRenderer` that interpolates simple `{{variable}}` placeholders into
 * static HTML string templates.
 *
 * No templating engine or build step required - templates are plain strings defined inline
 * in code. For rich component-based templates, use `createReactEmailRenderer` instead.
 *
 * @param config - A record of template name -> `RawHtmlTemplate`.
 * @returns A `MailRenderer` instance ready to pass to `createMailPlugin`.
 * @throws {TemplateNotFoundError} From `render()` when the requested template name is not
 *   in `config.templates` (non-retryable - dead-lettered immediately by the queue).
 *
 * @example
 * ```ts
 * import { createRawHtmlRenderer } from '@lastshotlabs/slingshot-mail';
 *
 * const renderer = createRawHtmlRenderer({
 *   templates: {
 *     'welcome': {
 *       subject: 'Welcome, {{name}}!',
 *       html: '<p>Hello <strong>{{name}}</strong>, thanks for joining!</p>',
 *       text: 'Hello {{name}}, thanks for joining!',
 *     },
 *   },
 * });
 * ```
 */
export function createRawHtmlRenderer(config: RawHtmlRendererConfig): MailRenderer {
  return {
    name: 'raw-html',
    render(template: string, data: Record<string, unknown>): Promise<RenderResult> {
      return resolveSync(() => {
        const tpl = Object.hasOwn(config.templates, template)
          ? config.templates[template]
          : undefined;
        if (tpl === undefined) throw new TemplateNotFoundError(template);
        return {
          subject: tpl.subject !== undefined ? interpolate(tpl.subject, data) : undefined,
          html: interpolate(tpl.html, data),
          text: tpl.text !== undefined ? interpolate(tpl.text, data) : undefined,
        };
      });
    },
    listTemplates(): Promise<string[]> {
      return Promise.resolve(Object.keys(config.templates));
    },
  };
}
