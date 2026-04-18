/**
 * Tests for the SQLite M2M adapter CRUD methods introduced in migration v2.
 * Verifies createM2MClient, getM2MClient, deleteM2MClient, listM2MClients.
 */
import { createSqliteAuthAdapter } from '@auth/adapters/sqliteAuth';
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';

let adapter: AuthAdapter;

beforeEach(() => {
  adapter = createSqliteAuthAdapter(new Database(':memory:')).adapter;
});

async function hashSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret);
}

describe('SQLite M2M adapter — createM2MClient', () => {
  test('creates a client and returns an id', async () => {
    const secretHash = await hashSecret('my-secret');
    const result = await adapter.createM2MClient!({
      clientId: 'svc-a',
      clientSecretHash: secretHash,
      name: 'Service A',
      scopes: ['read:data'],
    });
    expect(result.id).toBeString();
    expect(result.id.length).toBeGreaterThan(0);
  });

  test('duplicate clientId throws a constraint error', async () => {
    const secretHash = await hashSecret('secret');
    await adapter.createM2MClient!({
      clientId: 'duplicate',
      clientSecretHash: secretHash,
      name: 'Service',
      scopes: [],
    });
    await expect(
      adapter.createM2MClient!({
        clientId: 'duplicate',
        clientSecretHash: secretHash,
        name: 'Another',
        scopes: [],
      }),
    ).rejects.toThrow();
  });
});

describe('SQLite M2M adapter — getM2MClient', () => {
  test('returns null for unknown clientId', async () => {
    const result = await adapter.getM2MClient!('nonexistent');
    expect(result).toBeNull();
  });

  test('returns the client after creation', async () => {
    const secretHash = await hashSecret('s3cr3t');
    await adapter.createM2MClient!({
      clientId: 'svc-b',
      clientSecretHash: secretHash,
      name: 'Service B',
      scopes: ['read:users', 'write:users'],
    });

    const client = await adapter.getM2MClient!('svc-b');
    expect(client).not.toBeNull();
    expect(client!.clientId).toBe('svc-b');
    expect(client!.name).toBe('Service B');
    expect(client!.scopes).toEqual(['read:users', 'write:users']);
    expect(client!.clientSecretHash).toBe(secretHash);
    expect(client!.active).toBe(true);
  });

  test('scopes are deserialized from JSON', async () => {
    await adapter.createM2MClient!({
      clientId: 'svc-scopes',
      clientSecretHash: 'hash',
      name: 'Scopes Test',
      scopes: ['a', 'b', 'c'],
    });
    const client = await adapter.getM2MClient!('svc-scopes');
    expect(Array.isArray(client!.scopes)).toBe(true);
    expect(client!.scopes).toHaveLength(3);
  });
});

describe('SQLite M2M adapter — deleteM2MClient', () => {
  test('deleted client returns null on subsequent get', async () => {
    await adapter.createM2MClient!({
      clientId: 'to-delete',
      clientSecretHash: 'hash',
      name: 'Delete Me',
      scopes: [],
    });

    await adapter.deleteM2MClient!('to-delete');
    const result = await adapter.getM2MClient!('to-delete');
    expect(result).toBeNull();
  });

  test('deleting non-existent client does not throw', async () => {
    await expect(adapter.deleteM2MClient!('ghost')).resolves.toBeUndefined();
  });
});

describe('SQLite M2M adapter — listM2MClients', () => {
  test('returns empty array when no clients exist', async () => {
    const clients = await adapter.listM2MClients!();
    expect(clients).toHaveLength(0);
  });

  test('returns all created clients', async () => {
    await adapter.createM2MClient!({
      clientId: 'list-a',
      clientSecretHash: 'h1',
      name: 'A',
      scopes: ['read'],
    });
    await adapter.createM2MClient!({
      clientId: 'list-b',
      clientSecretHash: 'h2',
      name: 'B',
      scopes: ['write'],
    });

    const clients = await adapter.listM2MClients!();
    expect(clients).toHaveLength(2);
    const ids = clients.map(c => c.clientId);
    expect(ids).toContain('list-a');
    expect(ids).toContain('list-b');
  });

  test('deleted client does not appear in list', async () => {
    await adapter.createM2MClient!({
      clientId: 'listed',
      clientSecretHash: 'h',
      name: 'Listed',
      scopes: [],
    });
    await adapter.createM2MClient!({
      clientId: 'listed-gone',
      clientSecretHash: 'h',
      name: 'Gone',
      scopes: [],
    });
    await adapter.deleteM2MClient!('listed-gone');

    const clients = await adapter.listM2MClients!();
    const ids = clients.map(c => c.clientId);
    expect(ids).toContain('listed');
    expect(ids).not.toContain('listed-gone');
  });
});
