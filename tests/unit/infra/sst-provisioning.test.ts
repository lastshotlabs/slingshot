import { describe, expect, it, mock } from 'bun:test';
import {
  type ResourceProvisionEntry,
  generateResourceSstConfig,
  getResourceOutputKey,
} from '../../../packages/slingshot-infra/src/resource/generateResourceSst';
import {
  type ProcessRunner,
  destroyViaSst,
  parseSstOutputs,
  provisionViaSst,
} from '../../../packages/slingshot-infra/src/resource/provisionViaSst';
import { createKafkaProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/kafka';
import { createPostgresProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/postgres';
import { createRedisProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/redis';
import type { ResourceProvisionerContext } from '../../../packages/slingshot-infra/src/types/resource';

// Re-register the real implementations so that the no-op mock from
// provisioners-success.test.ts (which runs alphabetically before this file)
// does not pollute these tests.
mock.module('../../../packages/slingshot-infra/src/resource/provisionViaSst', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } =
    require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path');

  function parseSstOutputsFn(stdout: string): Record<string, string> {
    const outputs: Record<string, string> = {};
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*"outputs"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { outputs?: Record<string, unknown> };
        if (parsed.outputs && typeof parsed.outputs === 'object') {
          for (const [key, value] of Object.entries(parsed.outputs)) {
            outputs[key] = String(value);
          }
          return outputs;
        }
      }
    } catch {
      // fall through to line-based parsing
    }
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*(\w+)\s*=\s*(.+)$/);
      if (match) outputs[match[1].trim()] = match[2].trim();
    }
    return outputs;
  }

  type PR = (
    cmd: string,
    args: string[],
    opts: { cwd: string; encoding: string; env: Record<string, string | undefined> },
  ) => import('node:child_process').SpawnSyncReturns<string>;

  interface ProvOpts {
    resourceName: string;
    stageName: string;
    region: string;
    platform: string;
    sstConfig: string;
    appRoot?: string;
    processRunner?: PR;
  }
  interface DestOpts {
    resourceName: string;
    stageName: string;
    region: string;
    sstConfig: string;
    appRoot?: string;
    processRunner?: PR;
  }

  async function provisionViaSstFn(opts: ProvOpts) {
    const tempDir = join(tmpdir(), `slingshot-resource-${opts.resourceName}-${Date.now()}`);
    const run: PR =
      opts.processRunner ??
      ((cmd, args, o) => spawnSync(cmd, args, { ...o, encoding: 'utf-8' as const }));
    try {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, 'sst.config.ts'), opts.sstConfig, 'utf-8');
      const appRoot = opts.appRoot ?? process.cwd();
      for (const file of ['package.json', 'bun.lock', 'bun.lockb']) {
        const src = join(appRoot, file);
        if (existsSync(src)) copyFileSync(src, join(tempDir, file));
      }
      const result = run('bunx', ['sst', 'deploy', '--stage', opts.stageName], {
        cwd: tempDir,
        encoding: 'utf-8',
        env: { ...process.env, AWS_REGION: opts.region },
      });
      if (result.status !== 0) {
        const stderr = result.stderr ?? '';
        const stdout = result.stdout ?? '';
        return {
          success: false,
          outputs: {},
          error: `SST deploy exited with code ${result.status}: ${stderr || stdout}`.trim(),
        };
      }
      return { success: true, outputs: parseSstOutputsFn(result.stdout ?? '') };
    } catch (err) {
      return {
        success: false,
        outputs: {},
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  async function destroyViaSstFn(opts: DestOpts) {
    const tempDir = join(tmpdir(), `slingshot-destroy-${opts.resourceName}-${Date.now()}`);
    const run = opts.processRunner ?? spawnSync;
    try {
      mkdirSync(tempDir, { recursive: true });
      if (opts.sstConfig) writeFileSync(join(tempDir, 'sst.config.ts'), opts.sstConfig, 'utf-8');
      const appRoot = opts.appRoot ?? process.cwd();
      for (const file of ['package.json', 'bun.lock', 'bun.lockb']) {
        const src = join(appRoot, file);
        if (existsSync(src)) copyFileSync(src, join(tempDir, file));
      }
      const result = run('bunx', ['sst', 'destroy', '--stage', opts.stageName], {
        cwd: tempDir,
        encoding: 'utf-8',
        env: { ...process.env, AWS_REGION: opts.region },
      });
      if (result.status !== 0) {
        const stderr = result.stderr ?? '';
        const stdout = result.stdout ?? '';
        throw new Error(
          `SST destroy exited with code ${result.status}: ${stderr || stdout}`.trim(),
        );
      }
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  return {
    parseSstOutputs: parseSstOutputsFn,
    provisionViaSst: provisionViaSstFn,
    destroyViaSst: destroyViaSstFn,
  };
});

// ---------------------------------------------------------------------------
// Helper: create a fake process runner
// ---------------------------------------------------------------------------

function createMockRunner(
  behavior: 'success' | 'failure',
  stdout = '',
  stderr = '',
): { runner: ProcessRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];

  const runner: ProcessRunner = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (behavior === 'success') {
      return {
        status: 0,
        stdout: stdout || '  dbHost = my-host.rds.amazonaws.com\n  dbPort = 5432\n',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      };
    }
    return {
      status: 1,
      stdout: '',
      stderr: stderr || 'Error: Access denied',
      pid: 0,
      output: [],
      signal: null,
    };
  };

  return { runner, calls };
}

