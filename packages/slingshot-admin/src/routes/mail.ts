import type { Context } from 'hono';
import { z } from 'zod';
import { TemplateNotFoundError, createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import type { MailRenderer, PermissionEvaluator } from '@lastshotlabs/slingshot-core';
import { createTypedRouter, registerRoute } from '../lib/typedRoute';
import type { AdminEnv } from '../types/env';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ErrorResponse = z.object({ error: z.string() });

const MailTemplateListResponse = z
  .object({
    templates: z.array(z.string()),
  })
  .openapi('MailTemplateListResponse');

const MailTemplatePreviewBody = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
});

const MailTemplatePreviewResponse = z
  .object({
    subject: z.string().nullable(),
    html: z.string(),
    text: z.string().nullable(),
  })
  .openapi('MailTemplatePreviewResponse');

const tags = ['Admin'];

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface MailRouterConfig {
  renderer: MailRenderer;
  evaluator: PermissionEvaluator;
}

async function checkMailPermission(
  c: Context<AdminEnv>,
  evaluator: PermissionEvaluator,
): Promise<boolean> {
  const principal = c.get('adminPrincipal');
  return evaluator.can({ subjectId: principal.subject, subjectType: 'user' }, 'read', {
    tenantId: principal.tenantId,
    resourceType: 'admin:mail',
  });
}

/**
 * Creates the admin mail router.
 *
 * Mounts template enumeration and preview routes that are protected by the
 * parent admin auth guard and require `read` permission on `admin:mail`.
 *
 * @param config.renderer - Mail renderer used to list and render templates.
 * @param config.evaluator - Permission evaluator used to authorize mail access.
 * @returns A typed admin mail router mounted under the admin path.
 */
export function createMailRouter(config: MailRouterConfig) {
  const { renderer, evaluator } = config;
  const router = createTypedRouter();

  // -------------------------------------------------------------------------
  // GET /mail/templates - list available templates
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'get',
      path: '/mail/templates',
      summary: 'List mail templates',
      description: 'Returns the list of available mail templates from the configured renderer.',
      tags,
      responses: {
        200: {
          content: { 'application/json': { schema: MailTemplateListResponse } },
          description: 'List of template names.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      if (!(await checkMailPermission(c, evaluator))) {
        return errorResponse(c, 'Forbidden', 403);
      }
      const templates = renderer.listTemplates ? await renderer.listTemplates() : [];
      return c.json({ templates });
    },
  );

  // -------------------------------------------------------------------------
  // POST /mail/templates/:name/preview - render a template with data
  // -------------------------------------------------------------------------
  registerRoute(
    router,
    createRoute({
      method: 'post',
      path: '/mail/templates/:name/preview',
      summary: 'Preview a mail template',
      description:
        'Renders a mail template with the supplied data and returns subject, html, and text.',
      tags,
      request: {
        params: z.object({ name: z.string() }),
        body: {
          content: { 'application/json': { schema: MailTemplatePreviewBody } },
          required: false,
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: MailTemplatePreviewResponse } },
          description: 'Rendered template.',
        },
        401: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Unauthorized.',
        },
        403: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Forbidden.',
        },
        404: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Template not found.',
        },
      },
    }),
    async (c: Context<AdminEnv>) => {
      if (!(await checkMailPermission(c, evaluator))) {
        return errorResponse(c, 'Forbidden', 403);
      }

      const name = c.req.param('name') ?? '';
      let data: Record<string, unknown> = {};
      try {
        const body = (await c.req.json().catch(() => ({}))) as z.infer<
          typeof MailTemplatePreviewBody
        >;
        data = body.data ?? {};
      } catch {
        // body is optional
      }

      try {
        const result = await renderer.render(name, data);
        return c.json({
          subject: result.subject ?? null,
          html: result.html,
          text: result.text ?? null,
        });
      } catch (err) {
        if (err instanceof TemplateNotFoundError) {
          return errorResponse(c, 'Template not found', 404);
        }
        throw err;
      }
    },
  );

  return router;
}
