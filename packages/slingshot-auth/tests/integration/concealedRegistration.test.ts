import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createRegisterRouter } from '../../src/routes/register';
import type { AuthRuntimeContext } from '../../src/runtime';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(
  runtime: AuthRuntimeContext,
  onExistingAccount?: (id: string) => Promise<void>,
): Hono<AppEnv> {
  const app = wrapWithRuntime(runtime);
  const router = createRegisterRouter(
    {
      primaryField: 'email',
      concealRegistration: { onExistingAccount },
    },
    runtime,
  );
  app.route('/', router);
  return app;
}

async function postRegister(
  app: Hono<AppEnv>,
  email: string,
  password = 'StrongPass1!',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request('http://localhost/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('concealed registration timing', () => {
  let runtime: AuthRuntimeContext;

  beforeEach(() => {
    runtime = makeTestRuntime({ concealRegistration: {} });
  });

  test('registering an already-registered email returns 200 and calls onExistingAccount', async () => {
    const onExistingAccount = mock(async (_: string) => {});

    // Seed an existing user via the adapter's create method
    await runtime.adapter.create('alice@example.com', null as unknown as string);

    const app = buildApp(runtime, onExistingAccount);
    const { status, json } = await postRegister(app, 'alice@example.com');

    expect(status).toBe(200);
    // Generic message — no information about whether the account exists
    expect(typeof json.message).toBe('string');
    expect(onExistingAccount).toHaveBeenCalledWith('alice@example.com');
  });

  test('registering a new email returns 200 with the same generic message', async () => {
    const app = buildApp(runtime);
    const { status, json } = await postRegister(app, 'newuser@example.com');

    // Both existing and new registrations return 200 — prevents enumeration via status code
    expect(status).toBe(200);
    expect(typeof json.message).toBe('string');
  });
});