// ---------------------------------------------------------------------------
// SST config generation tests
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig', () => {
  const opts = { org: 'testorg', region: 'us-east-1', stageName: 'dev' };

  it('generates postgres resource with sst.aws.Postgres', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'db', type: 'postgres', instanceClass: 'db.t3.micro', storageGb: 20 },
    ];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('sst.aws.Postgres');
    expect(config).toContain('"Db"');
    expect(config).toContain('ACU');
    expect(config).toContain('vpc');
    expect(config).toContain('testorg-resources');
    expect(config).toContain('us-east-1');
    expect(config).toContain('dbHost');
    expect(config).toContain('dbPort');
    expect(config).toContain('dbUsername');
    expect(config).toContain('dbPassword');
    expect(config).toContain('dbDatabase');
  });

  it('generates redis resource with sst.aws.Redis', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'cache', type: 'redis', instanceClass: 'cache.t3.micro' },
    ];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('sst.aws.Redis');
    expect(config).toContain('"Cache"');
    expect(config).toContain('cacheHost');
    expect(config).toContain('cachePort');
  });

  it('generates kafka resource with aws.msk.Cluster', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'events', type: 'kafka', instanceClass: 'kafka.t3.small', storageGb: 100 },
    ];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('aws.msk.Cluster');
    expect(config).toContain('"Events"');
    expect(config).toContain('kafka.t3.small');
    expect(config).toContain('volumeSize: 100');
    expect(config).toContain('eventsBrokers');
  });

  it('generates mongo resource with aws.docdb.Cluster', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'docs', type: 'mongo', instanceClass: 'db.t3.medium' },
    ];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('aws.docdb.Cluster');
    expect(config).toContain('"Docs"');
    expect(config).toContain('db.t3.medium');
    expect(config).toContain('docsEndpoint');
    expect(config).toContain('docsPort');
  });

  it('generates documentdb resource with secret-backed outputs', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'docs', type: 'documentdb', instanceClass: 'db.t3.medium' },
    ];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('aws.docdb.Cluster');
    expect(config).toContain('const docsPassword = new sst.Secret("DocsPassword")');
    expect(config).toContain('docsHost');
    expect(config).toContain('docsPort');
    expect(config).toContain('docsUsername');
    expect(config).toContain('docsPassword');
    expect(config).toContain('docsDatabase');
  });

  it('generates multiple resources in one config', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'db', type: 'postgres', instanceClass: 'db.t3.micro' },
      { name: 'cache', type: 'redis' },
    ];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('sst.aws.Postgres');
    expect(config).toContain('sst.aws.Redis');
    expect(config).toContain('dbHost');
    expect(config).toContain('cacheHost');
  });

  it('maps instance classes to ACU ranges', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'db', type: 'postgres', instanceClass: 'db.r5.xlarge' },
    ];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('"4 ACU"');
    expect(config).toContain('"32 ACU"');
  });

  it('is deterministic — same input produces same output', () => {
    const entries: ResourceProvisionEntry[] = [
      { name: 'db', type: 'postgres', instanceClass: 'db.t3.micro' },
    ];
    const first = generateResourceSstConfig(entries, opts);
    const second = generateResourceSstConfig(entries, opts);
    expect(first).toBe(second);
  });

  it('contains section markers for each resource', () => {
    const entries: ResourceProvisionEntry[] = [{ name: 'db', type: 'postgres' }];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('--- section:resource-db ---');
    expect(config).toContain('--- end:resource-db ---');
  });

  it('uses shared output-key generation for sanitized resource names', () => {
    expect(getResourceOutputKey('my-events', 'Brokers')).toBe('myeventsBrokers');
    expect(getResourceOutputKey('cache_01', 'Host')).toBe('cache01Host');
  });

  it('includes VPC section', () => {
    const entries: ResourceProvisionEntry[] = [{ name: 'db', type: 'postgres' }];
    const config = generateResourceSstConfig(entries, opts);

    expect(config).toContain('sst.aws.Vpc');
    expect(config).toContain('--- section:vpc ---');
    expect(config).toContain('--- end:vpc ---');
  });
});

