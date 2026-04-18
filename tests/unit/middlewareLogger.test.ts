import { describe, expect, mock, test } from 'bun:test';
import { logger } from '../../src/framework/middleware/logger';

describe('logger middleware', () => {
  test('calls next and returns response', async () => {
    const req = new Request('http://localhost/test');
    const handler = () => new Response('ok', { status: 200 });

    // Suppress console.log output
    const origLog = console.log;
    console.log = mock(() => {});

    const res = await logger(req, handler);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    console.log = origLog;
  });

  test('logs method, path, status, and timing', async () => {
    const req = new Request('http://localhost/hello');
    const handler = () => new Response('world', { status: 201 });

    const logged: string[] = [];
    const origLog = console.log;
    console.log = mock((...args: unknown[]) => {
      logged.push(String(args[0]));
    });

    await logger(req, handler);

    expect(logged.length).toBe(1);
    expect(logged[0]).toMatch(/GET \/hello 201 \d+\.\d+ms/);

    console.log = origLog;
  });
});
