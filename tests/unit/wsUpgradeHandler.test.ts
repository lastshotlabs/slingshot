import { describe, expect, it } from 'bun:test';
import { ANONYMOUS_ACTOR, type Actor, getClientIpFromRequest } from '@lastshotlabs/slingshot-core';
import { createWsUpgradeHandler } from '../../src/framework/ws/index';

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

  it('does not attach a client IP when requestIP returns null', async () => {
    const server = createMockServer({
      requestIP: () => null,
    });
    const handler = createWsUpgradeHandler(server, '/ws', anonResolver);
    const req = new Request('http://localhost/ws');

    await handler(req);
    expect(getClientIpFromRequest(req, false)).toBe('unknown');
  });
});
