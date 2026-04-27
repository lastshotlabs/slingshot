/**
 * Unit tests for buildSubscribeGuard() — the WebSocket channel subscribe guard.
 *
 * Validates auth enforcement, permission checks, middleware chain, and
 * denial of unknown channels.
 */
import { describe, expect, it, mock } from 'bun:test';
import type { Actor, EntityChannelConfig } from '@lastshotlabs/slingshot-core';
import { buildSubscribeGuard } from '../../packages/slingshot-entity/src/channels/applyChannelConfig';
import type { ChannelConfigDeps } from '../../packages/slingshot-entity/src/channels/applyChannelConfig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_ACTOR: Actor = {
  id: 'user-1',
  kind: 'user',
  tenantId: null,
  sessionId: null,
  roles: null,
  claims: {},
};

function makeDeps(overrides: Partial<ChannelConfigDeps> = {}): ChannelConfigDeps {
  return {
    getActor: mock(() => MOCK_ACTOR),
    checkPermission: mock(async () => true),
    middleware: {},
    ...overrides,
  };
}

function makeChannelConfigs(
  storageName: string,
  channelConfig: EntityChannelConfig,
): Map<string, EntityChannelConfig> {
  return new Map([[storageName, channelConfig]]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSubscribeGuard', () => {
  it('allows subscribe to declared channel with valid auth + permission', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read' },
        },
      },
    });
    const deps = makeDeps();
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(true);
    expect(deps.getActor).toHaveBeenCalled();
    expect(deps.checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', kind: 'user' }),
      'thread:read',
      undefined,
    );
  });

  it('denies subscribe to undeclared channel name', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: { auth: 'none' },
      },
    });
    const deps = makeDeps();
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:unknown');

    expect(result).toBe(false);
  });

  it('denies subscribe to unknown entity storage name', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: { auth: 'none' },
      },
    });
    const deps = makeDeps();
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'unknown:abc123:updates');

    expect(result).toBe(false);
  });

  it('denies subscribe with no identity when auth is userAuth', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: { auth: 'userAuth' },
      },
    });
    const deps = makeDeps({ getActor: mock(() => null) });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
  });

  it('denies subscribe with no identity when auth is bearer', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: { auth: 'bearer' },
      },
    });
    const deps = makeDeps({ getActor: mock(() => null) });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
  });

  it('allows subscribe when auth is none and no identity', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: { auth: 'none' },
      },
    });
    const deps = makeDeps({ getActor: mock(() => null) });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(true);
  });

  it('denies when permission check fails', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read' },
        },
      },
    });
    const deps = makeDeps({ checkPermission: mock(async () => false) });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
  });

  it('allows when primary permission fails but fallback "or" passes', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read', or: 'thread:admin' },
        },
      },
    });
    const checkPermission = mock(async (_actor: Actor, perm: string) => {
      return perm === 'thread:admin';
    });
    const deps = makeDeps({ checkPermission });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(true);
    expect(checkPermission).toHaveBeenCalledTimes(2);
  });

  it('denies when middleware returns false', async () => {
    const banCheck = mock(async () => false);
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'none',
          middleware: ['banCheck'],
        },
      },
    });
    const deps = makeDeps({ middleware: { banCheck } });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
    expect(banCheck).toHaveBeenCalled();
  });

  it('denies when middleware name is not registered', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'none',
          middleware: ['nonexistent'],
        },
      },
    });
    const deps = makeDeps();
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
  });

  it('calls middleware in declared order and short-circuits on failure', async () => {
    const callOrder: string[] = [];
    const first = mock(async () => {
      callOrder.push('first');
      return true;
    });
    const second = mock(async () => {
      callOrder.push('second');
      return false;
    });
    const third = mock(async () => {
      callOrder.push('third');
      return true;
    });

    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'none',
          middleware: ['first', 'second', 'third'],
        },
      },
    });
    const deps = makeDeps({ middleware: { first, second, third } });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
    expect(callOrder).toEqual(['first', 'second']);
    expect(third).not.toHaveBeenCalled();
  });

  it('passes parsed room context to middleware handlers', async () => {
    const handler = mock(async () => true);
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'none',
          middleware: ['check'],
        },
      },
    });
    const deps = makeDeps({ middleware: { check: handler } });
    const guard = buildSubscribeGuard(configs, deps);

    await guard({}, 'threads:abc123:updates');

    expect(handler).toHaveBeenCalledWith(
      {},
      {
        storageName: 'threads',
        entityId: 'abc123',
        channelName: 'updates',
      },
    );
  });

  it('denies malformed room names', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: { auth: 'none' },
      },
    });
    const deps = makeDeps();
    const guard = buildSubscribeGuard(configs, deps);

    expect(await guard({}, 'threads:abc123')).toBe(false);
    expect(await guard({}, 'threads')).toBe(false);
    expect(await guard({}, '')).toBe(false);
    expect(await guard({}, 'a:b:c:d')).toBe(false);
  });

  it('passes permission scope through to checkPermission', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: {
            requires: 'thread:read',
            scope: { tenantId: 'tenant-1' },
          },
        },
      },
    });
    const deps = makeDeps();
    const guard = buildSubscribeGuard(configs, deps);

    await guard({}, 'threads:abc123:updates');

    expect(deps.checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', kind: 'user' }),
      'thread:read',
      { tenantId: 'tenant-1' },
    );
  });

  it('ownerField match allows subscribe', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read', ownerField: 'ownerId' },
        },
      },
    });
    const getEntity = mock(async () => ({ id: 'abc123', ownerId: 'user-1' }));
    const deps = makeDeps({ getEntity });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(true);
    expect(getEntity).toHaveBeenCalledWith('threads', 'abc123');
  });

  it('ownerField mismatch denies subscribe', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read', ownerField: 'ownerId' },
        },
      },
    });
    const getEntity = mock(async () => ({ id: 'abc123', ownerId: 'someone-else' }));
    const deps = makeDeps({ getEntity });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
  });

  it('ownerField with missing entity denies subscribe', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read', ownerField: 'ownerId' },
        },
      },
    });
    const getEntity = mock(async () => null);
    const deps = makeDeps({ getEntity });
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
  });

  it('ownerField without getEntity dep denies subscribe', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read', ownerField: 'ownerId' },
        },
      },
    });
    const deps = makeDeps(); // no getEntity
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(false);
  });

  it('resolves identity for permission check even when auth is none', async () => {
    const configs = makeChannelConfigs('threads', {
      channels: {
        updates: {
          auth: 'none',
          permission: { requires: 'thread:read' },
        },
      },
    });
    const deps = makeDeps();
    const guard = buildSubscribeGuard(configs, deps);

    const result = await guard({}, 'threads:abc123:updates');

    expect(result).toBe(true);
    expect(deps.getActor).toHaveBeenCalled();
  });
});
