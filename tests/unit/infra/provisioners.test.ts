import { beforeEach, describe, expect, it } from 'bun:test';
import { createDocumentDbProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/documentdb';
import { createKafkaProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/kafka';
import { createMongoProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/mongo';
import { createPostgresProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/postgres';
import { createRedisProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/redis';
import type { ResourceProvisionerContext } from '../../../packages/slingshot-infra/src/types/resource';

function createCtx(overrides?: Partial<ResourceProvisionerContext>): ResourceProvisionerContext {
  return {
    resourceName: 'test-resource',
    config: { type: 'postgres', provision: false },
    stageName: 'prod',
    region: 'us-east-1',
    platform: 'testorg',
    ...overrides,
  };
}

describe('createPostgresProvisioner', () => {
  const provisioner = createPostgresProvisioner();

  it('has correct resourceType', () => {
    expect(provisioner.resourceType).toBe('postgres');
  });

  it('provision with external connection returns connection env', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: {
          type: 'postgres',
          provision: false,
          connection: {
            url: 'postgres://user:pass@host:5432/db',
            host: 'host',
            port: '5432',
            user: 'user',
            password: 'pass',
            database: 'db',
          },
        },
      }),
    );

    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.DATABASE_URL).toBe('postgres://user:pass@host:5432/db');
    expect(result.connectionEnv.PGHOST).toBe('host');
    expect(result.connectionEnv.PGPORT).toBe('5432');
    expect(result.connectionEnv.PGUSER).toBe('user');
    expect(result.connectionEnv.PGPASSWORD).toBe('pass');
    expect(result.connectionEnv.PGDATABASE).toBe('db');
  });

  it.todo(
    'provision with provision:true returns placeholder — requires AWS credentials',
    async () => {
      const result = await provisioner.provision(
        createCtx({
          config: { type: 'postgres', provision: true },
        }),
      );

      expect(result.status).toBe('provisioned');
      expect(result.outputs.engine).toBe('postgres');
      expect(result.connectionEnv.PGPORT).toBe('5432');
      expect(result.connectionEnv.PGDATABASE).toBe('testorg');
    },
  );

  it.todo(
    'provision with stage overrides applies instance class — requires AWS credentials',
    async () => {
      const result = await provisioner.provision(
        createCtx({
          config: {
            type: 'postgres',
            provision: true,
            stages: { prod: { instanceClass: 'db.t3.large', storageGb: 100 } },
          },
        }),
      );

      expect(result.outputs.instanceClass).toBe('db.t3.large');
      expect(result.outputs.storageGb).toBe('100');
    },
  );

  it('getConnectionEnv returns env from ResourceOutput', () => {
    const output = {
      status: 'provisioned' as const,
      outputs: {},
      connectionEnv: {
        DATABASE_URL: 'pg://db',
        PGHOST: 'localhost',
        PGPORT: '5432',
        PGUSER: '',
        PGPASSWORD: '',
        PGDATABASE: '',
      },
    };

    const env = provisioner.getConnectionEnv(output);
    expect(env.DATABASE_URL).toBe('pg://db');
    expect(env.PGHOST).toBe('localhost');
  });

  it('provision with empty connection defaults to empty strings', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: { type: 'postgres', provision: false },
      }),
    );

    expect(result.connectionEnv.DATABASE_URL).toBe('');
    expect(result.connectionEnv.PGHOST).toBe('');
    expect(result.connectionEnv.PGPORT).toBe('5432');
  });
});

describe('createRedisProvisioner', () => {
  const provisioner = createRedisProvisioner();

  it('has correct resourceType', () => {
    expect(provisioner.resourceType).toBe('redis');
  });

  it('provision with external connection returns connection env', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: {
          type: 'redis',
          provision: false,
          connection: {
            url: 'redis://pass@host:6379',
            host: 'host',
            port: '6379',
            password: 'pass',
          },
        },
      }),
    );

    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.REDIS_URL).toBe('redis://pass@host:6379');
    expect(result.connectionEnv.REDIS_HOST).toBe('host');
    expect(result.connectionEnv.REDIS_PORT).toBe('6379');
    expect(result.connectionEnv.REDIS_PASSWORD).toBe('pass');
  });

  it.todo(
    'provision with provision:true returns placeholder — requires AWS credentials',
    async () => {
      const result = await provisioner.provision(
        createCtx({
          config: { type: 'redis', provision: true },
        }),
      );

      expect(result.status).toBe('provisioned');
      expect(result.outputs.engine).toBe('redis');
      expect(result.connectionEnv.REDIS_PORT).toBe('6379');
      expect(result.connectionEnv.REDIS_URL).toBe('');
    },
  );

  it.todo(
    'provision with stage overrides applies instance class — requires AWS credentials',
    async () => {
      const result = await provisioner.provision(
        createCtx({
          config: {
            type: 'redis',
            provision: true,
            stages: { prod: { instanceClass: 'cache.t3.medium' } },
          },
        }),
      );

      expect(result.outputs.instanceClass).toBe('cache.t3.medium');
    },
  );

  it('getConnectionEnv returns env from ResourceOutput', () => {
    const output = {
      status: 'provisioned' as const,
      outputs: {},
      connectionEnv: {
        REDIS_URL: 'redis://x',
        REDIS_HOST: 'x',
        REDIS_PORT: '6379',
        REDIS_PASSWORD: '',
      },
    };

    const env = provisioner.getConnectionEnv(output);
    expect(env.REDIS_URL).toBe('redis://x');
  });
});

