/**
 * MongoDB resilience tests.
 *
 * Verifies that Mongoose connection state is detectable, that operations
 * fail predictably (not silently) when the connection is closed, and that
 * a reconnected connection resumes normal operation.
 *
 * Requires Docker MongoDB on port 27018 (docker-compose.test.yml).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { getMongooseModule } from '../../src/lib/mongo';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAuthConn,
} from '../setup-docker';

beforeAll(async () => {
  await connectTestMongo();
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await connectTestMongo();
  await flushTestServices();
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe('MongoDB resilience — baseline', () => {
  it('connection is in ready state (readyState === 1)', () => {
    expect(getTestAuthConn().readyState).toBe(1);
  });

  it('can insert and retrieve a document', async () => {
    const conn = getTestAuthConn();
    const col = conn.db!.collection('resilience_baseline');
    await col.insertOne({ ok: true });
    const doc = await col.findOne({ ok: true });
    expect(doc).not.toBeNull();
    expect(doc!.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Connection close + query failure
// ---------------------------------------------------------------------------

describe('MongoDB resilience — connection close', () => {
  it('readyState transitions to 0 after close()', async () => {
    const conn = getTestAuthConn();
    expect(conn.readyState).toBe(1); // connected

    await conn.close();
    // readyState 0 = disconnected
    expect(conn.readyState).toBe(0);
  });

  it('query against closed connection throws (not silently returns null)', async () => {
    const conn = getTestAuthConn();
    await conn.close();

    // Mongoose throws when you attempt a query on a closed connection
    await expect(conn.db!.collection('resilience_closed').findOne({ x: 1 })).rejects.toThrow();
  });

  it('reconnecting restores full operation', async () => {
    // Close the existing connection
    const oldConn = getTestAuthConn();
    await oldConn.close();
    expect(oldConn.readyState).toBe(0);

    // Open a fresh connection to the same database
    const mg = getMongooseModule();
    const newConn = mg.createConnection();
    await newConn.openUri('mongodb://localhost:27018/slingshot_test');
    expect(newConn.readyState).toBe(1);

    // New connection works
    const col = newConn.db!.collection('resilience_reconnect');
    await col.insertOne({ reconnected: true });
    const doc = await col.findOne({ reconnected: true });
    expect(doc!.reconnected).toBe(true);

    await newConn.close();
  });
});

// ---------------------------------------------------------------------------
// Concurrent write/read under normal conditions
// ---------------------------------------------------------------------------

describe('MongoDB resilience — concurrent operations', () => {
  it('handles concurrent inserts without corruption', async () => {
    const mg = getMongooseModule();
    const conn = await mg.createConnection('mongodb://localhost:27018/slingshot_test').asPromise();
    const col = conn.db!.collection('resilience_concurrent');

    try {
      const writes = Array.from({ length: 20 }, (_, i) =>
        col.insertOne({ idx: i, ts: Date.now() }),
      );
      await Promise.all(writes);

      const count = await col.countDocuments();
      expect(count).toBe(20);
    } finally {
      await conn.close();
    }
  });
});
