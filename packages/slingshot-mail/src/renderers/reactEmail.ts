import type { MailRenderer, RenderResult } from '@lastshotlabs/slingshot-core';
import { TemplateNotFoundError, createConsoleLogger } from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';

const logger: Logger = createConsoleLogger({ base: { component: 'slingshot-mail' } });

// Minimal structural type for a React element. Avoids importing React directly
// since @react-email/render is an optional peer dependency.
type ReactElement = {
  type: string | object | symbol;
  props: Record<string, unknown>;
  key: string | null;
};

type ComponentType = (props: Record<string, unknown>) => ReactElement;

interface ReactEmailRendererConfig {
  templates: Record<string, ComponentType>;
  subjects?: Record<string, string>;
}

/**
 * Creates a `MailRenderer` backed by [@react-email/render](https://react.email).
 *
 * Components are plain React functional components that receive the `dataMapper` output as
 * props. `@react-email/render` is loaded lazily on first render - install it as a peer
 * dependency. Plain-text extraction is attempted via `render(..., { plainText: true })`;
 * if it fails the text body is omitted with a warning.
 *
 * @param config - A record of template name -> React component (plus optional subject map).
 * @returns A `MailRenderer` instance ready to pass to `createMailPlugin`.
 * @throws {TemplateNotFoundError} From `render()` when the requested template name is not in
 *   `config.templates` (non-retryable).
 * @throws {Error} If `@react-email/render` is not installed (thrown on first `render()` call).
 *
 * @remarks
 * Components must be synchronous. Async server components are not supported by
 * `@react-email/render`.
 *
 * @example
 * ```ts
 * import { createReactEmailRenderer } from '@lastshotlabs/slingshot-mail';
 * import { WelcomeEmail } from './emails/WelcomeEmail';
 *
 * const renderer = createReactEmailRenderer({
 *   templates: { welcome: WelcomeEmail },
 *   subjects: { welcome: 'Welcome to our platform!' },
 * });
 * ```
 */
export function createReactEmailRenderer(config: ReactEmailRendererConfig): MailRenderer {
  return {
    name: 'react-email',
    async render(template: string, data: Record<string, unknown>): Promise<RenderResult> {
      const Component = Object.hasOwn(config.templates, template)
        ? config.templates[template]
        : undefined;
      if (Component === undefined) throw new TemplateNotFoundError(template);

      let renderFn: (component: ReactElement, opts?: { plainText?: boolean }) => Promise<string>;
      try {
        const mod = await import('@react-email/render');
        renderFn = mod.render as typeof renderFn;
      } catch {
        throw new Error('react-email renderer requires @react-email/render to be installed');
      }

      const element = Component(data);
      const html = await renderFn(element);
      const text = await renderFn(element, { plainText: true }).catch((err: unknown) => {
        logger.warn(
          `[slingshot-mail] react-email: plain-text render failed for template "${template}"`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        return undefined;
      });
      const subject = config.subjects?.[template];

      return { subject, html, text };
    },
    listTemplates(): Promise<string[]> {
      return Promise.resolve(Object.keys(config.templates));
    },
  };
}
