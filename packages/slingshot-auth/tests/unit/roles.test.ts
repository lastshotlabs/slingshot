import { describe, expect, mock, test } from 'bun:test';
import type { AuthAdapter, SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import {
  addTenantRole,
  addUserRole,
  getTenantRoles,
  removeTenantRole,
  removeUserRole,
  setTenantRoles,
  setUserRoles,
} from '../../src/lib/roles';

function createMockAdapter(overrides: Partial<AuthAdapter> = {}): AuthAdapter {
  return {
    setRoles: mock(async () => {}),
    addRole: mock(async () => {}),
    removeRole: mock(async () => {}),
    getTenantRoles: mock(async () => []),
    setTenantRoles: mock(async () => {}),
    addTenantRole: mock(async () => {}),
    removeTenantRole: mock(async () => {}),
    ...overrides,
  } as unknown as AuthAdapter;
}

function createMockEventBus(): SlingshotEventBus {
  return {
    emit: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
  } as unknown as SlingshotEventBus;
}

// ---------------------------------------------------------------------------
// App-level roles
// ---------------------------------------------------------------------------

describe('setUserRoles', () => {
  test('calls adapter.setRoles and emits event', async () => {
    const adapter = createMockAdapter();
    const bus = createMockEventBus();
    await setUserRoles('user-1', ['admin', 'editor'], 'admin-1', adapter, bus);
    expect(adapter.setRoles).toHaveBeenCalledWith('user-1', ['admin', 'editor']);
    expect(bus.emit).toHaveBeenCalledWith('security.admin.role.changed', {
      userId: 'user-1',
      meta: {
        targetUserId: 'user-1',
        changedBy: 'admin-1',
        scope: 'app',
        roles: ['admin', 'editor'],
        action: 'set',
      },
    });
  });

  test('no event emitted when eventBus is undefined', async () => {
    const adapter = createMockAdapter();
    await setUserRoles('user-1', ['admin'], 'admin-1', adapter, undefined);
    expect(adapter.setRoles).toHaveBeenCalled();
  });

  test('throws when adapter is not provided', async () => {
    await expect(setUserRoles('user-1', ['admin'], 'admin-1', undefined)).rejects.toThrow(
      'Auth adapter is required',
    );
  });

  test('throws when adapter.setRoles is not implemented', async () => {
    const adapter = createMockAdapter();
    delete (adapter as unknown as Record<string, unknown>).setRoles;
    await expect(setUserRoles('user-1', ['admin'], 'admin-1', adapter)).rejects.toThrow(
      'does not implement setRoles',
    );
  });
});

describe('addUserRole', () => {
  test('calls adapter.addRole and emits event', async () => {
    const adapter = createMockAdapter();
    const bus = createMockEventBus();
    await addUserRole('user-1', 'moderator', 'admin-1', adapter, bus);
    expect(adapter.addRole).toHaveBeenCalledWith('user-1', 'moderator');
    expect(bus.emit).toHaveBeenCalledWith('security.admin.role.changed', {
      userId: 'user-1',
      meta: {
        targetUserId: 'user-1',
        changedBy: 'admin-1',
        scope: 'app',
        roles: ['moderator'],
        action: 'add',
      },
    });
  });

  test('throws when adapter is not provided', async () => {
    await expect(addUserRole('user-1', 'admin', 'admin-1', undefined)).rejects.toThrow(
      'Auth adapter is required',
    );
  });

  test('throws when adapter.addRole is not implemented', async () => {
    const adapter = createMockAdapter();
    delete (adapter as unknown as Record<string, unknown>).addRole;
    await expect(addUserRole('user-1', 'admin', 'admin-1', adapter)).rejects.toThrow(
      'does not implement addRole',
    );
  });
});

describe('removeUserRole', () => {
  test('calls adapter.removeRole and emits event', async () => {
    const adapter = createMockAdapter();
    const bus = createMockEventBus();
    await removeUserRole('user-1', 'moderator', 'admin-1', adapter, bus);
    expect(adapter.removeRole).toHaveBeenCalledWith('user-1', 'moderator');
    expect(bus.emit).toHaveBeenCalledWith('security.admin.role.changed', {
      userId: 'user-1',
      meta: {
        targetUserId: 'user-1',
        changedBy: 'admin-1',
        scope: 'app',
        roles: ['moderator'],
        action: 'remove',
      },
    });
  });

  test('throws when adapter is not provided', async () => {
    await expect(removeUserRole('user-1', 'admin', 'admin-1', undefined)).rejects.toThrow(
      'Auth adapter is required',
    );
  });
});

// ---------------------------------------------------------------------------
// Tenant-scoped roles
// ---------------------------------------------------------------------------

describe('getTenantRoles', () => {
  test('calls adapter.getTenantRoles and returns roles', async () => {
    const adapter = createMockAdapter({
      getTenantRoles: mock(async () => ['tenant-admin', 'billing']),
    });
    const roles = await getTenantRoles('user-1', 'tenant-1', adapter);
    expect(adapter.getTenantRoles).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(roles).toEqual(['tenant-admin', 'billing']);
  });

  test('throws when adapter is not provided', async () => {
    await expect(getTenantRoles('user-1', 'tenant-1', undefined)).rejects.toThrow(
      'Auth adapter is required',
    );
  });

  test('throws when adapter.getTenantRoles is not implemented', async () => {
    const adapter = createMockAdapter();
    delete (adapter as unknown as Record<string, unknown>).getTenantRoles;
    await expect(getTenantRoles('user-1', 'tenant-1', adapter)).rejects.toThrow(
      'does not implement getTenantRoles',
    );
  });
});

describe('setTenantRoles', () => {
  test('calls adapter.setTenantRoles and emits event', async () => {
    const adapter = createMockAdapter();
    const bus = createMockEventBus();
    await setTenantRoles('user-1', 'tenant-1', ['member', 'billing'], 'admin-1', adapter, bus);
    expect(adapter.setTenantRoles).toHaveBeenCalledWith('user-1', 'tenant-1', [
      'member',
      'billing',
    ]);
    expect(bus.emit).toHaveBeenCalledWith('security.admin.role.changed', {
      userId: 'user-1',
      meta: {
        targetUserId: 'user-1',
        changedBy: 'admin-1',
        scope: 'tenant',
        tenantId: 'tenant-1',
        roles: ['member', 'billing'],
        action: 'set',
      },
    });
  });

  test('throws when adapter is not provided', async () => {
    await expect(
      setTenantRoles('user-1', 'tenant-1', ['member'], 'admin-1', undefined),
    ).rejects.toThrow('Auth adapter is required');
  });
});

describe('addTenantRole', () => {
  test('calls adapter.addTenantRole and emits event', async () => {
    const adapter = createMockAdapter();
    const bus = createMockEventBus();
    await addTenantRole('user-1', 'tenant-1', 'billing-manager', 'admin-1', adapter, bus);
    expect(adapter.addTenantRole).toHaveBeenCalledWith('user-1', 'tenant-1', 'billing-manager');
    expect(bus.emit).toHaveBeenCalledWith('security.admin.role.changed', {
      userId: 'user-1',
      meta: {
        targetUserId: 'user-1',
        changedBy: 'admin-1',
        scope: 'tenant',
        tenantId: 'tenant-1',
        roles: ['billing-manager'],
        action: 'add',
      },
    });
  });

  test('throws when adapter.addTenantRole is not implemented', async () => {
    const adapter = createMockAdapter();
    delete (adapter as unknown as Record<string, unknown>).addTenantRole;
    await expect(
      addTenantRole('user-1', 'tenant-1', 'billing', 'admin-1', adapter),
    ).rejects.toThrow('does not implement addTenantRole');
  });
});

describe('removeTenantRole', () => {
  test('calls adapter.removeTenantRole and emits event', async () => {
    const adapter = createMockAdapter();
    const bus = createMockEventBus();
    await removeTenantRole('user-1', 'tenant-1', 'billing-manager', 'admin-1', adapter, bus);
    expect(adapter.removeTenantRole).toHaveBeenCalledWith('user-1', 'tenant-1', 'billing-manager');
    expect(bus.emit).toHaveBeenCalledWith('security.admin.role.changed', {
      userId: 'user-1',
      meta: {
        targetUserId: 'user-1',
        changedBy: 'admin-1',
        scope: 'tenant',
        tenantId: 'tenant-1',
        roles: ['billing-manager'],
        action: 'remove',
      },
    });
  });

  test('throws when adapter.removeTenantRole is not implemented', async () => {
    const adapter = createMockAdapter();
    delete (adapter as unknown as Record<string, unknown>).removeTenantRole;
    await expect(
      removeTenantRole('user-1', 'tenant-1', 'billing', 'admin-1', adapter),
    ).rejects.toThrow('does not implement removeTenantRole');
  });
});

describe('event emission details', () => {
  test('changedBy is undefined when not provided', async () => {
    const adapter = createMockAdapter();
    const bus = createMockEventBus();
    await setUserRoles('user-1', ['admin'], undefined, adapter, bus);
    expect(bus.emit).toHaveBeenCalledWith('security.admin.role.changed', {
      userId: 'user-1',
      meta: {
        targetUserId: 'user-1',
        changedBy: undefined,
        scope: 'app',
        roles: ['admin'],
        action: 'set',
      },
    });
  });
});
