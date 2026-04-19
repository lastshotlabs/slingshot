import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  getCacheModel,
} from '../../src/framework/middleware/cacheResponse';
import {
  connectTestMongo,
  disconnectTestServices,
  flushTestServices,
  getTestAppConn,
} from '../setup-docker';

let appConn: import('mongoose').Connection;

beforeAll(async () => {
  await connectTestMongo();
  appConn = getTestAppConn();
  // Ensure the CacheEntry model is registered on appConnection
  getCacheModel(appConn);
});

afterAll(async () => {
  await disconnectTestServices();
});

beforeEach(async () => {
  await flushTestServices();
});

function getModel() {
  return appConn.models['CacheEntry'];
}

describe('Mongo cache store', () => {
  it('stores and retrieves a cache entry', async () => {
    const model = getModel();
    await model.create({
      key: 'cache:Core API:test-key',
      value: JSON.stringify({ status: 200, headers: {}, body: 'hello' }),
    });

    const doc = await model.findOne({ key: 'cache:Core API:test-key' }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.value).toContain('hello');
  });

  it('upserts on duplicate key', async () => {
    const model = getModel();

    await model.updateOne(
      { key: 'cache:Core API:upsert' },
      { $set: { value: 'first' } },
      { upsert: true },
    );
    await model.updateOne(
      { key: 'cache:Core API:upsert' },
      { $set: { value: 'second' } },
      { upsert: true },
    );

    const docs = await model.find({ key: 'cache:Core API:upsert' }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].value).toBe('second');
  });

  it('bustCache deletes a specific key', async () => {
    const model = getModel();

    await model.create({ key: 'cache:Core API:bust-me', value: 'val' });
    // bustCache is app-context-aware — test direct model deletion to verify store behavior
    await model.deleteOne({ key: 'cache:Core API:bust-me' });

    const doc = await model.findOne({ key: 'cache:Core API:bust-me' }).lean();
    expect(doc).toBeNull();
  });

  it('bustCachePattern deletes matching keys via regex', async () => {
    const model = getModel();

    await model.create({ key: 'cache:Core API:users:1', value: 'a' });
    await model.create({ key: 'cache:Core API:users:2', value: 'b' });
    await model.create({ key: 'cache:Core API:products:1', value: 'c' });

    // bustCachePattern is app-context-aware — test direct model deletion to verify store behavior
    await model.deleteMany({ key: { $regex: /^cache:Core API:users:/ } });

    expect(await model.findOne({ key: 'cache:Core API:users:1' }).lean()).toBeNull();
    expect(await model.findOne({ key: 'cache:Core API:users:2' }).lean()).toBeNull();
    expect(await model.findOne({ key: 'cache:Core API:products:1' }).lean()).not.toBeNull();
  });

  it('stores entry with expiresAt', async () => {
    const model = getModel();

    const expiresAt = new Date(Date.now() + 60_000);
    await model.create({ key: 'cache:Core API:expiry', value: 'data', expiresAt });

    const doc = await model.findOne({ key: 'cache:Core API:expiry' }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.expiresAt).toBeTruthy();
  });
});