// ---------------------------------------------------------------------------
// parseSstOutputs tests
// ---------------------------------------------------------------------------

describe('parseSstOutputs', () => {
  it('parses key = value lines', () => {
    const stdout = `
  dbHost = my-rds-instance.abc.us-east-1.rds.amazonaws.com
  dbPort = 5432
  dbUsername = postgres
`;
    const outputs = parseSstOutputs(stdout);
    expect(outputs.dbHost).toBe('my-rds-instance.abc.us-east-1.rds.amazonaws.com');
    expect(outputs.dbPort).toBe('5432');
    expect(outputs.dbUsername).toBe('postgres');
  });

  it('parses JSON output with outputs key', () => {
    const stdout = JSON.stringify({
      outputs: {
        dbHost: 'my-host.rds.amazonaws.com',
        dbPort: '5432',
      },
    });
    const outputs = parseSstOutputs(stdout);
    expect(outputs.dbHost).toBe('my-host.rds.amazonaws.com');
    expect(outputs.dbPort).toBe('5432');
  });

  it('returns empty object for empty stdout', () => {
    expect(parseSstOutputs('')).toEqual({});
  });

  it('ignores non-matching lines', () => {
    const stdout = `
Deploying...
Done!
  dbHost = myhost.com
Some other line
`;
    const outputs = parseSstOutputs(stdout);
    expect(outputs.dbHost).toBe('myhost.com');
    expect(Object.keys(outputs)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// provisionViaSst with injected process runner
// ---------------------------------------------------------------------------

describe('provisionViaSst', () => {
  it('successful deploy returns outputs', async () => {
    const { runner } = createMockRunner('success');

    const result = await provisionViaSst({
      resourceName: 'testdb',
      stageName: 'dev',
      region: 'us-east-1',
      platform: 'testorg',
      sstConfig: 'export default {}',
      processRunner: runner,
    });

    expect(result.success).toBe(true);
    expect(result.outputs.dbHost).toBe('my-host.rds.amazonaws.com');
    expect(result.outputs.dbPort).toBe('5432');
  });

  it('failed deploy returns error', async () => {
    const { runner } = createMockRunner('failure');

    const result = await provisionViaSst({
      resourceName: 'testdb',
      stageName: 'dev',
      region: 'us-east-1',
      platform: 'testorg',
      sstConfig: 'export default {}',
      processRunner: runner,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 1');
    expect(result.error).toContain('Access denied');
  });

  it('calls bunx sst deploy with correct stage', async () => {
    const { runner, calls } = createMockRunner('success');

    await provisionViaSst({
      resourceName: 'testdb',
      stageName: 'staging',
      region: 'eu-west-1',
      platform: 'testorg',
      sstConfig: 'export default {}',
      processRunner: runner,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bunx');
    expect(calls[0].args).toEqual(['sst', 'deploy', '--stage', 'staging']);
  });
});

describe('destroyViaSst', () => {
  it('calls sst destroy successfully', async () => {
    const { runner, calls } = createMockRunner('success');

    await destroyViaSst({
      resourceName: 'testdb',
      stageName: 'dev',
      region: 'us-east-1',
      sstConfig: 'export default {}',
      processRunner: runner,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('destroy');
  });

  it('throws on failed destroy', async () => {
    const { runner } = createMockRunner('failure');

    await expect(
      destroyViaSst({
        resourceName: 'testdb',
        stageName: 'dev',
        region: 'us-east-1',
        sstConfig: 'export default {}',
        processRunner: runner,
      }),
    ).rejects.toThrow('SST destroy exited with code 1');
  });

  it('calls bunx sst destroy with correct stage', async () => {
    const { runner, calls } = createMockRunner('success');

    await destroyViaSst({
      resourceName: 'testdb',
      stageName: 'prod',
      region: 'us-east-1',
      sstConfig: 'export default {}',
      processRunner: runner,
    });

    expect(calls[0].cmd).toBe('bunx');
    expect(calls[0].args).toEqual(['sst', 'destroy', '--stage', 'prod']);
  });
});

// ---------------------------------------------------------------------------
// Provisioner integration tests (provision: false path unchanged)
// ---------------------------------------------------------------------------

describe('postgres provisioner', () => {
  it('provision: false returns external connection env', async () => {
    const provisioner = createPostgresProvisioner();
    const ctx: ResourceProvisionerContext = {
      resourceName: 'db',
      config: {
        type: 'postgres',
        provision: false,
        connection: {
          host: 'external-host.com',
          port: '5432',
          user: 'admin',
          password: 'secret',
          database: 'mydb',
          url: 'postgres://admin:secret@external-host.com:5432/mydb',
        },
      },
      stageName: 'prod',
      region: 'us-east-1',
      platform: 'testorg',
    };

    const result = await provisioner.provision(ctx);
    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.DATABASE_URL).toBe(
      'postgres://admin:secret@external-host.com:5432/mydb',
    );
    expect(result.connectionEnv.PGHOST).toBe('external-host.com');
    expect(result.connectionEnv.PGPORT).toBe('5432');
    expect(result.connectionEnv.PGUSER).toBe('admin');
    expect(result.connectionEnv.PGPASSWORD).toBe('secret');
    expect(result.connectionEnv.PGDATABASE).toBe('mydb');
  });

  it('provision: false with empty connection returns empty env', async () => {
    const provisioner = createPostgresProvisioner();
    const ctx: ResourceProvisionerContext = {
      resourceName: 'db',
      config: { type: 'postgres', provision: false },
      stageName: 'prod',
      region: 'us-east-1',
      platform: 'testorg',
    };

    const result = await provisioner.provision(ctx);
    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.DATABASE_URL).toBe('');
    expect(result.connectionEnv.PGHOST).toBe('');
  });
});

describe('redis provisioner', () => {
  it('provision: false returns external connection env', async () => {
    const provisioner = createRedisProvisioner();
    const ctx: ResourceProvisionerContext = {
      resourceName: 'cache',
      config: {
        type: 'redis',
        provision: false,
        connection: {
          host: 'redis.external.com',
          port: '6379',
          url: 'redis://redis.external.com:6379',
        },
      },
      stageName: 'prod',
      region: 'us-east-1',
      platform: 'testorg',
    };

    const result = await provisioner.provision(ctx);
    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.REDIS_HOST).toBe('redis.external.com');
    expect(result.connectionEnv.REDIS_PORT).toBe('6379');
    expect(result.connectionEnv.REDIS_URL).toBe('redis://redis.external.com:6379');
  });
});

describe('kafka provisioner', () => {
  it('provision: false returns external brokers', async () => {
    const provisioner = createKafkaProvisioner();
    const ctx: ResourceProvisionerContext = {
      resourceName: 'events',
      config: {
        type: 'kafka',
        provision: false,
        connection: { brokers: 'broker1:9092,broker2:9092' },
      },
      stageName: 'prod',
      region: 'us-east-1',
      platform: 'testorg',
    };

    const result = await provisioner.provision(ctx);
    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.KAFKA_BROKERS).toBe('broker1:9092,broker2:9092');
  });
});
