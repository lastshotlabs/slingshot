import { describe, expect, it } from 'bun:test';
import { ANONYMOUS_ACTOR, type Actor, getClientIpFromRequest } from '@lastshotlabs/slingshot-core';
import { createWsUpgradeHandler, handleFirstMessageAuth } from '../../src/framework/ws/index';

function createMockServer(overrides?: {
  requestIP?: (req: Request) => { address: string } | null;
  upgrade?: (req: Request, opts: unknown) => boolean;
}) {
  return {
    requestIP: overrides?.requestIP ?? (() => ({ address: '127.0.0.1' })),
    upgrade: overrides?.upgrade ?? (() => true),
  } as any;
}

const anonResolver = { resolveActor: async () => ANONYMOUS_ACTOR };

describe('createWsUpgradeHandler', () => {
  it('returns undefined on successful upgrade', async () => {
    const server = createMockServer();
    const handler = createWsUpgradeHandler(server, '/chat', anonResolver);
    const req = new Request('http://localhost/chat');

    const result = await handler(req);
    expect(result).toBeUndefined();
    expect(getClientIpFromRequest(req, false)).toBe('127.0.0.1');
  });

  it('returns 400 response when upgrade fails', async () => {
    const server = createMockServer({
      upgrade: () => false,
    });
    const handler = createWsUpgradeHandler(server, '/chat', anonResolver);
    const req = new Request('http://localhost/chat');

    const result = await handler(req);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(400);
    const body = await result!.json();
    expect(body).toEqual({ error: 'Upgrade failed' });
  });

  it('catches requestIP throwing without affecting upgrade', async () => {
    const server = createMockServer({
      requestIP: () => {
        throw new Error('requestIP not supported');
      },
    });
    const handler = createWsUpgradeHandler(server, '/ws', anonResolver);
    const req = new Request('http://localhost/ws');

    const result = await handler(req);
    expect(result).toBeUndefined();
    expect(getClientIpFromRequest(req, false)).toBe('unknown');
  });

  it('attaches resolved actor and request tenant on successful upgrade', async () => {
    const userActor: Actor = {
      ...ANONYMOUS_ACTOR,
      id: 'user-42',
      kind: 'user',
      tenantId: 'tenant-9',
    };
    const resolver = { resolveActor: async () => userActor };
    let capturedData: any = null;
    const server = createMockServer({
      upgrade: (_req: Request, opts: any) => {
        capturedData = opts?.data;
        return true;
      },
    });
    const handler = createWsUpgradeHandler(server, '/chat', resolver);
    const req = new Request('http://localhost/chat');

    await handler(req);

    expect(capturedData).toBeDefined();
    expect(capturedData.actor).toBe(userActor);
    expect(capturedData.requestTenantId).toBeNull();
    expect(capturedData.endpoint).toBe('/chat');
    expect(capturedData.rooms).toBeInstanceOf(Set);
    expect(typeof capturedData.id).toBe('string');
  });

  it('falls back to ANONYMOUS_ACTOR when actorResolver is null', async () => {
    let capturedData: any = null;
    const server = createMockServer({
      upgrade: (_req: Request, opts: any) => {
        capturedData = opts?.data;
        return true;
      },
    });
    const handler = createWsUpgradeHandler(server, '/ws', null);
    const req = new Request('http://localhost/ws');

    await handler(req);
    expect(capturedData.actor).toBe(ANONYMOUS_ACTOR);
    expect(capturedData.requestTenantId).toBeNull();
  });

  it.each([
    ['x-user-token header', 'http://localhost/ws', { 'x-user-token': 'invalid' }],
    ['bearer header', 'http://localhost/ws', { authorization: 'Bearer invalid' }],
    ['token query parameter', 'http://localhost/ws?token=invalid', {}],
    ['session cookie', 'http://localhost/ws', { cookie: 'token=invalid' }],
  ])('rejects an unresolved presented credential from the %s', async (_name, url, headers) => {
    let upgradeCalled = false;
    const server = createMockServer({
      upgrade: () => {
        upgradeCalled = true;
        return true;
      },
    });
    const handler = createWsUpgradeHandler(server, '/ws', anonResolver);

    const result = await handler(new Request(url, { headers }));

    expect(result?.status).toBe(401);
    expect(upgradeCalled).toBe(false);
  });

  it('presents a query token to the resolver without losing client IP metadata', async () => {
    let resolvedHeader: string | null = null;
    let resolvedIp: string | null = null;
    const resolver = {
      resolveActor: async (req: Request) => {
        resolvedHeader = req.headers.get('x-user-token');
        resolvedIp = getClientIpFromRequest(req, false);
        return {
          ...ANONYMOUS_ACTOR,
          id: 'user-42',
          kind: 'user' as const,
        };
      },
    };
    const handler = createWsUpgradeHandler(createMockServer(), '/ws', resolver);

    const result = await handler(new Request('http://localhost/ws?token=valid-token'));

    expect(result).toBeUndefined();
    expect(resolvedHeader as string | null).toBe('valid-token');
    expect(resolvedIp as string | null).toBe('127.0.0.1');
  });

  it('does not mistake a similarly named cookie for the session cookie', async () => {
    let resolvedHeader: string | null = null;
    const resolver = {
      resolveActor: async (req: Request) => {
        resolvedHeader = req.headers.get('x-user-token');
        return {
          ...ANONYMOUS_ACTOR,
          id: 'user-42',
          kind: 'user' as const,
        };
      },
    };
    const handler = createWsUpgradeHandler(createMockServer(), '/ws', resolver);

    const result = await handler(
      new Request('http://localhost/ws?token=valid-token', {
        headers: { cookie: 'not_token=unrelated' },
      }),
    );

    expect(result).toBeUndefined();
    expect(resolvedHeader as string | null).toBe('valid-token');
  });

  it('rejects a presented credential when the resolver has a transient failure', async () => {
    const resolver = {
      resolveActor: async () => {
        throw new Error('session store unavailable');
      },
    };
    const handler = createWsUpgradeHandler(createMockServer(), '/ws', resolver);

    const result = await handler(
      new Request('http://localhost/ws', { headers: { 'x-user-token': 'valid-looking' } }),
    );

    expect(result?.status).toBe(401);
  });

  it('does not attach a client IP when requestIP returns null', async () => {
    const server = createMockServer({
      requestIP: () => null,
    });
    const handler = createWsUpgradeHandler(server, '/ws', anonResolver);
    const req = new Request('http://localhost/ws');

    await handler(req);
    expect(getClientIpFromRequest(req, false)).toBe('unknown');
  });

  it('authenticates an anonymous socket from the first message using upgrade metadata', async () => {
    let capturedData: any = null;
    let authIp: string | null = null;
    const resolver = {
      resolveActor: async (req: Request) => {
        const token = req.headers.get('x-user-token');
        if (!token) return ANONYMOUS_ACTOR;
        authIp = getClientIpFromRequest(req, false);
        return { ...ANONYMOUS_ACTOR, id: 'user-42', kind: 'user' as const };
      },
    };
    const server = createMockServer({
      upgrade: (_req: Request, opts: any) => {
        capturedData = opts.data;
        return true;
      },
    });
    await createWsUpgradeHandler(server, '/ws', resolver)(new Request('http://localhost/ws'));
    const sent: string[] = [];
    const ws = { data: capturedData, send: (message: string) => sent.push(message) };

    expect(
      await handleFirstMessageAuth(ws, JSON.stringify({ type: 'auth', token: 'valid-token' })),
    ).toBe(true);
    expect(ws.data.actor).toMatchObject({ id: 'user-42', kind: 'user' });
    expect(Object.isFrozen(ws.data.actor)).toBe(true);
    expect(authIp as string | null).toBe('127.0.0.1');
    expect(sent).toEqual([JSON.stringify({ event: 'auth:authenticated' })]);
  });

  it('refuses first-message identity swaps and authentication after room membership', async () => {
    const sent: string[] = [];
    const authenticated = {
      data: {
        id: 'socket-1',
        actor: Object.freeze({ ...ANONYMOUS_ACTOR, id: 'user-1', kind: 'user' as const }),
        requestTenantId: null,
        rooms: new Set<string>(),
        endpoint: '/ws',
        authenticate: async () => ({
          ...ANONYMOUS_ACTOR,
          id: 'user-2',
          kind: 'user' as const,
        }),
      },
      send: (message: string) => sent.push(message),
    };
    await handleFirstMessageAuth(
      authenticated,
      JSON.stringify({ type: 'auth', token: 'replacement' }),
    );

    const joined = {
      ...authenticated,
      data: {
        ...authenticated.data,
        actor: ANONYMOUS_ACTOR,
        rooms: new Set(['private:user-1']),
      },
    };
    await handleFirstMessageAuth(joined, JSON.stringify({ type: 'auth', token: 'late' }));

    expect(sent).toEqual([
      JSON.stringify({ event: 'auth:error', code: 'IDENTITY_ALREADY_BOUND' }),
      JSON.stringify({ event: 'auth:error', code: 'IDENTITY_ALREADY_BOUND' }),
    ]);
  });
});
