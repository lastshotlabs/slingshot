import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import type { MailRenderer } from '@lastshotlabs/slingshot-core';
import { createMailRouter } from '../../src/routes/mail';
import type { AdminEnv } from '../../src/types/env';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRenderer(
  templates: Record<string, { subject?: string; html: string; text?: string }>,
): MailRenderer {
  return {
    name: 'test-renderer',
    async render(template: string, data: Record<string, unknown>) {
      const tpl = templates[template];
      if (!tpl) throw new TemplateNotFoundError(template);
      const interpolate = (value: string) =>
        value.replace(/\{\{(\w+)\}\}/g, (_, key) => String(data[key] ?? ''));
      return {
        subject: tpl.subject ? interpolate(tpl.subject) : undefined,
        html: interpolate(tpl.html),
        text: tpl.text ? interpolate(tpl.text) : undefined,
      };
    },
    async listTemplates() {
      return Object.keys(templates);
    },
  };
}

function createApp(
  renderer: MailRenderer,
  options?: {
    allowMailRead?: boolean;
  },
) {
  const app = new Hono<AdminEnv>();
  app.use('*', async (c, next) => {
    c.set('adminPrincipal', {
      subject: 'admin-user',
      provider: 'memory',
    });
    await next();
  });
  app.route(
    '/',
    createMailRouter({
      renderer,
      evaluator: {
        can: async (_subject, action, resource) =>
          action === 'read' &&
          resource?.resourceType === 'admin:mail' &&
          (options?.allowMailRead ?? true),
      },
    }),
  );
  return app;
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(`http://localhost${path}`, init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMailRouter', () => {
  it('GET /mail/templates returns 200 with template list', async () => {
    const router = createApp(
      makeRenderer({
        welcome: { subject: 'Welcome', html: '<p>Welcome</p>' },
        password_reset: { subject: 'Reset', html: '<p>Reset</p>' },
      }),
    );

    const res = await router.fetch(makeRequest('GET', '/mail/templates'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: string[] };
    expect(body.templates).toContain('welcome');
    expect(body.templates).toContain('password_reset');
  });

  it('GET /mail/templates returns an empty list when renderer has no listTemplates()', async () => {
    const renderer: MailRenderer = {
      name: 'no-list',
      render: mock(async () => ({ html: '<p>x</p>' })),
    };

    const router = createApp(renderer);

    const res = await router.fetch(makeRequest('GET', '/mail/templates'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: string[] };
    expect(body.templates).toEqual([]);
  });

  it('POST /mail/templates/:name/preview returns 404 on unknown template', async () => {
    const router = createApp(makeRenderer({}));

    const res = await router.fetch(makeRequest('POST', '/mail/templates/nonexistent/preview', {}));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('POST /mail/templates/:name/preview returns 200 with rendered subject/html/text', async () => {
    const router = createApp(
      makeRenderer({
        welcome: { subject: 'Hello {{name}}', html: '<p>Hi {{name}}</p>', text: 'Hi {{name}}' },
      }),
    );

    const res = await router.fetch(
      makeRequest('POST', '/mail/templates/welcome/preview', { data: { name: 'Alice' } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subject: string | null;
      html: string;
      text: string | null;
    };
    expect(body.html).toContain('Alice');
    expect(body.subject).toContain('Alice');
    expect(body.text).toContain('Alice');
  });

  it('GET /mail/templates returns 403 without admin:mail read permission', async () => {
    const router = createApp(
      makeRenderer({
        welcome: { subject: 'Welcome', html: '<p>Welcome</p>' },
      }),
      { allowMailRead: false },
    );

    const res = await router.fetch(makeRequest('GET', '/mail/templates'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Forbidden');
  });

  it('POST /mail/templates/:name/preview returns 403 without admin:mail read permission', async () => {
    const router = createApp(
      makeRenderer({
        welcome: { subject: 'Hello {{name}}', html: '<p>Hi {{name}}</p>' },
      }),
      { allowMailRead: false },
    );

    const res = await router.fetch(
      makeRequest('POST', '/mail/templates/welcome/preview', { data: { name: 'Alice' } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Forbidden');
  });
});
