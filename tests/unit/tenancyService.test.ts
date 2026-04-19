import { describe, expect, mock, test } from 'bun:test';

// Mock mongoose module to avoid actual DB connection
mock.module('mongoose', () => {
  class Schema {
    static Types = { Mixed: 'Mixed' };
    constructor(_def: unknown, _opts?: unknown) {}
  }
  return {
    default: { Schema },
    Schema,
  };
});

import { createTenantService } from '../../src/framework/tenancy/service';

// ---------------------------------------------------------------------------
// Build a mock Mongoose Connection
// ---------------------------------------------------------------------------

function buildDoc(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    displayName: 'Tenant One',
    config: { theme: 'dark' },
    createdAt: new Date('2024-01-01'),
    deletedAt: null,
    ...overrides,
  };
}

function makeQuery(result: unknown) {
  // Mongoose query chains: findOne().lean(), find().lean()
  return { lean: mock(async () => result) };
}

function makeMockTenantModel(opts: {
  findOne?: unknown;
  findOneAndUpdate?: unknown;
  create?: unknown;
  find?: unknown;
} = {}) {
  const model: Record<string, unknown> = {
    findOne: mock(() => makeQuery(opts.findOne ?? null)),
    findOneAndUpdate: mock(async () => null),
    create: mock(async () => ({})),
    find: mock(() => makeQuery(opts.find ?? [])),
  };
  return model;
}

function makeConnection(
  model: Record<string, unknown>,
  hasExisting = false,
) {
  return {
    models: hasExisting ? { Tenant: model } : {},
    model: mock(() => model),
  };
}

// ---------------------------------------------------------------------------
// getMongooseModule mock
// ---------------------------------------------------------------------------

// The service uses getMongooseModule() to get Schema when creating a model.
// We mock the mongo module to avoid real mongoose.
mock.module('../../src/lib/mongo', () => ({
  getMongooseModule: () => ({
    Schema: class Schema {
      static Types = { Mixed: 'Mixed' };
      constructor(_def: unknown, _opts?: unknown) {}
    },
  }),
}));

describe('createTenantService', () => {
  // ---------------------------------------------------------------------------
  // createTenant
  // ---------------------------------------------------------------------------

  test('createTenant creates new tenant when it does not exist', async () => {
    const mockModel = makeMockTenantModel({ findOne: null });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    await service.createTenant('tenant-new', { displayName: 'New Tenant' });

    expect(mockModel.create as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
    const createArg = (mockModel.create as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(createArg.tenantId).toBe('tenant-new');
    expect(createArg.displayName).toBe('New Tenant');
  });

  test('createTenant throws when tenant already exists and is not deleted', async () => {
    const existingDoc = buildDoc({ deletedAt: null });
    const mockModel = makeMockTenantModel({ findOne: existingDoc });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    await expect(service.createTenant('tenant-1')).rejects.toThrow(
      'Tenant "tenant-1" already exists',
    );
  });

  test('createTenant reactivates soft-deleted tenant', async () => {
    const deletedDoc = buildDoc({ deletedAt: new Date('2024-06-01') });
    const mockModel = makeMockTenantModel({ findOne: deletedDoc });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    await service.createTenant('tenant-1', { displayName: 'Reactivated' });

    // Should call findOneAndUpdate to reactivate, not create
    expect(mockModel.findOneAndUpdate as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
    expect(mockModel.create as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // deleteTenant
  // ---------------------------------------------------------------------------

  test('deleteTenant soft-deletes an existing active tenant', async () => {
    const existingDoc = buildDoc({ deletedAt: null });
    const mockModel = makeMockTenantModel({ findOne: existingDoc });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    await service.deleteTenant('tenant-1');

    expect(mockModel.findOneAndUpdate as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
  });

  test('deleteTenant does nothing when tenant does not exist', async () => {
    const mockModel = makeMockTenantModel({ findOne: null });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    await service.deleteTenant('nonexistent');

    expect(mockModel.findOneAndUpdate as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });

  test('deleteTenant does nothing when tenant is already deleted', async () => {
    const deletedDoc = buildDoc({ deletedAt: new Date('2024-06-01') });
    const mockModel = makeMockTenantModel({ findOne: deletedDoc });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    await service.deleteTenant('tenant-1');

    expect(mockModel.findOneAndUpdate as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });

  test('deleteTenant calls cache.delete when cache is provided', async () => {
    const existingDoc = buildDoc({ deletedAt: null });
    const mockModel = makeMockTenantModel({ findOne: existingDoc });
    const conn = makeConnection(mockModel);

    const mockCache = { delete: mock(() => {}) };
    const service = createTenantService(conn as never, () => mockCache);
    await service.deleteTenant('tenant-1');

    expect(mockCache.delete).toHaveBeenCalledWith('tenant-1');
  });

  test('deleteTenant does not throw when cache getter returns null', async () => {
    const existingDoc = buildDoc({ deletedAt: null });
    const mockModel = makeMockTenantModel({ findOne: existingDoc });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never, () => null);
    await service.deleteTenant('tenant-1'); // should not throw
  });

  // ---------------------------------------------------------------------------
  // getTenant
  // ---------------------------------------------------------------------------

  test('getTenant returns null when tenant not found', async () => {
    const mockModel = makeMockTenantModel({ findOne: null });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    const result = await service.getTenant('nonexistent');

    expect(result).toBeNull();
  });

  test('getTenant returns TenantInfo when found', async () => {
    const doc = buildDoc();
    const mockModel = makeMockTenantModel({ findOne: doc });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    const result = await service.getTenant('tenant-1');

    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe('tenant-1');
    expect(result?.displayName).toBe('Tenant One');
    expect(result?.config).toEqual({ theme: 'dark' });
  });

  // ---------------------------------------------------------------------------
  // listTenants
  // ---------------------------------------------------------------------------

  test('listTenants returns empty array when no tenants', async () => {
    const mockModel = makeMockTenantModel({ find: [] });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    const result = await service.listTenants();

    expect(result).toEqual([]);
  });

  test('listTenants returns mapped TenantInfo array', async () => {
    const docs = [buildDoc(), buildDoc({ tenantId: 'tenant-2', displayName: 'Tenant Two' })];
    const mockModel = makeMockTenantModel({ find: docs });
    const conn = makeConnection(mockModel);

    const service = createTenantService(conn as never);
    const result = await service.listTenants();

    expect(result).toHaveLength(2);
    expect(result[0].tenantId).toBe('tenant-1');
    expect(result[1].tenantId).toBe('tenant-2');
  });

  // ---------------------------------------------------------------------------
  // Model reuse (conn.models cache)
  // ---------------------------------------------------------------------------

  test('reuses existing Tenant model from conn.models when already registered', async () => {
    const mockModel = makeMockTenantModel({ findOne: null });
    // Simulate model already cached in conn.models
    const conn = makeConnection(mockModel, true); // hasExisting = true

    const service = createTenantService(conn as never);
    await service.createTenant('new-tenant');

    // conn.model() should NOT be called because we reused the cached model
    expect(conn.model as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });
});
