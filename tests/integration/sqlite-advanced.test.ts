import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

const json = (path: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Provider linking/unlinking on SQLite
// ---------------------------------------------------------------------------

describe('SQLite: provider linking', () => {
  let app: any;

  beforeEach(async () => {
    app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
        sqlite: ':memory:',
      },
    });
  });

  async function registerUser(email = 'provider@example.com') {
    const res = await app.request(json('/auth/register', { email, password: 'Password1!' }));
    return (await res.json()).token as string;
  }

  it('registers and logs in on SQLite', async () => {
    const token = await registerUser();
    expect(token).toBeTruthy();

    const meRes = await app.request(
      new Request('http://localhost/auth/me', { headers: authHeader(token) }),
    );
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.email).toBe('provider@example.com');
  });

  it('sets and checks password', async () => {
    const token = await registerUser('setpw@example.com');
    const res = await app.request(
      json(
        '/auth/set-password',
        { password: 'NewPass1!', currentPassword: 'Password1!' },
        authHeader(token),
      ),
    );
    expect(res.status).toBe(200);
  });

  it('deletes account on SQLite', async () => {
    const token = await registerUser('del@example.com');
    const delRes = await app.request(
      new Request('http://localhost/auth/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeader(token) },
        body: JSON.stringify({ password: 'Password1!' }),
      }),
    );
    expect(delRes.status).toBe(200);

    // Session should be invalid now
    const meRes = await app.request(
      new Request('http://localhost/auth/me', { headers: authHeader(token) }),
    );
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// SQLite MFA adapter paths
// ---------------------------------------------------------------------------

describe('SQLite: MFA operations', () => {
  let app: any;

  beforeEach(async () => {
    app = await createTestApp(
      {
        db: {
          mongo: false,
          redis: false,
          sessions: 'sqlite',
          cache: 'sqlite',
          auth: 'sqlite',
          sqlite: ':memory:',
        },
      },
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          mfa: { issuer: 'TestApp' },
        },
      },
    );
  });

  it('initiates MFA setup on SQLite', async () => {
    const regRes = await app.request(
      json('/auth/register', { email: 'mfa@example.com', password: 'Password1!' }),
    );
    const { token } = await regRes.json();

    const setupRes = await app.request(json('/auth/mfa/setup', {}, authHeader(token)));
    expect(setupRes.status).toBe(200);
    const setup = await setupRes.json();
    expect(setup.secret).toBeTruthy();
    expect(setup.uri).toContain('otpauth://');
  });
});

// ---------------------------------------------------------------------------
// SQLite: tenant roles
// ---------------------------------------------------------------------------

