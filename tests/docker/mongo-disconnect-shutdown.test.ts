/**
 * Docker integration tests for disconnectMongo during graceful shutdown.
 *
 * The framework's `connectMongo()` uses `mongodb+srv://` which requires DNS SRV
 * resolution and can't connect to the local Docker MongoDB (plain `mongodb://`).
 * This means the full `createServer` → shutdown path cannot be integration-tested
 * with Docker for MongoDB.
 *
 * However, the `disconnectMongo` function itself accepts raw mongoose Connection
 * handles. This test creates real connections to Docker MongoDB, calls
 * `disconnectMongo`, and verifies the connections are actually closed — exercising
 * the same code that server.ts lines 625-628 call during shutdown.
 *
 * Prerequisites: `docker compose -f docker-compose.test.yml up -d --wait mongo`
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Connection } from 'mongoose';
import { disconnectMongo, getMongooseModule } from '../../src/lib/mongo';
import { connectTestMongo, disconnectTestServices, getTestAuthConn } from '../setup-docker';

const MONGO_URI = 'mongodb://localhost:27018/slingshot_test';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Verify Docker MongoDB is available
  await connectTestMongo();
  const authConn = getTestAuthConn();
  expect(authConn.readyState).toBe(1);
});

afterAll(async () => {
  await disconnectTestServices();
});

// =========================================================================
// disconnectMongo with real Docker connections
// =========================================================================

describe('disconnectMongo with live Docker connections', () => {
  test('closes both auth and app connections', async () => {
    const mg = getMongooseModule();

    // Create fresh connections to Docker MongoDB — these simulate what
    // createInfrastructure would have created
    const authConn = await mg.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    const appConn = await mg.createConnection(MONGO_URI, { autoIndex: false }).asPromise();

    // Verify both are connected
    expect(authConn.readyState).toBe(1);
    expect(appConn.readyState).toBe(1);

    // Verify they actually work
    await authConn.db!.collection('disconnect_test').insertOne({ test: true });
    await authConn.db!.collection('disconnect_test').drop();

    // Call the same disconnectMongo that server.ts shutdown calls
    await disconnectMongo(authConn, appConn);

    // Both connections should be disconnected (readyState 0 = disconnected)
    expect(authConn.readyState).toBe(0);
    expect(appConn.readyState).toBe(0);
  });

  test('handles null connections gracefully (no-op)', async () => {
    // server.ts calls disconnectMongo(ctx.mongo.auth, ctx.mongo.app) —
    // either could be null in some configurations
    await disconnectMongo(null, null);
    // No throw = success
  });

  test('handles one null and one live connection', async () => {
    const mg = getMongooseModule();
    const appConn = await mg.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    expect(appConn.readyState).toBe(1);

    await disconnectMongo(null, appConn);
    expect(appConn.readyState).toBe(0);
  });

  test('handles already-disconnected connections', async () => {
    const mg = getMongooseModule();
    const authConn = await mg.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    const appConn = await mg.createConnection(MONGO_URI, { autoIndex: false }).asPromise();

    // Disconnect first
    await authConn.close();
    await appConn.close();
    expect(authConn.readyState).toBe(0);
    expect(appConn.readyState).toBe(0);

    // Calling disconnectMongo on already-closed connections should not throw
    // (the readyState !== 0 guard in disconnectMongo prevents the double-close)
    await disconnectMongo(authConn, appConn);
    expect(authConn.readyState).toBe(0);
    expect(appConn.readyState).toBe(0);
  });
});
