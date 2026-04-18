import { type ContextCarrier, resolveContext } from './context/contextAccess';
import type { EmailTemplate } from './coreContracts';

export type { EmailTemplate };

// ---------------------------------------------------------------------------
// EmailTemplateRegistry -- cross-plugin email template registration.
// ---------------------------------------------------------------------------

/**
 * Retrieve all email templates registered on a Slingshot app or context instance.
 *
 * Templates are registered by plugins during `setupPost` via `ctx.registrar.addEmailTemplates(...)`.
 * Returns a plain object snapshot of all registered templates keyed by template name.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @returns A plain object mapping template keys to `EmailTemplate` values.
 *
 * @remarks
 * The returned object is a snapshot — a new plain object is created from the internal
 * `ReadonlyMap` on every call. Mutating the returned object does not affect the
 * registered templates. If you need to check for a single template, prefer
 * `getEmailTemplate()` (which reads directly from the map without a full snapshot).
 *
 * @example
 * ```ts
 * import { getEmailTemplates, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const templates = getEmailTemplates(getContext(app));
 * const { subject, html } = templates['welcome'];
 * ```
 */
export function getEmailTemplates(input: ContextCarrier): Record<string, EmailTemplate> {
  return Object.fromEntries(resolveContext(input).emailTemplates);
}

/**
 * Retrieve a single email template by key from a Slingshot app or context instance.
 *
 * @param input - A `SlingshotContext` or a Hono app with an attached context.
 * @param key - The template key (e.g. `'welcome'`, `'password-reset'`).
 * @returns The `EmailTemplate`, or `null` if no template with this key is registered.
 *
 * @remarks
 * Returns `null` (not `undefined`) when the key is absent, for consistent null-checking.
 * A `null` result means the template was never registered — either the plugin that
 * provides it is not installed, or the key name is incorrect. Always guard with a
 * null-check before using the result.
 *
 * @example
 * ```ts
 * import { getEmailTemplate, getContext } from '@lastshotlabs/slingshot-core';
 *
 * const template = getEmailTemplate(getContext(app), 'welcome');
 * if (template) {
 *   await mailer.send({ to, subject: template.subject, html: template.html });
 * }
 * ```
 */
export function getEmailTemplate(input: ContextCarrier, key: string): EmailTemplate | null {
  return resolveContext(input).emailTemplates.get(key) ?? null;
}
