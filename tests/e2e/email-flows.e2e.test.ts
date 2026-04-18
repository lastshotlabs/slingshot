/**
 * E2E tests for email verification and password reset flows.
 *
 * Token capture uses the auth event bus (same pattern as integration tests) —
 * the memory adapter emits `auth:delivery.email_verification` and
 * `auth:delivery.password_reset` events that carry the token.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';

// ---------------------------------------------------------------------------
// Email verification suite — requires emailVerification.required: true
// ---------------------------------------------------------------------------

let verifyHandle: E2EServerHandle;

beforeAll(async () => {
  verifyHandle = await createTestHttpServer(
    {},
    {
      auth: {
        emailVerification: { required: true },
        passwordReset: {},
      },
    },
  );
});

afterAll(() => verifyHandle.stop());
const post = (
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Token capture helpers
// ---------------------------------------------------------------------------

function captureEmailVerificationToken(handle: E2EServerHandle = verifyHandle): {
  promise: Promise<string>;
  cleanup: () => void;
} {
  let resolve: (token: string) => void;
  const promise = new Promise<string>(r => {
    resolve = r;
  });
  const handler = (payload: { token: string }) => {
    resolve(payload.token);
  };
  handle.bus.on('auth:delivery.email_verification', handler);
  return { promise, cleanup: () => handle.bus.off('auth:delivery.email_verification', handler) };
}

function capturePasswordResetToken(handle: E2EServerHandle): {
  promise: Promise<string>;
  cleanup: () => void;
} {
  let resolve: (token: string) => void;
  const promise = new Promise<string>(r => {
    resolve = r;
  });
  const handler = (payload: { token: string }) => {
    resolve(payload.token);
  };
  handle.bus.on('auth:delivery.password_reset', handler);
  return { promise, cleanup: () => handle.bus.off('auth:delivery.password_reset', handler) };
}

// ---------------------------------------------------------------------------
// Email Verification
// ---------------------------------------------------------------------------

describe('email verification — E2E', () => {
  test('register emits verification token via event bus', async () => {
    const { promise, cleanup } = captureEmailVerificationToken();

    const res = await post(verifyHandle.baseUrl, '/auth/register', {
      email: 'ev-token@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(201);

    const token = await promise;
    cleanup();
    expect(token).toBeString();
    expect(token.length).toBeGreaterThan(0);
  });

  test('login blocked when email not verified', async () => {
    const { promise, cleanup } = captureEmailVerificationToken();

    await post(verifyHandle.baseUrl, '/auth/register', {
      email: 'ev-blocked@example.com',
      password: 'Password123!',
    });
    await promise;
    cleanup();

    const loginRes = await post(verifyHandle.baseUrl, '/auth/login', {
      email: 'ev-blocked@example.com',
      password: 'Password123!',
    });
    expect(loginRes.status).toBe(403);
  });

  test('verify-email confirms token and allows login', async () => {
    const { promise, cleanup } = captureEmailVerificationToken();

    await post(verifyHandle.baseUrl, '/auth/register', {
      email: 'ev-confirm@example.com',
      password: 'Password123!',
    });
    const token = await promise;
    cleanup();

    const verifyRes = await post(verifyHandle.baseUrl, '/auth/verify-email', { token });
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.ok).toBe(true);

    // Should now be able to log in
    const loginRes = await post(verifyHandle.baseUrl, '/auth/login', {
      email: 'ev-confirm@example.com',
      password: 'Password123!',
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.token).toBeString();
  });

  test('verify-email with invalid token returns 4xx', async () => {
    const res = await post(verifyHandle.baseUrl, '/auth/verify-email', {
      token: 'not-a-real-verification-token',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('resend-verification sends a new token', async () => {
    let firstToken: string | undefined;
    let secondToken: string | undefined;

    const handler1 = (p: { token: string }) => {
      firstToken = p.token;
    };
    verifyHandle.bus.on('auth:delivery.email_verification', handler1);

    await post(verifyHandle.baseUrl, '/auth/register', {
      email: 'ev-resend@example.com',
      password: 'Password123!',
    });
    verifyHandle.bus.off('auth:delivery.email_verification', handler1);

    const handler2 = (p: { token: string }) => {
      secondToken = p.token;
    };
    verifyHandle.bus.on('auth:delivery.email_verification', handler2);
    const resendRes = await post(verifyHandle.baseUrl, '/auth/resend-verification', {
      email: 'ev-resend@example.com',
      password: 'Password123!',
    });
    // Give fire-and-forget a tick
    await Bun.sleep(50);
    verifyHandle.bus.off('auth:delivery.email_verification', handler2);

    expect(resendRes.status).toBe(200);
    expect(secondToken).toBeString();
    expect(secondToken).not.toBe(firstToken);
  });
});

// ---------------------------------------------------------------------------
// Password Reset
// ---------------------------------------------------------------------------

describe('password reset — E2E', () => {
  test('forgot-password returns 200 for registered email and emits token', async () => {
    // Register with no verification required for this sub-flow
    const resetHandle = await createTestHttpServer(
      {},
      {
        auth: {
          passwordReset: {},
        },
      },
    );

    try {
      await post(resetHandle.baseUrl, '/auth/register', {
        email: 'pr-basic@example.com',
        password: 'Password123!',
      });

      const { promise, cleanup } = capturePasswordResetToken(resetHandle);

      const forgotRes = await post(resetHandle.baseUrl, '/auth/forgot-password', {
        email: 'pr-basic@example.com',
      });
      expect(forgotRes.status).toBe(200);

      const token = await promise;
      cleanup();
      expect(token).toBeString();
    } finally {
      resetHandle.stop();
    }
  });

  test('forgot-password returns 200 for non-existent email (enumeration prevention)', async () => {
    const resetHandle = await createTestHttpServer(
      {},
      {
        auth: {
          passwordReset: {},
        },
      },
    );

    try {
      const res = await post(resetHandle.baseUrl, '/auth/forgot-password', {
        email: 'nobody@example.com',
      });
      expect(res.status).toBe(200);
    } finally {
      resetHandle.stop();
    }
  });

  test('full reset flow: forgot-password → reset → login with new password', async () => {
    const resetHandle = await createTestHttpServer(
      {},
      {
        auth: {
          passwordReset: {},
        },
      },
    );

    try {
      await post(resetHandle.baseUrl, '/auth/register', {
        email: 'pr-flow@example.com',
        password: 'OldPassword123!',
      });

      const { promise, cleanup } = capturePasswordResetToken(resetHandle);
      await post(resetHandle.baseUrl, '/auth/forgot-password', {
        email: 'pr-flow@example.com',
      });
      const token = await promise;
      cleanup();

      const resetRes = await post(resetHandle.baseUrl, '/auth/reset-password', {
        token,
        password: 'NewPassword456!',
      });
      expect(resetRes.status).toBe(200);

      // Old password rejected
      const oldLoginRes = await post(resetHandle.baseUrl, '/auth/login', {
        email: 'pr-flow@example.com',
        password: 'OldPassword123!',
      });
      expect(oldLoginRes.status).toBe(401);

      // New password accepted
      const newLoginRes = await post(resetHandle.baseUrl, '/auth/login', {
        email: 'pr-flow@example.com',
        password: 'NewPassword456!',
      });
      expect(newLoginRes.status).toBe(200);
      const loginBody = await newLoginRes.json();
      expect(loginBody.token).toBeString();
    } finally {
      resetHandle.stop();
    }
  });

  test('reset token is single-use — second use returns 4xx', async () => {
    const resetHandle = await createTestHttpServer(
      {},
      {
        auth: {
          passwordReset: {},
        },
      },
    );

    try {
      await post(resetHandle.baseUrl, '/auth/register', {
        email: 'pr-single@example.com',
        password: 'Password123!',
      });

      const { promise, cleanup } = capturePasswordResetToken(resetHandle);
      await post(resetHandle.baseUrl, '/auth/forgot-password', {
        email: 'pr-single@example.com',
      });
      const token = await promise;
      cleanup();

      // First use succeeds
      const firstRes = await post(resetHandle.baseUrl, '/auth/reset-password', {
        token,
        password: 'NewPassword456!',
      });
      expect(firstRes.status).toBe(200);

      // Second use fails
      const secondRes = await post(resetHandle.baseUrl, '/auth/reset-password', {
        token,
        password: 'AnotherPassword789!',
      });
      expect(secondRes.status).toBe(400);
    } finally {
      resetHandle.stop();
    }
  });

  test('reset with invalid token returns 4xx', async () => {
    const resetHandle = await createTestHttpServer(
      {},
      {
        auth: {
          passwordReset: {},
        },
      },
    );

    try {
      const res = await post(resetHandle.baseUrl, '/auth/reset-password', {
        token: 'not-a-real-reset-token',
        password: 'NewPassword456!',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } finally {
      resetHandle.stop();
    }
  });
});
