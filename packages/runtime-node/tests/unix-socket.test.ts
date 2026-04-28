import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { nodeRuntime } from '../src/index';

// Verifies that RuntimeServerOptions.unix binds the HTTP server on a Unix
// domain socket and serves responses on it.
//
// We use node:http's `request({ socketPath })` rather than undici (not a repo
// dep) — both speak HTTP/1.1 over the same kernel transport, so the assertion
// surface is identical.

interface SocketRequestOptions {
  readonly socketPath: string;
  readonly path: string;
}

function fetchOverUnixSocket({
  socketPath,
  path,
}: SocketRequestOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('runtime-node unix socket', () => {
  test('listens on a unix domain socket and serves responses', async () => {
    const runtime = nodeRuntime();
    const socketPath = join(tmpdir(), `slingshot-runtime-node-${Date.now()}.sock`);

    // Best-effort cleanup in case a stale socket exists from a previous run.
    const { unlink } = await import('node:fs/promises');
    await unlink(socketPath).catch(() => {});

    const server = await runtime.server.listen({
      unix: socketPath,
      fetch: () => new Response('unix-ok'),
    });

    try {
      const { status, body } = await fetchOverUnixSocket({
        socketPath,
        path: '/hello',
      });
      expect(status).toBe(200);
      expect(body).toBe('unix-ok');
    } finally {
      await server.stop(true);
      await unlink(socketPath).catch(() => {});
    }
  });

  test('throws when both unix and port are supplied', async () => {
    const runtime = nodeRuntime();
    await expect(
      runtime.server.listen({
        unix: join(tmpdir(), 'slingshot-should-never-bind.sock'),
        port: 0,
        fetch: () => new Response('should-not-listen'),
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});
