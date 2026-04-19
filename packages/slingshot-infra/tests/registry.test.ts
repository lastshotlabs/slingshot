import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createRegistryFromConfig } from '../src/registry/createRegistryFromConfig';
import { createLocalRegistry } from '../src/registry/localRegistry';
import { parseRegistryUrl } from '../src/registry/parseRegistryUrl';
import { createPostgresRegistry } from '../src/registry/postgresRegistry';

// ---------------------------------------------------------------------------
// createLocalRegistry
// ---------------------------------------------------------------------------

describe('createLocalRegistry', () => {
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'slingshot-test-registry-'));
  }

  it('read returns null when file does not exist', async () => {
    const dir = makeTempDir();
    try {
      const registry = createLocalRegistry({ path: join(dir, 'reg.json') });
      const doc = await registry.read();
      expect(doc).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initialize creates an empty document', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'reg.json');
    try {
      const registry = createLocalRegistry({ path });
      await registry.initialize();
      const doc = await registry.read();
      expect(doc).toBeDefined();
      expect(doc!.services).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('write persists document and read returns it', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'reg.json');
    try {
      const registry = createLocalRegistry({ path });
      await registry.initialize();
      const doc = await registry.read();
      doc!.services = { api: { stack: 'main', stages: {} } };
      await registry.write(doc!);
      const reloaded = await registry.read();
      expect(reloaded!.services.api).toBeDefined();
      expect(reloaded!.services.api.stack).toBe('main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('write rejects stale etag', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'reg.json');
    try {
      const registry = createLocalRegistry({ path });
      await registry.initialize();

      // Read to capture the etag via lock
      const lock = await registry.lock();
      const doc = await registry.read();
      const staleEtag = lock.etag;

      // Simulate external modification
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      raw._modified = true;
      writeFileSync(path, JSON.stringify(raw), 'utf-8');

      // Writing with the stale etag should fail
      await expect(registry.write(doc!, staleEtag)).rejects.toThrow('modified by another process');
      await lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lock returns an object with release and etag', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'reg.json');
    try {
      const registry = createLocalRegistry({ path });
      await registry.initialize();
      const lock = await registry.lock();
      expect(lock.release).toBeFunction();
      expect(typeof lock.etag).toBe('string');
      await lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates parent directories when needed', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'nested', 'deep', 'reg.json');
    try {
      const registry = createLocalRegistry({ path });
      await registry.initialize();
      const doc = await registry.read();
      expect(doc).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createPostgresRegistry — table name validation
// ---------------------------------------------------------------------------

describe('createPostgresRegistry table name guard', () => {
  it('accepts valid identifier', () => {
    expect(() =>
      createPostgresRegistry({ connectionString: 'postgres://localhost/db', table: 'my_registry' }),
    ).not.toThrow();
  });

  it('accepts default table name (no table option)', () => {
    expect(() =>
      createPostgresRegistry({ connectionString: 'postgres://localhost/db' }),
    ).not.toThrow();
  });

  it('rejects table name with SQL injection characters', () => {
    expect(() =>
      createPostgresRegistry({
        connectionString: 'postgres://localhost/db',
        table: "'; DROP TABLE users; --",
      }),
    ).toThrow('Invalid Postgres registry table name');
  });

  it('rejects table name starting with a digit', () => {
    expect(() =>
      createPostgresRegistry({ connectionString: 'postgres://localhost/db', table: '1table' }),
    ).toThrow('Invalid Postgres registry table name');
  });

  it('rejects table name with spaces', () => {
    expect(() =>
      createPostgresRegistry({ connectionString: 'postgres://localhost/db', table: 'my table' }),
    ).toThrow('Invalid Postgres registry table name');
  });

  it('rejects empty table name', () => {
    expect(() =>
      createPostgresRegistry({ connectionString: 'postgres://localhost/db', table: '' }),
    ).toThrow('Invalid Postgres registry table name');
  });
});

// ---------------------------------------------------------------------------
// parseRegistryUrl
// ---------------------------------------------------------------------------

describe('parseRegistryUrl', () => {
  it('parses s3:// URLs', () => {
    const config = parseRegistryUrl('s3://my-bucket');
    expect(config.provider).toBe('s3');
    expect(config.bucket).toBe('my-bucket');
  });

  it('parses redis:// URLs', () => {
    const config = parseRegistryUrl('redis://localhost:6379');
    expect(config.provider).toBe('redis');
    expect(config.url).toBe('redis://localhost:6379');
  });

  it('parses rediss:// URLs', () => {
    const config = parseRegistryUrl('rediss://secure-host:6380');
    expect(config.provider).toBe('redis');
    expect(config.url).toBe('rediss://secure-host:6380');
  });

  it('parses postgres:// URLs', () => {
    const config = parseRegistryUrl('postgres://localhost/mydb');
    expect(config.provider).toBe('postgres');
    expect(config.connectionString).toBe('postgres://localhost/mydb');
  });

  it('parses postgresql:// URLs', () => {
    const config = parseRegistryUrl('postgresql://localhost/mydb');
    expect(config.provider).toBe('postgres');
    expect(config.connectionString).toBe('postgresql://localhost/mydb');
  });

  it('falls back to local for filesystem paths', () => {
    const config = parseRegistryUrl('.slingshot/registry.json');
    expect(config.provider).toBe('local');
    expect(config.path).toBe('.slingshot/registry.json');
  });

  it('falls back to local for absolute paths', () => {
    const config = parseRegistryUrl('/var/data/registry.json');
    expect(config.provider).toBe('local');
    expect(config.path).toBe('/var/data/registry.json');
  });
});

// ---------------------------------------------------------------------------
// createRegistryFromConfig
// ---------------------------------------------------------------------------

describe('createRegistryFromConfig', () => {
  it('creates a local registry with valid config', () => {
    const registry = createRegistryFromConfig({
      provider: 'local',
      path: '/tmp/test.json',
    });
    expect(registry).toBeDefined();
    expect(registry.read).toBeFunction();
  });

  it('throws for S3 without bucket', () => {
    const s3Config = { provider: 's3' };
    expect(() => createRegistryFromConfig(s3Config as never)).toThrow('bucket');
  });

  it('throws for Redis without url', () => {
    const redisConfig = { provider: 'redis' };
    expect(() => createRegistryFromConfig(redisConfig as never)).toThrow('url');
  });

  it('throws for Postgres without connectionString', () => {
    const pgConfig = { provider: 'postgres' };
    expect(() => createRegistryFromConfig(pgConfig as never)).toThrow(
      'connectionString',
    );
  });

  it('throws for local without path', () => {
    const localConfig = { provider: 'local' };
    expect(() => createRegistryFromConfig(localConfig as never)).toThrow('path');
  });
});
