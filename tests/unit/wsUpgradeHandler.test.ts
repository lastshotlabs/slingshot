import { afterEach, describe, expect, it, mock } from 'bun:test';
import { getClientIpFromRequest } from '@lastshotlabs/slingshot-core';

const resolveUserIdMock = mock(async () => null as string | null);

async function loadCreateWsUpgradeHandler() {
  mock.module('@framework/lib/resolveUserId', () => ({
    resolveUserId: resolveUserIdMock,
  }));

  const mod = await import(`../../src/framework/ws/index.ts?ws-upgrade=${Date.now()}`);
  return mod.createWsUpgradeHandler;
}

function createMockServer(overrides?: {
  requestIP?: (req: Request) => { address: string } | null;
  upgrade?: (req: Request, opts: unknown) => boolean;
}) {
  return {
    requestIP: overrides?.requestIP ?? (() => ({ address: '127.0.0.1' })),
    upgrade: overrides?.upgrade ?? (() => true),
  } as any;
}

afterEach(() => {
  mock.restore();
  resolveUserIdMock.mockReset();
});

describe('createWsUpgradeHandler', () => {
  it('returns undefined on successful upgrade', async () => {
    resolveUserIdMock.mockImplementation(async () => null);
    const createWsUpgradeHandler = await loadCreateWsUpgradeHandler();
    const server = createMockServer();
    const handler = createWsUpgradeHandler(server, '/chat');
    const req = new Request('http://localhost/chat');

    const result = await handler(req);
    expect(result).toBeUndefined();
    expect(getClientIpFromRequest(req, false)).toBe('127.0.0.1');
  });

  it('returns 400 response when upgrade fails', async () => {
    resolveUserIdMock.mockImplementation(async () => null);
    const createWsUpgradeHandler = await loadCreateWsUpgradeHandler();
    const server = createMockServer({
      upgrade: () => false,
    });
    const handler = createWsUpgradeHandler(server, '/chat');
    const req = new Request('http://localhost/chat');

    const result = await handler(req);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(400);
    const body = await result!.json();
    expect(body).toEqual({ error: 'Upgrade failed' });
  });

  it('catches requestIP throwing without affecting upgrade', async () => {
    resolveUserIdMock.mockImplementation(async () => null);
    const createWsUpgradeHandler = await loadCreateWsUpgradeHandler();
    const server = createMockServer({
      requestIP: () => {
        throw new Error('requestIP not supported');
      },
    });
    const handler = createWsUpgradeHandler(server, '/ws');
    const req = new Request('http://localhost/ws');

    const result = await handler(req);
    expect(result).toBeUndefined();
    expect(getClientIpFromRequest(req, false)).toBe('unknown');
  });

  it('resolves userId via the default resolver', async () => {
    resolveUserIdMock.mockImplementation(async () => 'user-42');
    const createWsUpgradeHandler = await loadCreateWsUpgradeHandler();
    let capturedData: any = null;
    const server = createMockServer({
      upgrade: (_req: Request, opts: any) => {
        capturedData = opts?.data;
        return true;
      },
    });
    const handler = createWsUpgradeHandler(server, '/chat');
    const req = new Request('http://localhost/chat');

    await handler(req);

    expect(capturedData).toBeDefined();
    expect(capturedData.userId).toBe('user-42');
    expect(capturedData.endpoint).toBe('/chat');
    expect(capturedData.rooms).toBeInstanceOf(Set);
    expect(typeof capturedData.id).toBe('string');
  });

  it('passes custom userResolver to resolveUserId', async () => {
    let receivedResolver: unknown = null;
    resolveUserIdMock.mockImplementation(async (_req, resolver) => {
      receivedResolver = resolver;
      return 'custom-user';
    });
    const createWsUpgradeHandler = await loadCreateWsUpgradeHandler();
    const customResolver = { resolveUserId: async () => 'custom-user' };
    const server = createMockServer();
    const handler = createWsUpgradeHandler(server, '/ws', customResolver as any);
    const req = new Request('http://localhost/ws');

    await handler(req);
    expect(receivedResolver).toBe(customResolver);
  });

  it('passes null to resolveUserId when userResolver is null', async () => {
    let receivedResolver: unknown = 'sentinel';
    resolveUserIdMock.mockImplementation(async (_req, resolver) => {
      receivedResolver = resolver;
      return null;
    });
    const createWsUpgradeHandler = await loadCreateWsUpgradeHandler();
    const server = createMockServer();
    const handler = createWsUpgradeHandler(server, '/ws', null);
    const req = new Request('http://localhost/ws');

    await handler(req);
    expect(receivedResolver).toBeNull();
  });

  it('does not attach a client IP when requestIP returns null', async () => {
    resolveUserIdMock.mockImplementation(async () => null);
    const createWsUpgradeHandler = await loadCreateWsUpgradeHandler();
    const server = createMockServer({
      requestIP: () => null,
    });
    const handler = createWsUpgradeHandler(server, '/ws');
    const req = new Request('http://localhost/ws');

    await handler(req);
    expect(getClientIpFromRequest(req, false)).toBe('unknown');
  });
});
