import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

describe('GET /', () => {
  test('returns 200 with app name running message', async () => {
    const app = await createTestApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: 'Test App is running' });
  });

  test('uses configured app name', async () => {
    const app = await createTestApp({ meta: { name: 'My API' } });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: 'My API is running' });
  });
});
