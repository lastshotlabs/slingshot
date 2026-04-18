import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

describe('requestId middleware', () => {
  beforeEach(() => {});

  test('generates UUID when no X-Request-Id header provided', async () => {
    const app = await createTestApp();
    const res = await app.request('/health');
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    // UUID v4 format
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('ignores client-supplied X-Request-Id and generates a server-side UUID', async () => {
    const app = await createTestApp();
    const customId = 'my-custom-request-id-123';
    const res = await app.request('/health', {
      headers: { 'x-request-id': customId },
    });
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe(customId);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('requestId is accessible in route handlers via context', async () => {
    const app = await createTestApp();
    // The error handler includes requestId in JSON responses
    // Hit a non-existent route to get the 404 response which includes requestId
    const res = await app.request('/nonexistent-path-for-test');
    const body = await res.json();
    expect(body.requestId).toBeTruthy();
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-/);
  });

  test('X-Request-Id header is present on every response', async () => {
    const app = await createTestApp();
    const res = await app.request('/');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
