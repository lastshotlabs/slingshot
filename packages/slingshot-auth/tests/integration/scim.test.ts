import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createScimRouter } from '@lastshotlabs/slingshot-scim';
import type { AuthRuntimeContext } from '../../src/runtime';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCIM_BEARER = 'test-scim-bearer-token';

function buildApp(runtime: AuthRuntimeContext): Hono<AppEnv> {
  const app = wrapWithRuntime(runtime);
  const router = createScimRouter(runtime);
  app.route('/', router);
  return app;
}

async function deleteUser(app: Hono<AppEnv>, userId: string): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/scim/v2/Users/${userId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SCIM_BEARER}` },
    }),
  );
}

async function createUser(
  app: Hono<AppEnv>,
  body: Record<string, unknown>,
  bearerToken: string = SCIM_BEARER,
): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/scim/v2/Users', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Seed a user into the adapter and return the internal user ID. */
async function seedUser(runtime: AuthRuntimeContext, email: string): Promise<string> {
  const user = await runtime.adapter.create(email, null as unknown as string);
  return user.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SCIM deprovisioning modes', () => {
  let runtime: AuthRuntimeContext;

  beforeEach(() => {
    runtime = makeTestRuntime({
      scim: { bearerTokens: SCIM_BEARER, onDeprovision: 'suspend' },
    });
  });

  test('onDeprovision="suspend" suspends the user and returns 204', async () => {
    const userId = await seedUser(runtime, 'alice@example.com');
    const setSuspended = mock(runtime.adapter.setSuspended!.bind(runtime.adapter));
    runtime = {
      ...runtime,
      adapter: { ...runtime.adapter, setSuspended },
      config: { ...runtime.config, scim: { bearerTokens: SCIM_BEARER, onDeprovision: 'suspend' } },
    };

    const app = buildApp(runtime);
    const res = await deleteUser(app, userId);

    expect(res.status).toBe(204);
    expect(setSuspended).toHaveBeenCalledWith(userId, true, 'SCIM deprovisioned');
  });

  test('onDeprovision="delete" deletes the user and revokes sessions, returns 204', async () => {
    const userId = await seedUser(runtime, 'bob@example.com');
    // Create a session for the user so we can verify it gets revoked
    await runtime.repos.session.createSession(userId, 'tok-1', 'sess-1', {}, runtime.config);

    const deleteFn = mock(runtime.adapter.deleteUser!.bind(runtime.adapter));
    runtime = {
      ...runtime,
      adapter: { ...runtime.adapter, deleteUser: deleteFn },
      config: { ...runtime.config, scim: { bearerTokens: SCIM_BEARER, onDeprovision: 'delete' } },
    };

    const app = buildApp(runtime);
    const res = await deleteUser(app, userId);

    expect(res.status).toBe(204);
    expect(deleteFn).toHaveBeenCalledWith(userId);

    // All sessions should have been revoked (token nulled = tombstoned, or removed)
    const sessions = await runtime.repos.session.getUserSessions(userId, runtime.config);
    const activeSessions = sessions.filter(s => s.isActive);
    expect(activeSessions).toHaveLength(0);
  });

  test('onDeprovision=custom function — custom handler is called with the userId, returns 204', async () => {
    const userId = await seedUser(runtime, 'carol@example.com');
    const customFn = mock(async () => {});
    runtime = {
      ...runtime,
      config: {
        ...runtime.config,
        scim: { bearerTokens: SCIM_BEARER, onDeprovision: customFn },
      },
    };

    const app = buildApp(runtime);
    const res = await deleteUser(app, userId);

    expect(res.status).toBe(204);
    expect(customFn).toHaveBeenCalledWith(userId);
  });
  test('POST /scim/v2/Users with active=false suspends the provisioned user', async () => {
    const setSuspended = mock(runtime.adapter.setSuspended!.bind(runtime.adapter));
    runtime = {
      ...runtime,
      adapter: { ...runtime.adapter, setSuspended },
    };

    const app = buildApp(runtime);
    const res = await createUser(app, {
      userName: 'suspended@example.com',
      active: false,
      displayName: 'Suspended User',
    });

    expect(res.status).toBe(201);
    expect(setSuspended).toHaveBeenCalledTimes(1);
    expect(setSuspended.mock.calls[0]?.[1]).toBe(true);
  });

  test('POST /scim/v2/Users with active=false returns 501 when suspension is unsupported', async () => {
    runtime = {
      ...runtime,
      adapter: { ...runtime.adapter, setSuspended: undefined },
    };

    const app = buildApp(runtime);
    const res = await createUser(app, {
      userName: 'unsupported@example.com',
      active: false,
    });

    expect(res.status).toBe(501);
  });
});
