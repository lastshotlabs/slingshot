/**
 * Mongo M2M adapter tests.
 *
 * Verifies that createMongoAuthAdapter correctly implements the M2M CRUD
 * operations: createM2MClient, getM2MClient, listM2MClients, deleteM2MClient.
 *
 * These are excluded from the shared adapter-parity suite because M2M clients
 * require a pre-hashed secret whose generation strategy differs across backends.
 * Requires Docker (port 27018).
 */
import { createMongoAuthAdapter } from '@auth/adapters/mongoAuth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getMongooseModule } from '../../src/lib/mongo';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAuthConn,
} from '../setup-docker';

let adapter: ReturnType<typeof createMongoAuthAdapter>;

beforeAll(async () => {
  await connectTestMongo();
  adapter = createMongoAuthAdapter(getTestAuthConn(), getMongooseModule());
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

describe('Mongo M2M adapter', () => {
  const makeClient = (suffix: string) => ({
    clientId: `client-${suffix}`,
    clientSecretHash: `hash-${suffix}`,
    name: `Test Client ${suffix}`,
    scopes: ['read:users', 'write:users'],
  });

  // -------------------------------------------------------------------------
  // createM2MClient
  // -------------------------------------------------------------------------

  describe('createM2MClient', () => {
    it('returns an id for the new client', async () => {
      const result = await adapter.createM2MClient!(makeClient('create'));
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });

    it('throws on duplicate clientId', async () => {
      await adapter.createM2MClient!(makeClient('dup'));
      // Use try/catch instead of expect().rejects due to a Bun v1.3.x bug where
      // the first expect(mongodbOp).rejects.* in a test file hangs ~5000ms.
      let threw = false;
      try {
        await adapter.createM2MClient!(makeClient('dup'));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getM2MClient
  // -------------------------------------------------------------------------

  describe('getM2MClient', () => {
    it('returns the client by clientId', async () => {
      await adapter.createM2MClient!(makeClient('get'));
      const client = await adapter.getM2MClient!('client-get');
      expect(client).not.toBeNull();
      expect(client!.clientId).toBe('client-get');
      expect(client!.name).toBe('Test Client get');
      expect(client!.clientSecretHash).toBe('hash-get');
      expect(client!.active).toBe(true);
    });

    it('returns null for a non-existent clientId', async () => {
      const client = await adapter.getM2MClient!('no-such-client');
      expect(client).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listM2MClients
  // -------------------------------------------------------------------------

  describe('listM2MClients', () => {
    it('returns all active clients', async () => {
      await adapter.createM2MClient!(makeClient('list-a'));
      await adapter.createM2MClient!(makeClient('list-b'));

      const clients = await adapter.listM2MClients!();
      const ids = clients.map(c => c.clientId);
      expect(ids).toContain('client-list-a');
      expect(ids).toContain('client-list-b');
    });

    it('returns empty array when no clients exist', async () => {
      const clients = await adapter.listM2MClients!();
      expect(clients).toHaveLength(0);
    });

    it('does not include deleted clients', async () => {
      await adapter.createM2MClient!(makeClient('list-del'));
      await adapter.deleteM2MClient!('client-list-del');

      const clients = await adapter.listM2MClients!();
      expect(clients.map(c => c.clientId)).not.toContain('client-list-del');
    });
  });

  // -------------------------------------------------------------------------
  // deleteM2MClient
  // -------------------------------------------------------------------------

  describe('deleteM2MClient', () => {
    it('removes the client so getM2MClient returns null', async () => {
      await adapter.createM2MClient!(makeClient('del'));
      await adapter.deleteM2MClient!('client-del');
      const client = await adapter.getM2MClient!('client-del');
      expect(client).toBeNull();
    });

    it('is idempotent: deleting a non-existent client does not throw', async () => {
      await expect(adapter.deleteM2MClient!('no-such-client')).resolves.toBeUndefined();
    });
  });
});