describe('createKafkaProvisioner', () => {
  const provisioner = createKafkaProvisioner();

  it('has correct resourceType', () => {
    expect(provisioner.resourceType).toBe('kafka');
  });

  it('provision with external connection returns brokers env', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: {
          type: 'kafka',
          provision: false,
          connection: { brokers: 'broker1:9092,broker2:9092' },
        },
      }),
    );

    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.KAFKA_BROKERS).toBe('broker1:9092,broker2:9092');
  });

  it.todo(
    'provision with provision:true returns placeholder — requires AWS credentials',
    async () => {
      const result = await provisioner.provision(
        createCtx({
          config: { type: 'kafka', provision: true },
        }),
      );

      expect(result.status).toBe('provisioned');
      expect(result.outputs.engine).toBe('kafka');
      expect(result.connectionEnv.KAFKA_BROKERS).toBe('');
    },
  );

  it('getConnectionEnv returns env from ResourceOutput', () => {
    const output = {
      status: 'provisioned' as const,
      outputs: {},
      connectionEnv: { KAFKA_BROKERS: 'b1:9092' },
    };

    const env = provisioner.getConnectionEnv(output);
    expect(env.KAFKA_BROKERS).toBe('b1:9092');
  });

  it('provision with no connection defaults brokers to empty', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: { type: 'kafka', provision: false },
      }),
    );

    expect(result.connectionEnv.KAFKA_BROKERS).toBe('');
  });
});

// ---------------------------------------------------------------------------
// DocumentDB provisioner
// ---------------------------------------------------------------------------

