import { describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Build mock mongoose connection and module
// ---------------------------------------------------------------------------

function makeMockConnection(readyState = 1) {
  return {
    readyState,
    openUri: mock(async () => {}),
    close: mock(async () => {}),
  };
}

const mockAuthConn = makeMockConnection();
const mockAppConn = makeMockConnection();

const mockMongoose = {
  createConnection: mock(() => {
    // Alternate between auth and app connections
    return mockMongoose._nextConn();
  }),
  _connections: [mockAuthConn, mockAppConn],
  _idx: 0,
  _nextConn() {
    const conn = this._connections[this._idx % this._connections.length];
    this._idx++;
    return conn;
  },
};

// Reset between tests
function resetMocks() {
  mockAuthConn.openUri.mockClear();
  mockAuthConn.close.mockClear();
  mockAppConn.openUri.mockClear();
  mockAppConn.close.mockClear();
  mockMongoose.createConnection.mockClear();
  mockMongoose._idx = 0;
}

mock.module('mongoose', () => ({
  default: mockMongoose,
}));

const mongoLib = await import(`../../src/lib/mongo.ts?mongo-unit=${Date.now()}`);
const {
  connectAppMongo,
  connectAuthMongo,
  connectMongo,
  disconnectMongo,
  getMongoFromApp,
  getMongooseModule,
} = mongoLib;

describe('getMongooseModule', () => {
  test('returns the mongoose module (lazy-loaded)', () => {
    const mg = getMongooseModule();
    expect(mg).toBeDefined();
    expect(typeof mg.createConnection).toBe('function');
  });
});

describe('connectAuthMongo', () => {
  test('creates a connection and opens URI', async () => {
    resetMocks();
    const result = await connectAuthMongo({
      user: 'admin',
      password: 'pass',
      host: 'cluster.mongodb.net',
      db: 'auth',
    });
    expect(result.authConn).toBeDefined();
    expect(result.mongoose).toBeDefined();
    expect(mockAuthConn.openUri).toHaveBeenCalledTimes(1);
  });

  test('builds a mongodb+srv URI with credentials', async () => {
    resetMocks();
    await connectAuthMongo({
      user: 'myuser',
      password: 'my:pass',
      host: 'myhost.mongodb.net',
      db: 'mydb',
    });
    const uri = (mockAuthConn.openUri.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? '';
    expect(uri).toContain('mongodb+srv://');
    expect(uri).toContain('myhost.mongodb.net');
    expect(uri).toContain('mydb');
    // Password with colon should be encoded
    expect(uri).toContain('my%3Apass');
  });
});

describe('connectAppMongo', () => {
  test('creates an app connection and opens URI', async () => {
    resetMocks();
    const result = await connectAppMongo({
      user: 'appuser',
      password: 'secret',
      host: 'app.mongodb.net',
      db: 'appdb',
    });
    expect(result.appConn).toBeDefined();
    expect(result.mongoose).toBeDefined();
    expect(mockAuthConn.openUri).toHaveBeenCalledTimes(1);
  });
});

describe('connectMongo', () => {
  test('creates both auth and app connections', async () => {
    resetMocks();
    const result = await connectMongo({
      user: 'u',
      password: 'p',
      host: 'h.mongodb.net',
      db: 'db',
    });
    expect(result.authConn).toBeDefined();
    expect(result.appConn).toBeDefined();
    expect(result.mongoose).toBeDefined();
    // Both connections should have openUri called
    expect(mockAuthConn.openUri).toHaveBeenCalledTimes(1);
    expect(mockAppConn.openUri).toHaveBeenCalledTimes(1);
  });
});

describe('disconnectMongo', () => {
  test('closes both connections when readyState is non-zero', async () => {
    const authConn = makeMockConnection(1); // readyState = 1 (connected)
    const appConn = makeMockConnection(1);
    await disconnectMongo(authConn as never, appConn as never);
    expect(authConn.close).toHaveBeenCalledTimes(1);
    expect(appConn.close).toHaveBeenCalledTimes(1);
  });

  test('does not close connections with readyState = 0', async () => {
    const authConn = makeMockConnection(0); // readyState = 0 (disconnected)
    const appConn = makeMockConnection(0);
    await disconnectMongo(authConn as never, appConn as never);
    expect(authConn.close).not.toHaveBeenCalled();
    expect(appConn.close).not.toHaveBeenCalled();
  });

  test('handles null connections gracefully', async () => {
    await disconnectMongo(null, null); // should not throw
  });

  test('closes only non-null connections', async () => {
    const authConn = makeMockConnection(1);
    await disconnectMongo(authConn as never, null);
    expect(authConn.close).toHaveBeenCalledTimes(1);
  });
});

describe('connectAuthMongo — URI with query params', () => {
  test('preserves query string from host', async () => {
    resetMocks();
    await connectAuthMongo({
      user: 'u',
      password: 'p',
      host: 'cluster.mongodb.net?retryWrites=true&w=majority',
      db: 'auth',
    });
    const uri = (mockAuthConn.openUri.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? '';
    expect(uri).toContain('?retryWrites=true&w=majority');
    expect(uri).toContain('/auth');
  });
});

describe('getMongoFromApp', () => {
  const CTX_SYM = Symbol.for('slingshot.context');

  test('returns auth and app connections from context', () => {
    const fakeAuth = { readyState: 1 };
    const fakeApp = { readyState: 1 };
    const app = { [CTX_SYM]: { mongo: { auth: fakeAuth, app: fakeApp } } };
    const result = getMongoFromApp(app as never);
    expect(result).not.toBeNull();
    expect(result!.auth).toBe(fakeAuth);
    expect(result!.app).toBe(fakeApp);
  });

  test('returns null when mongo is not on context', () => {
    const app = { [CTX_SYM]: {} };
    const result = getMongoFromApp(app as never);
    expect(result).toBeNull();
  });

  test('returns null for auth/app when they are null in context', () => {
    const app = { [CTX_SYM]: { mongo: { auth: null, app: null } } };
    const result = getMongoFromApp(app as never);
    expect(result).not.toBeNull();
    expect(result!.auth).toBeNull();
    expect(result!.app).toBeNull();
  });
});
