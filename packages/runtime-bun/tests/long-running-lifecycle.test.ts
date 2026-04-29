/**
 * Long-running lifecycle tests for runtime-bun.
 *
 * Exercises server durability under sustained load: sequential requests,
 * concurrent requests, multiple start/stop cycles, and varying body sizes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { bunRuntime } from '../src/index';

describe('runtime-bun long-running lifecycle', () => {
  let server: ReturnType<typeof bunRuntime>['server'] extends {
    listen: (opts: unknown) => infer R;
  }
    ? R
    : never;

  afterEach(async () => {
    if (server) {
      await server.stop(true).catch(() => {});
      // Reset the untyped server variable for the next test
      server = undefined as unknown as typeof server;
    }
  });

  test('100 sequential requests without errors', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        const n = new URL(req.url).searchParams.get('n') ?? '0';
        return new Response(`ok:${n}`, {
          headers: { 'x-request-n': n },
        });
      },
    });

    for (let i = 0; i < 100; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/?n=${i}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-n')).toBe(String(i));
      expect(await res.text()).toBe(`ok:${i}`);
    }
  });

  test('100 concurrent requests all complete successfully', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req: Request) => {
        const n = new URL(req.url).searchParams.get('n') ?? '0';
        return new Response(`concurrent:${n}`);
      },
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        fetch(`http://127.0.0.1:${server.port}/?n=${i}`).then(async res => ({
          status: res.status,
          text: await res.text(),
        })),
      ),
    );

    for (let i = 0; i < 100; i++) {
      expect(results[i].status).toBe(200);
      expect(results[i].text).toBe(`concurrent:${i}`);
    }
  });

  test('100 sequential requests with varying POST body sizes', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req: Request) => {
        if (req.method === 'POST') {
          const body = await req.text();
          return new Response(`received:${body.length}`, {
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new Response('ok');
      },
    });

    for (let size = 0; size <= 10000; size += 100) {
      const body = 'x'.repeat(size);
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`received:${size}`);
    }
  });

  test('start/stop cycle three times without resource leaks', async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const runtime = bunRuntime({ installProcessSafetyNet: false });
      const local = runtime.server.listen({
        port: 0,
        hostname: '127.0.0.1',
        fetch: () => new Response(`cycle:${cycle}`),
      });

      const res = await fetch(`http://127.0.0.1:${local.port}/`);
      expect(await res.text()).toBe(`cycle:${cycle}`);

      await local.stop(true);
    }
  });

  test('incrementing counter across 100 sequential requests', async () => {
    const counter = { value: 0 };
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        counter.value += 1;
        return new Response(String(counter.value));
      },
    });

    for (let i = 1; i <= 100; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(Number(await res.text())).toBe(i);
      // Small delay between requests every 10 iterations to simulate
      // real traffic patterns.
      if (i % 10 === 0) {
        await new Promise(r => setTimeout(r, 5));
      }
    }

    expect(counter.value).toBe(100);
  });

  test('server stays responsive after many rapid-fire requests', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('ok'),
    });

    // Fire 50 rapid requests without awaiting between sends.
    const promises = Array.from({ length: 50 }, (_, i) =>
      fetch(`http://127.0.0.1:${server.port}/?i=${i}`),
    );

    const responses = await Promise.all(promises);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    }
  });

  test('0-byte response body returns empty string', async () => {
    const runtime = bunRuntime({ installProcessSafetyNet: false });
    server = runtime.server.listen({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(''),
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});
