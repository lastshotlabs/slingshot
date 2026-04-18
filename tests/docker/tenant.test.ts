import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTenantService } from '../../src/framework/tenancy/service';
import type { TenantService } from '../../src/framework/tenancy/service';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAuthConn,
} from '../setup-docker';

let service: TenantService;

beforeAll(async () => {
  await connectTestMongo();
  service = createTenantService(getTestAuthConn());
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await connectTestMongo();
  await flushTestServices();
});

// ---------------------------------------------------------------------------
// createTenant
// ---------------------------------------------------------------------------

describe('createTenant', () => {
  it('creates a new tenant', async () => {
    await service.createTenant('tenant-1', { displayName: 'Acme Corp', config: { plan: 'pro' } });
    const tenant = await service.getTenant('tenant-1');
    expect(tenant).not.toBeNull();
    expect(tenant!.tenantId).toBe('tenant-1');
    expect(tenant!.displayName).toBe('Acme Corp');
    expect(tenant!.config?.plan).toBe('pro');
    expect(tenant!.createdAt).toBeInstanceOf(Date);
  });

  it('creates a tenant without optional fields', async () => {
    await service.createTenant('tenant-bare');
    const tenant = await service.getTenant('tenant-bare');
    expect(tenant).not.toBeNull();
    expect(tenant!.tenantId).toBe('tenant-bare');
    expect(tenant!.displayName).toBeUndefined();
  });

  it('throws when trying to create a duplicate active tenant', async () => {
    await service.createTenant('tenant-dup');
    try {
      await service.createTenant('tenant-dup');
      throw new Error('Expected duplicate to throw');
    } catch (err: any) {
      expect(err.message).toContain('already exists');
    }
  });

  it('reactivates a soft-deleted tenant', async () => {
    await service.createTenant('tenant-revive', { displayName: 'Old Name' });
    await service.deleteTenant('tenant-revive');

    // Should not throw — reactivates instead
    await service.createTenant('tenant-revive', { displayName: 'New Name' });
    const tenant = await service.getTenant('tenant-revive');
    expect(tenant).not.toBeNull();
    expect(tenant!.displayName).toBe('New Name');
  });
});

// ---------------------------------------------------------------------------
// getTenant
// ---------------------------------------------------------------------------

describe('getTenant', () => {
  it('returns null for an unknown tenantId', async () => {
    const result = await service.getTenant('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null for a soft-deleted tenant', async () => {
    await service.createTenant('tenant-deleted');
    await service.deleteTenant('tenant-deleted');
    expect(await service.getTenant('tenant-deleted')).toBeNull();
  });

  it('returns TenantInfo with all fields populated', async () => {
    await service.createTenant('tenant-full', {
      displayName: 'Full Corp',
      config: { tier: 'enterprise' },
    });
    const result = await service.getTenant('tenant-full');
    expect(result!.tenantId).toBe('tenant-full');
    expect(result!.displayName).toBe('Full Corp');
    expect(result!.config?.tier).toBe('enterprise');
    expect(result!.createdAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// listTenants
// ---------------------------------------------------------------------------

describe('listTenants', () => {
  it('returns all non-deleted tenants', async () => {
    await service.createTenant('list-1');
    await service.createTenant('list-2');
    await service.createTenant('list-3');

    const tenants = await service.listTenants();
    const ids = tenants.map((t: { tenantId: string }) => t.tenantId);
    expect(ids).toContain('list-1');
    expect(ids).toContain('list-2');
    expect(ids).toContain('list-3');
  });

  it('excludes soft-deleted tenants', async () => {
    await service.createTenant('active-t');
    await service.createTenant('deleted-t');
    await service.deleteTenant('deleted-t');

    const tenants = await service.listTenants();
    const ids = tenants.map((t: { tenantId: string }) => t.tenantId);
    expect(ids).toContain('active-t');
    expect(ids).not.toContain('deleted-t');
  });

  it('returns an empty array when no tenants exist', async () => {
    const tenants = await service.listTenants();
    expect(tenants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteTenant
// ---------------------------------------------------------------------------

describe('deleteTenant', () => {
  it('soft-deletes so the tenant is excluded from getTenant and listTenants', async () => {
    await service.createTenant('to-delete');
    await service.deleteTenant('to-delete');

    expect(await service.getTenant('to-delete')).toBeNull();
    const list = await service.listTenants();
    expect(list.map((t: { tenantId: string }) => t.tenantId)).not.toContain('to-delete');
  });

  it('is idempotent — deleting again does not throw', async () => {
    await service.createTenant('idempotent-delete');
    await service.deleteTenant('idempotent-delete');
    await service.deleteTenant('idempotent-delete');
    expect(await service.getTenant('idempotent-delete')).toBeNull();
  });
});