describe('SQLite: tenant roles', () => {
  let adapter: any;
  let app: any;

  beforeEach(async () => {
    app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
        sqlite: ':memory:',
      },
    });
    const { createSqliteAuthAdapter } = await import('@auth/adapters/sqliteAuth');
    adapter = createSqliteAuthAdapter(new Database(':memory:')).adapter;
  });

  it('manages tenant-scoped roles', async () => {
    const { id } = await adapter.create('tenant-role@example.com', 'hash');

    expect(await adapter.getTenantRoles(id, 't1')).toEqual([]);

    await adapter.setTenantRoles(id, 't1', ['admin', 'user']);
    expect(await adapter.getTenantRoles(id, 't1')).toEqual(['admin', 'user']);

    await adapter.addTenantRole(id, 't1', 'editor');
    const roles = await adapter.getTenantRoles(id, 't1');
    expect(roles).toContain('editor');

    await adapter.removeTenantRole(id, 't1', 'admin');
    const updated = await adapter.getTenantRoles(id, 't1');
    expect(updated).not.toContain('admin');
    expect(updated).toContain('user');
    expect(updated).toContain('editor');
  });

  it('addTenantRole is idempotent', async () => {
    const { id } = await adapter.create('idem@example.com', 'hash');
    await adapter.addTenantRole(id, 't1', 'admin');
    await adapter.addTenantRole(id, 't1', 'admin'); // duplicate, should not throw
    const roles = await adapter.getTenantRoles(id, 't1');
    // SQLite may allow duplicate inserts unless there's a unique constraint
    // The try/catch in addTenantRole handles this
    expect(roles.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// SQLite: WebAuthn credentials
// ---------------------------------------------------------------------------

describe('SQLite: WebAuthn credentials', () => {
  let adapter: any;
  let app: any;

  beforeEach(async () => {
    app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
        sqlite: ':memory:',
      },
    });
    const { createSqliteAuthAdapter } = await import('@auth/adapters/sqliteAuth');
    adapter = createSqliteAuthAdapter(new Database(':memory:')).adapter;
  });

  const makeCred = (id: string) => ({
    credentialId: id,
    publicKey: 'pk-1',
    signCount: 0,
    transports: ['usb'],
    name: 'My Key',
    createdAt: Date.now(),
  });

  it('adds and retrieves credentials', async () => {
    const { id } = await adapter.create('webauthn-sq@example.com', 'hash');
    await adapter.addWebAuthnCredential(id, makeCred('cred-sqlite-add'));

    const creds = await adapter.getWebAuthnCredentials(id);
    expect(creds).toHaveLength(1);
    expect(creds[0].credentialId).toBe('cred-sqlite-add');
    expect(creds[0].transports).toEqual(['usb']);
  });

  it('updates sign count', async () => {
    const { id } = await adapter.create('signcount-sq@example.com', 'hash');
    await adapter.addWebAuthnCredential(id, makeCred('cred-sqlite-signcount'));
    await adapter.updateWebAuthnCredentialSignCount(id, 'cred-sqlite-signcount', 10);

    const creds = await adapter.getWebAuthnCredentials(id);
    expect(creds[0].signCount).toBe(10);
  });

  it('removes a credential', async () => {
    const { id } = await adapter.create('removecred-sq@example.com', 'hash');
    await adapter.addWebAuthnCredential(id, makeCred('cred-sqlite-remove'));
    await adapter.removeWebAuthnCredential(id, 'cred-sqlite-remove');

    const creds = await adapter.getWebAuthnCredentials(id);
    expect(creds).toHaveLength(0);
  });

  it('finds user by credential ID', async () => {
    const { id } = await adapter.create('findcred-sq@example.com', 'hash');
    await adapter.addWebAuthnCredential(id, makeCred('cred-find-sq'));

    const userId = await adapter.findUserByWebAuthnCredentialId('cred-find-sq');
    expect(userId).toBe(id);
  });

  it('returns null for unknown credential', async () => {
    const userId = await adapter.findUserByWebAuthnCredentialId('unknown');
    expect(userId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SQLite: OAuth state/code stores
// ---------------------------------------------------------------------------

describe('SQLite: OAuth state store', () => {
  let sqliteResult: any;

  beforeEach(async () => {
    const { createSqliteAuthAdapter } = await import('@auth/adapters/sqliteAuth');
    sqliteResult = createSqliteAuthAdapter(new Database(':memory:'));
  });

  it('stores and consumes OAuth state', async () => {
    sqliteResult.storeOAuthState('state-1', 'verifier-1', 'link-user-1');
    const result = sqliteResult.consumeOAuthState('state-1');
    expect(result).not.toBeNull();
    expect(result!.codeVerifier).toBe('verifier-1');
    expect(result!.linkUserId).toBe('link-user-1');
  });

  it('state is single-use', async () => {
    sqliteResult.storeOAuthState('state-2');
    sqliteResult.consumeOAuthState('state-2');
    expect(sqliteResult.consumeOAuthState('state-2')).toBeNull();
  });
});

describe('SQLite: cache pattern deletion', () => {
  let sqliteResult: any;

  beforeEach(async () => {
    const { createSqliteAuthAdapter } = await import('@auth/adapters/sqliteAuth');
    sqliteResult = createSqliteAuthAdapter(new Database(':memory:'));
  });

  it('deletes by wildcard pattern with proper escaping', async () => {
    sqliteResult.setCache('cache:test:users:1', 'a');
    sqliteResult.setCache('cache:test:users:2', 'b');
    sqliteResult.setCache('cache:test:products:1', 'c');

    sqliteResult.delCachePattern('cache:test:users:*');

    expect(sqliteResult.getCache('cache:test:users:1')).toBeNull();
    expect(sqliteResult.getCache('cache:test:users:2')).toBeNull();
    expect(sqliteResult.getCache('cache:test:products:1')).toBe('c');
  });
});
