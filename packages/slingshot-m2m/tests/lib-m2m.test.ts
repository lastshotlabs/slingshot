import { describe, expect, mock, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { createM2MClient, deleteM2MClient, getM2MClient, listM2MClients } from '../src/lib/m2m';

const fakePassword = {
  hash: async (plain: string) => `hashed:${plain}`,
  verify: async () => false,
};

function makeAdapter(overrides: Partial<AuthAdapter> = {}): AuthAdapter {
  return overrides as AuthAdapter;
}

// ---------------------------------------------------------------------------
// getM2MClient
// ---------------------------------------------------------------------------

describe('getM2MClient', () => {
  test('returns null when adapter does not support M2M', async () => {
    const result = await getM2MClient(makeAdapter(), 'client-1');
    expect(result).toBeNull();
  });

  test('delegates to adapter.getM2MClient and returns the record', async () => {
    const record = {
      id: '1',
      clientId: 'client-1',
      clientSecretHash: 'hash',
      name: 'Client',
      scopes: ['read'],
      active: true,
    };
    const result = await getM2MClient(
      makeAdapter({ getM2MClient: async () => record }),
      'client-1',
    );
    expect(result).toBe(record);
  });
});

// ---------------------------------------------------------------------------
// createM2MClient
// ---------------------------------------------------------------------------

describe('createM2MClient', () => {
  test('throws when adapter does not support M2M client creation', async () => {
    await expect(
      createM2MClient({
        clientId: 'svc',
        name: 'Service',
        adapter: makeAdapter(),
        password: fakePassword,
      }),
    ).rejects.toThrow('Auth adapter does not support M2M clients');
  });

  test('throws when a client with that clientId already exists', async () => {
    const existing = {
      id: '1',
      clientId: 'svc',
      clientSecretHash: 'h',
      name: 'S',
      scopes: [],
      active: true,
    };
    const adapter = makeAdapter({
      getM2MClient: async () => existing,
      createM2MClient: mock(async () => ({ id: '2' })),
    });
    await expect(
      createM2MClient({ clientId: 'svc', name: 'Service', adapter, password: fakePassword }),
    ).rejects.toThrow('M2M client already exists: svc');
  });

  test('hashes the generated secret and passes it to adapter.createM2MClient', async () => {
    const createFn = mock(async () => ({ id: 'new-id' }));
    const adapter = makeAdapter({ getM2MClient: async () => null, createM2MClient: createFn });

    const result = await createM2MClient({
      clientId: 'billing',
      name: 'Billing',
      scopes: ['read:invoices'],
      adapter,
      password: fakePassword,
    });

    expect(result.id).toBe('new-id');
    expect(result.clientId).toBe('billing');
    expect(result.clientSecret).toBeString();
    expect(createFn).toHaveBeenCalledTimes(1);
    const call = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.clientSecretHash).toBe(`hashed:${result.clientSecret}`);
    expect(call.scopes).toEqual(['read:invoices']);
  });

  test('defaults scopes to empty array when omitted', async () => {
    const createFn = mock(async () => ({ id: 'x' }));
    const adapter = makeAdapter({ getM2MClient: async () => null, createM2MClient: createFn });

    await createM2MClient({ clientId: 'svc', name: 'Svc', adapter, password: fakePassword });

    expect((createFn.mock.calls[0]?.[0] as Record<string, unknown>).scopes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteM2MClient
// ---------------------------------------------------------------------------

describe('deleteM2MClient', () => {
  test('is a no-op when adapter does not support deletion', async () => {
    await expect(deleteM2MClient(makeAdapter(), 'client-1')).resolves.toBeUndefined();
  });

  test('delegates to adapter.deleteM2MClient', async () => {
    const deleteFn = mock(async () => {});
    await deleteM2MClient(makeAdapter({ deleteM2MClient: deleteFn }), 'client-1');
    expect(deleteFn).toHaveBeenCalledWith('client-1');
  });
});

// ---------------------------------------------------------------------------
// listM2MClients
// ---------------------------------------------------------------------------

describe('listM2MClients', () => {
  test('returns empty array when adapter does not support listing', async () => {
    const result = await listM2MClients(makeAdapter());
    expect(result).toEqual([]);
  });

  test('delegates to adapter.listM2MClients and returns the records', async () => {
    const clients = [{ id: '1', clientId: 'svc-a', name: 'A', scopes: [], active: true }];
    const result = await listM2MClients(makeAdapter({ listM2MClients: async () => clients }));
    expect(result).toBe(clients);
  });
});
