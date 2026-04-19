import path from 'node:path';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { clearActionCache } from '../../../src/actions/registry';
import { ActionRedirect, buildActionRouter } from '../../../src/actions/routes';
import type { ActionIsrInvalidators } from '../../../src/actions/routes';

const SERVER_ACTIONS_DIR = path.resolve(import.meta.dir, '__fixtures__/actions');

function makeApp(trustedOrigins: readonly string[] = [], isrInvalidators?: ActionIsrInvalidators) {
  const app = new Hono();
  const router = buildActionRouter({
    trustedOrigins,
    serverActionsDir: SERVER_ACTIONS_DIR,
    isrInvalidators,
  });
  app.route('/_snapshot', router);
  return app;
}

beforeEach(() => clearActionCache());
afterEach(() => clearActionCache());

describe('POST /_snapshot/action - CSRF origin check', () => {
  test('rejects cross-origin requests with 403', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ module: 'posts', action: 'createPost', args: [] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Forbidden');
  });

  test('allows same-origin requests when Origin is absent', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'nonexistent', action: 'noop', args: [] }),
    });
    expect(res.status).not.toBe(403);
  });

  test('allows requests from trusted origins', async () => {
    const app = makeApp(['https://trusted.example.com']);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: {
        origin: 'https://trusted.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ module: 'nonexistent', action: 'noop', args: [] }),
    });
    expect(res.status).not.toBe(403);
  });

  test('rejects malformed Origin header with 403', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: {
        origin: 'not-a-url',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ module: 'posts', action: 'createPost', args: [] }),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /_snapshot/action - request validation', () => {
  test('returns 400 for invalid JSON body', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {{{',
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when module field is missing', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'createPost', args: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when action field is missing', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'posts', args: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 when args is not an array', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'posts', action: 'createPost', args: 'not-array' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 for path traversal in module name', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: '../../etc/passwd', action: 'read', args: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /_snapshot/action - redirect safety', () => {
  test('form success redirect sanitizes external referers to root', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://evil.example.com/phish',
      },
      body: new URLSearchParams({
        _module: 'navigation',
        _action: 'ok',
      }).toString(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  test('ActionRedirect responses collapse external destinations to root', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        module: 'navigation',
        action: 'externalRedirect',
        args: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect: string };
    expect(body.redirect).toBe('/');
  });

  test('production error responses do not leak internal action messages', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = makeApp([]);
      const res = await app.request('/_snapshot/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          module: 'navigation',
          action: 'fail',
          args: [],
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Action failed');
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });
});

describe('POST /_snapshot/action - module resolution', () => {
  test('returns 404 when module does not exist', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'nonexistent', action: 'noop', args: [] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('nonexistent');
  });

  test('returns 404 when action is not exported by the module', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'nonexistent', action: 'missingFn', args: [] }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /_snapshot/action - ISR invalidation context', () => {
  test('returns 500 when an action calls revalidatePath without ISR configured', async () => {
    const app = makeApp([]);
    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'revalidate', action: 'touchPath', args: ['/posts'] }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('revalidatePath() called outside of a server action context');
  });

  test('delegates revalidateTag to the configured ISR invalidators', async () => {
    const revalidatePath = mock(async () => undefined);
    const revalidateTag = mock(async () => undefined);
    const app = makeApp([], { revalidatePath, revalidateTag });

    const res = await app.request('/_snapshot/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'revalidate', action: 'touchTag', args: ['posts'] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean } };
    expect(body.result.ok).toBe(true);
    expect(revalidateTag).toHaveBeenCalledWith('posts');
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('ActionRedirect', () => {
  test('is constructed with a destination', () => {
    const redir = new ActionRedirect('/dashboard');
    expect(redir.destination).toBe('/dashboard');
    expect(redir.name).toBe('ActionRedirect');
    expect(redir instanceof Error).toBe(true);
  });
});