describe('createDocumentDbProvisioner', () => {
  const provisioner = createDocumentDbProvisioner();

  it('has correct resourceType', () => {
    expect(provisioner.resourceType).toBe('documentdb');
  });

  it('provision with provision:false returns manual connection env', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: {
          type: 'documentdb',
          provision: false,
          connection: {
            host: 'docdb.cluster.us-east-1.docdb.amazonaws.com',
            port: '27017',
            username: 'admin',
            password: 'secret',
            database: 'mydb',
          },
        },
      }),
    );

    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.DOCUMENTDB_HOST).toBe(
      'docdb.cluster.us-east-1.docdb.amazonaws.com',
    );
    expect(result.connectionEnv.DOCUMENTDB_PORT).toBe('27017');
    expect(result.connectionEnv.DOCUMENTDB_USER).toBe('admin');
    expect(result.connectionEnv.DOCUMENTDB_PASSWORD).toBe('secret');
    expect(result.connectionEnv.DOCUMENTDB_DB).toBe('mydb');
  });

  it('provision with provision:false builds URL with tls=true&retryWrites=false', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: {
          type: 'documentdb',
          provision: false,
          connection: {
            host: 'docdb.host',
            port: '27017',
            username: 'admin',
            password: 'pass',
            database: 'testdb',
          },
        },
      }),
    );

    expect(result.connectionEnv.DOCUMENTDB_URL).toContain('?tls=true&retryWrites=false');
    expect(result.connectionEnv.DOCUMENTDB_URL).toContain('mongodb://');
  });

  it('provision with empty connection defaults port to 27017', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: { type: 'documentdb', provision: false },
      }),
    );

    expect(result.connectionEnv.DOCUMENTDB_PORT).toBe('27017');
    expect(result.connectionEnv.DOCUMENTDB_URL).toBe('');
    expect(result.connectionEnv.DOCUMENTDB_HOST).toBe('');
  });

  it('destroy with provision:false is a no-op', async () => {
    await expect(
      provisioner.destroy(
        createCtx({
          config: { type: 'documentdb', provision: false },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('getConnectionEnv returns env from ResourceOutput', () => {
    const output = {
      status: 'provisioned' as const,
      outputs: {},
      connectionEnv: {
        DOCUMENTDB_URL: 'mongodb://admin:pass@host:27017/db?tls=true&retryWrites=false',
        DOCUMENTDB_HOST: 'host',
        DOCUMENTDB_PORT: '27017',
        DOCUMENTDB_USER: 'admin',
        DOCUMENTDB_PASSWORD: 'pass',
        DOCUMENTDB_DB: 'db',
      },
    };

    const env = provisioner.getConnectionEnv(output);
    expect(env.DOCUMENTDB_URL).toBe(
      'mongodb://admin:pass@host:27017/db?tls=true&retryWrites=false',
    );
    expect(env.DOCUMENTDB_HOST).toBe('host');
  });
});

// ---------------------------------------------------------------------------
// MongoDB Atlas provisioner
// ---------------------------------------------------------------------------

describe('createMongoProvisioner', () => {
  const provisioner = createMongoProvisioner();

  beforeEach(() => {
    delete process.env.ATLAS_PUBLIC_KEY;
    delete process.env.ATLAS_PRIVATE_KEY;
  });

  it('has correct resourceType', () => {
    expect(provisioner.resourceType).toBe('mongo');
  });

  it('provision with provision:false returns manual connection env', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: {
          type: 'mongo',
          provision: false,
          connection: {
            host: 'cluster0.abc123.mongodb.net',
            username: 'user',
            password: 'pass',
            database: 'mydb',
          },
        },
      }),
    );

    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.MONGO_HOST).toBe('cluster0.abc123.mongodb.net');
    expect(result.connectionEnv.MONGO_USER).toBe('user');
    expect(result.connectionEnv.MONGO_PASSWORD).toBe('pass');
    expect(result.connectionEnv.MONGO_DB).toBe('mydb');
  });

  it('provision with provision:false builds mongodb+srv URL', async () => {
    const result = await provisioner.provision(
      createCtx({
        config: {
          type: 'mongo',
          provision: false,
          connection: {
            host: 'cluster0.abc.mongodb.net',
            username: 'admin',
            password: 'secret',
            database: 'testdb',
          },
        },
      }),
    );

    expect(result.connectionEnv.MONGO_URL).toContain('mongodb+srv://');
    expect(result.connectionEnv.MONGO_URL).toContain('cluster0.abc.mongodb.net');
  });

  it('provision with provision:true and missing Atlas config throws descriptive error', async () => {
    await expect(
      provisioner.provision(
        createCtx({
          config: {
            type: 'mongo',
            provision: true,
          },
        }),
      ),
    ).rejects.toThrow(
      'MongoDB Atlas provisioning requires ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY in secrets and atlas.orgId, atlas.projectId in resource config.',
    );
  });

  it('provision with provision:true and missing env keys throws descriptive error', async () => {
    await expect(
      provisioner.provision(
        createCtx({
          config: {
            type: 'mongo',
            provision: true,
          },
        }),
      ),
    ).rejects.toThrow('MongoDB Atlas provisioning requires');
  });

  it('provision with provision:true and missing projectId throws descriptive error', async () => {
    process.env.ATLAS_PUBLIC_KEY = 'pub';
    process.env.ATLAS_PRIVATE_KEY = 'priv';

    await expect(
      provisioner.provision(
        createCtx({
          config: {
            type: 'mongo',
            provision: true,
          },
        }),
      ),
    ).rejects.toThrow('MongoDB Atlas provisioning requires');
  });

  it('destroy with provision:false is a no-op', async () => {
    await expect(
      provisioner.destroy(
        createCtx({
          config: { type: 'mongo', provision: false },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('destroy with provision:true and missing Atlas config throws descriptive error', async () => {
    await expect(
      provisioner.destroy(
        createCtx({
          config: {
            type: 'mongo',
            provision: true,
          },
        }),
      ),
    ).rejects.toThrow('MongoDB Atlas provisioning requires');
  });

  it('getConnectionEnv returns env from ResourceOutput', () => {
    const output = {
      status: 'provisioned' as const,
      outputs: {},
      connectionEnv: {
        MONGO_URL: 'mongodb+srv://user:pass@host/db',
        MONGO_HOST: 'host',
        MONGO_USER: 'user',
        MONGO_PASSWORD: 'pass',
        MONGO_DB: 'db',
      },
    };

    const env = provisioner.getConnectionEnv(output);
    expect(env.MONGO_URL).toBe('mongodb+srv://user:pass@host/db');
    expect(env.MONGO_HOST).toBe('host');
  });
});
