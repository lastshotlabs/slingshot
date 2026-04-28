/**
 * Adapter parity tests — MongoDB.
 *
 * Runs the shared parity suite against the Mongo adapter to verify behavioral
 * equivalence with Memory and SQLite. Requires Docker (port 27018).
 */
import { createMongoAuthAdapter } from '@auth/adapters/mongoAuth';
import { afterAll, beforeAll, beforeEach } from 'bun:test';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import { getMongooseModule } from '../../src/lib/mongo';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAuthConn,
} from '../setup-docker';
import { adapterParitySuite } from '../shared/adapter-parity';

let adapter: AuthAdapter;
const MONGO_PARITY_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  await connectTestMongo();
  adapter = createMongoAuthAdapter(getTestAuthConn(), getMongooseModule());
}, MONGO_PARITY_TIMEOUT_MS);

afterAll(async () => {
  await disconnectTestServices();
}, MONGO_PARITY_TIMEOUT_MS);

beforeEach(async () => {
  await flushTestServices();
}, MONGO_PARITY_TIMEOUT_MS);

adapterParitySuite({
  name: 'mongo',
  getAdapter: () => adapter,
});
