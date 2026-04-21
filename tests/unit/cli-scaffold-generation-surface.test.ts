import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import * as realInfra from './infra/realBunshotInfra';

function makeOclifConfig() {
  return {
    runHook: async () => ({ successes: [], failures: [] }),
    scopedEnvVar: () => undefined,
    scopedEnvVarKey: (key: string) => key,
    scopedEnvVarKeys: () => [],
    bin: 'slingshot',
    userAgent: 'slingshot/test',
    theme: undefined,
    findCommand: () => undefined,
  };
}

function captureLogs<T extends { log: (...args: unknown[]) => void }>(command: T): string[] {
  const logs: string[] = [];
  spyOn(command, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  return logs;
}

afterEach(() => {
  mock.restore();
});

describe('root cli scaffold/generation surface', () => {
  test('starts the server from a manifest and supports dry-run mode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'slingshot-start-'));
    const manifestPath = join(tmp, 'app.manifest.json');
    const handlersPath = join(tmp, 'slingshot.handlers.ts');
    writeFileSync(manifestPath, '{}\n', 'utf8');
    writeFileSync(handlersPath, 'export {};\n', 'utf8');

    const created: unknown[] = [];
    mock.module('@lib/createServerFromManifest', () => ({
      createServerFromManifest: async (
        manifest: string,
        _unused: unknown,
        options: Record<string, unknown>,
      ) => {
        created.push({ manifest, options });
        return { port: 4321 };
      },
    }));

    const Start = (await import('../../src/cli/commands/start')).default;
    const command = new Start(
      ['--manifest', manifestPath, '--handlers', handlersPath],
      makeOclifConfig() as never,
    );
    const logs = captureLogs(command);
    await command.run();
    expect(logs.join('\n')).toContain('Server running at http://localhost:4321');
    expect((created[0] as any).options.handlersPath).toContain('slingshot.handlers.ts');

    const dryRun = new Start(['--manifest', manifestPath, '--dry-run'], makeOclifConfig() as never);
    const dryLogs = captureLogs(dryRun);
    await dryRun.run();
    expect(dryLogs.join('\n')).toContain('Dry run complete');

    rmSync(tmp, { recursive: true, force: true });
  });

  test('generates seed data from a manifest and writes dry-run output', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'slingshot-seed-'));
    const manifestPath = join(tmp, 'entities.json');
    writeFileSync(manifestPath, '{"manifestVersion":1}\n', 'utf8');

    mock.module('@lastshotlabs/slingshot-entity', () => ({
      parseAndResolveMultiEntityManifest: () => ({
        entities: {
          User: {
            config: { name: 'User', relations: {}, _pkField: 'id' },
          },
        },
      }),
      generateSchemas: () => ({
        createSchema: { _zod: { def: { type: 'object' } } },
      }),
    }));
    mock.module('@lastshotlabs/slingshot-entity/seeder', () => ({
      topoSortEntities: (configs: unknown[]) => configs,
    }));
    mock.module('@lastshotlabs/slingshot-core/faker', () => ({
      generateFromSchema: () => ({ id: 'user-1', email: 'user@example.com' }),
      generateMany: (_schema: unknown, count: number) =>
        Array.from({ length: count }, (_, index) => ({
          id: `seeded-${index + 1}`,
          email: `user${index + 1}@example.com`,
        })),
    }));
    mock.module('@faker-js/faker', () => ({
      faker: {
        seed() {},
        helpers: {
          arrayElement<T>(values: T[]) {
            return values[0];
          },
        },
      },
    }));

    const Seed = (await import('../../src/cli/commands/seed')).default;
    const command = new Seed(
      ['--manifest', manifestPath, '--count', '1', '--dry-run'],
      makeOclifConfig() as never,
    );
    const logs = captureLogs(command);
    await command.run();
    expect(logs.join('\n')).toContain('--- User (1 records) ---');
    expect(logs.join('\n')).toContain('user@example.com');

    rmSync(tmp, { recursive: true, force: true });
  });

  test('fires generated payloads from either a schema file or a manifest', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'slingshot-fire-'));
    const schemaPath = join(tmp, 'schema.ts');
    const manifestPath = join(tmp, 'entities.json');
    writeFileSync(
      schemaPath,
      'export const schema = { _zod: { def: { type: "object" } } };\n',
      'utf8',
    );
    writeFileSync(manifestPath, '{"manifestVersion":1}\n', 'utf8');

    mock.module('@lastshotlabs/slingshot-entity', () => ({
      parseAndResolveMultiEntityManifest: () => ({
        entities: {
          User: { config: { name: 'User' } },
        },
      }),
      generateSchemas: () => ({
        createSchema: z.object({ id: z.string() }),
        updateSchema: z.object({ id: z.string().optional() }),
        entitySchema: z.object({ id: z.string() }),
        listOptionsSchema: z.object({ limit: z.number().optional() }),
      }),
    }));
    mock.module('@lastshotlabs/slingshot-core/faker', () => ({
      generateMany: (_schema: unknown, count: number) =>
        Array.from({ length: count }, (_, index) => ({ id: `payload-${index + 1}` })),
    }));

    const Fire = (await import('../../src/cli/commands/fire')).default;
    const schemaCommand = new Fire(
      ['--schema', schemaPath, '--count', '2'],
      makeOclifConfig() as never,
    );
    const schemaLogs = captureLogs(schemaCommand);
    await schemaCommand.run();
    expect(schemaLogs.join('\n')).toContain('[');

    const manifestCommand = new Fire(
      ['--manifest', manifestPath, '--entity', 'User', '--operation', 'create'],
      makeOclifConfig() as never,
    );
    const manifestLogs = captureLogs(manifestCommand);
    await manifestCommand.run();
    expect(manifestLogs.join('\n')).toContain('{');

    rmSync(tmp, { recursive: true, force: true });
  });

  test('scaffolds infra and platform config files from templates', async () => {
    const infraTmp = mkdtempSync(join(tmpdir(), 'slingshot-infra-init-'));
    const platformTmp = mkdtempSync(join(tmpdir(), 'slingshot-platform-init-'));
    const platformPath = join(infraTmp, 'slingshot.platform.ts');
    writeFileSync(platformPath, "export default { stacks: { 'web': {} } };\n", 'utf8');

    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      generateInfraTemplate: ({ stacks, port }: { stacks?: string[]; port: number }) =>
        `// infra ${stacks?.join(',') ?? 'none'} ${port}`,
      generatePlatformTemplate: ({
        org,
        region,
        preset,
      }: {
        org: string;
        region: string;
        preset: string;
      }) => `// platform ${org} ${region} ${preset}`,
    }));

    const InfraInit = (await import('../../src/cli/commands/infra/init')).default;
    const infraCommand = new InfraInit(
      ['--dir', infraTmp, '--port', '8080'],
      makeOclifConfig() as never,
    );
    const infraLogs = captureLogs(infraCommand);
    await infraCommand.run();
    expect(readFileSync(join(infraTmp, 'slingshot.infra.ts'), 'utf8')).toContain('// infra');
    expect(infraLogs.join('\n')).toContain('Created');

    const PlatformInit = (await import('../../src/cli/commands/platform/init')).default;
    const platformCommand = new PlatformInit(
      ['--dir', platformTmp, '--org', 'acme', '--region', 'us-east-1', '--preset', 'ecs'],
      makeOclifConfig() as never,
    );
    const platformLogs = captureLogs(platformCommand);
    await platformCommand.run();
    expect(readFileSync(join(platformTmp, 'slingshot.platform.ts'), 'utf8')).toContain(
      '// platform acme us-east-1 ecs',
    );
    expect(platformLogs.join('\n')).toContain('Created');

    rmSync(infraTmp, { recursive: true, force: true });
    rmSync(platformTmp, { recursive: true, force: true });
  });

  test('runs infra generate as a dry-run deploy pipeline', async () => {
    let captured: unknown = null;
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { platform: undefined, registry: {} } }),
      loadInfraConfig: async () => ({
        config: { platform: undefined },
        configPath: '/app/slingshot.infra.ts',
      }),
      createRegistryFromConfig: () => ({}),
      createPresetRegistry: () => ({}),
      createEcsPreset: () => ({}),
      createEc2NginxPreset: () => ({}),
      runDeployPipeline: async (options: unknown) => {
        captured = options;
      },
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: (config: any) => config,
    }));

    const InfraGenerate = (await import('../../src/cli/commands/infra/generate')).default;
    const command = new InfraGenerate(['--stage', 'prod'], makeOclifConfig() as never);
    await command.run();
    expect((captured as any).dryRun).toBe(true);
    expect((captured as any).stageName).toBe('prod');
  });

  test('provisions platform resources and stacks, then rolls services back', async () => {
    const registryDoc = {
      resources: { postgres: { stages: {} } },
      stacks: {
        web: { preset: 'ecs', stages: {} },
      },
      services: {
        api: {
          stages: {
            prod: {
              imageTag: 'v2',
              previousTags: [{ imageTag: 'v1' }],
              status: 'deployed',
            },
          },
        },
      },
    };
    const writes: unknown[] = [];

    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({
        config: {
          org: 'acme',
          region: 'us-east-1',
          registry: {},
          stages: { prod: {} },
          resources: { postgres: { type: 'postgres' } },
          stacks: { web: { preset: 'ecs' } },
        },
      }),
      createRegistryFromConfig: () => ({
        read: async () => registryDoc,
        lock: async () => ({ etag: 'etag', release: async () => undefined }),
        write: async (doc: unknown) => {
          writes.push(JSON.parse(JSON.stringify(doc)));
        },
      }),
      createProvisionerRegistry: () => ({
        get: () => ({
          provision: async () => ({ status: 'active', connectionEnv: { DATABASE_URL: 'db' } }),
        }),
      }),
      createPresetRegistry: () => ({
        get: () => ({
          provisionStack: async () => ({ success: true, outputs: { host: 'api.example.com' } }),
        }),
      }),
      createPostgresProvisioner: () => ({}),
      createRedisProvisioner: () => ({}),
      createKafkaProvisioner: () => ({}),
      createEcsPreset: () => ({}),
      createEc2NginxPreset: () => ({}),
      runRollback: async () => ({
        services: [{ name: 'api', success: true, previousTag: 'v2', rolledBackTag: 'v1' }],
      }),
      loadInfraConfig: async () => ({
        config: { platform: undefined },
        configPath: '/app/slingshot.infra.ts',
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: (config: any) => config,
    }));

    const PlatformDeploy = (await import('../../src/cli/commands/platform/deploy')).default;
    const deployCommand = new PlatformDeploy(
      ['--stage', 'prod', '--yes'],
      makeOclifConfig() as never,
    );
    const deployLogs = captureLogs(deployCommand);
    await deployCommand.run();
    expect(deployLogs.join('\n')).toContain('Platform deploy complete');
    expect((writes.at(-1) as any).resources.postgres.stages.prod.status).toBe('active');

    const Rollback = (await import('../../src/cli/commands/rollback')).default;
    const rollbackCommand = new Rollback(['--stage', 'prod', '--yes'], makeOclifConfig() as never);
    const rollbackLogs = captureLogs(rollbackCommand);
    await rollbackCommand.run();
    expect(rollbackLogs.join('\n')).toContain('api: v2 -> v1');
  });
});
