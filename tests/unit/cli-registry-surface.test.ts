import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
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

type LoggableCommand = { log(message?: string, ...args: unknown[]): void };

function captureLogs<T extends LoggableCommand>(command: T): string[] {
  const logs: string[] = [];
  const logSpy = spyOn(command, 'log') as unknown as {
    mockImplementation(fn: LoggableCommand['log']): unknown;
  };
  logSpy.mockImplementation((message?: string, ...args: unknown[]) => {
    if (message === undefined) return;
    logs.push([message, ...args].map(String).join(' '));
  });
  return logs;
}

function requireTsupObjectConfig(
  config: typeof import('../../tsup.cli.config')['default'],
): Exclude<typeof config, unknown[] | ((...args: never[]) => unknown)> {
  if (Array.isArray(config) || typeof config === 'function') {
    throw new Error('Expected tsup CLI config to export an object');
  }
  return config;
}

afterEach(() => {
  mock.restore();
});

describe('root cli registry/platform surface', () => {
  test('loads build/runtime config modules', async () => {
    const tsup = await import('../../tsup.cli.config');
    const vitest = await import('../../vitest.config');
    const tsupConfig = requireTsupObjectConfig(tsup.default);

    const entry = tsupConfig.entry as Record<string, string> | undefined;
    const banner =
      typeof tsupConfig.banner === 'function' ? tsupConfig.banner({ format: 'esm' }) : tsupConfig.banner;
    expect(entry?.['cli/index']).toBe('src/cli/index.ts');
    expect(banner?.js).toContain('#!/usr/bin/env node');
    expect(vitest.default.test?.environment).toBe('node');
    expect(vitest.default.test?.include).toEqual(['tests/node-runtime/**/*.test.ts']);
  });

  test('lists and inspects apps from the registry', async () => {
    const registryDoc = {
      apps: {
        storefront: {
          name: 'storefront',
          repo: 'github.com/example/storefront',
          stacks: ['web'],
          uses: ['postgres'],
          registeredAt: '2026-04-19T10:00:00.000Z',
        },
      },
      stacks: {
        web: {
          preset: 'ecs',
          stages: { prod: { status: 'active', outputs: {} } },
        },
      },
      resources: {
        postgres: {
          type: 'postgres',
          stages: { prod: { status: 'active' } },
        },
      },
      services: {
        web: {
          stack: 'web',
          repo: 'github.com/example/storefront',
          stages: {
            prod: { status: 'deployed', deployedAt: '2026-04-19T10:05:00.000Z' },
          },
        },
      },
    };

    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      createRegistryFromConfig: () => ({
        read: async () => registryDoc,
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));

    const AppsList = (await import('../../src/cli/commands/apps/list')).default;
    const listCommand = new AppsList([], makeOclifConfig() as never);
    const listLogs = captureLogs(listCommand);
    await listCommand.run();
    expect(listLogs.join('\n')).toContain('storefront');
    expect(listLogs.join('\n')).toContain('postgres');

    const AppsInspect = (await import('../../src/cli/commands/apps/inspect')).default;
    const inspectCommand = new AppsInspect(['storefront'], makeOclifConfig() as never);
    const inspectLogs = captureLogs(inspectCommand);
    await inspectCommand.run();
    expect(inspectLogs.join('\n')).toContain('App: storefront');
    expect(inspectLogs.join('\n')).toContain('Services:');
  });

  test('lists dns records and previews dns sync actions', async () => {
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({
        config: {
          dns: { provider: 'cloudflare', apiToken: 'token', zoneId: 'zone' },
          stages: { prod: { env: 'prod' } },
        },
      }),
      loadInfraConfig: async () => ({
        config: {
          platform: undefined,
          domain: 'example.com',
          domains: { default: { service: 'api', stages: {} } },
        },
      }),
      createCloudflareClient: () => ({
        listRecords: async () => [
          { type: 'A', name: 'api.example.com', content: '1.2.3.4', proxied: true, ttl: 300 },
        ],
      }),
      createDnsManager: () => ({
        ensureRecords: async () => undefined,
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: (config: any) => config,
    }));

    const DnsList = (await import('../../src/cli/commands/dns/list')).default;
    const listCommand = new DnsList([], makeOclifConfig() as never);
    const listLogs = captureLogs(listCommand);
    await listCommand.run();
    expect(listLogs.join('\n')).toContain('api.example.com');
    expect(listLogs.join('\n')).toContain('1 record(s) total');

    const DnsSync = (await import('../../src/cli/commands/dns/sync')).default;
    const syncCommand = new DnsSync(['--stage', 'prod', '--dry-run'], makeOclifConfig() as never);
    const syncLogs = captureLogs(syncCommand);
    await syncCommand.run();
    expect(syncLogs.join('\n')).toContain('Would ensure record for default');
    expect(syncLogs.join('\n')).toContain('Dry run complete.');
  });

  test('downloads platform config from the registry', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'slingshot-platform-pull-'));
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      parseRegistryUrl: (value: string) => ({ provider: 's3', bucket: value }),
      createRegistryFromConfig: () => ({
        read: async () => ({ platformConfig: { org: 'example', region: 'us-east-1' } }),
      }),
    }));

    const PlatformPull = (await import('../../src/cli/commands/platform/pull')).default;
    const command = new PlatformPull(
      ['--dir', outDir, '--registry', 'my-platform-registry'],
      makeOclifConfig() as never,
    );
    const logs = captureLogs(command);
    await command.run();

    const written = join(outDir, 'slingshot.platform.ts');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain('definePlatform');
    expect(logs.join('\n')).toContain('Downloaded platform config');

    rmSync(outDir, { recursive: true, force: true });
  });

  test('initializes the registry and syncs platform config', async () => {
    const registryDoc = {
      stacks: { web: { preset: 'ecs', stages: {} } },
      services: {},
      updatedAt: null,
    };
    let initialized = false;
    let written: unknown = null;

    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({
        config: {
          org: 'example',
          registry: { provider: 'local', path: './registry.json' },
          stacks: { web: { preset: 'ec2-nginx' } },
        },
      }),
      createRegistryFromConfig: () => ({
        initialize: async () => {
          initialized = true;
        },
        read: async () => registryDoc,
        lock: async () => ({ etag: 'etag', release: async () => undefined }),
        write: async (doc: unknown) => {
          written = doc;
        },
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: (config: any) => config,
    }));

    const RegistryInit = (await import('../../src/cli/commands/registry/init')).default;
    const initCommand = new RegistryInit([], makeOclifConfig() as never);
    const initLogs = captureLogs(initCommand);
    await initCommand.run();
    expect(initialized).toBe(true);
    expect(initLogs.join('\n')).toContain('Local registry created');

    const PlatformSync = (await import('../../src/cli/commands/platform/sync')).default;
    const syncCommand = new PlatformSync([], makeOclifConfig() as never);
    const syncLogs = captureLogs(syncCommand);
    await syncCommand.run();
    expect((written as any).platform).toBe('example');
    expect((written as any).stacks.web.preset).toBe('ec2-nginx');
    expect(syncLogs.join('\n')).toContain('Platform config synced');
  });

  test('checks, pulls, and pushes secrets through the provider boundary', async () => {
    const calls: string[] = [];
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({
        config: {
          platform: undefined,
          secrets: { provider: 'ssm' },
        },
      }),
      loadInfraConfig: async () => ({
        config: { platform: undefined },
        configPath: '/app/slingshot.infra.ts',
      }),
      resolveRequiredKeys: () => ['JWT_SECRET', 'REDIS_URL'],
      createSecretsManager: () => ({
        check: async () => ({ found: ['JWT_SECRET'], missing: ['REDIS_URL'] }),
        pull: async () => {
          calls.push('pull');
          return { pulled: ['JWT_SECRET'] };
        },
        push: async () => {
          calls.push('push');
          return { pushed: ['JWT_SECRET'] };
        },
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: (config: any) => config,
    }));

    const SecretsCheck = (await import('../../src/cli/commands/secrets/check')).default;
    const checkCommand = new SecretsCheck(['--stage', 'prod'], makeOclifConfig() as never);
    const checkLogs = captureLogs(checkCommand);
    checkCommand.exit = (code?: number) => {
      throw new Error(`exit:${code}`);
    };
    await expect(checkCommand.run()).rejects.toThrow('exit:1');
    expect(checkLogs.join('\n')).toContain('REDIS_URL');

    const SecretsPull = (await import('../../src/cli/commands/secrets/pull')).default;
    const pullCommand = new SecretsPull(['--stage', 'prod'], makeOclifConfig() as never);
    const pullLogs = captureLogs(pullCommand);
    await pullCommand.run();
    expect(pullLogs.join('\n')).toContain('Pulled 1 secrets');

    const SecretsPush = (await import('../../src/cli/commands/secrets/push')).default;
    const pushCommand = new SecretsPush(['--stage', 'prod'], makeOclifConfig() as never);
    const pushLogs = captureLogs(pushCommand);
    await pushCommand.run();
    expect(pushLogs.join('\n')).toContain('Pushed 1 secrets');
    expect(calls).toEqual(['pull', 'push']);
  });

  test('creates, lists, and inspects stacks', async () => {
    const doc = {
      stacks: {
        web: {
          preset: 'ecs',
          stages: {
            _meta: { outputs: { publicIp: '1.2.3.4' } },
            prod: { status: 'active', outputs: { host: 'api.example.com' } },
          },
        },
      },
      services: {
        api: {
          stack: 'web',
          repo: 'github.com/example/api',
          port: 3000,
          domain: 'api.example.com',
          stages: { prod: { status: 'deployed', imageTag: 'v1', deployedAt: '2026-04-19' } },
        },
      },
    };
    let writtenDoc: unknown = null;

    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      createRegistryFromConfig: () => ({
        read: async () => doc,
        lock: async () => ({ etag: 'etag', release: async () => undefined }),
        write: async (nextDoc: unknown) => {
          writtenDoc = nextDoc;
        },
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));

    const StacksCreate = (await import('../../src/cli/commands/stacks/create')).default;
    const createCommand = new StacksCreate(
      ['jobs', '--preset', 'ecs', '--host', '5.6.7.8'],
      makeOclifConfig() as never,
    );
    const createLogs = captureLogs(createCommand);
    await createCommand.run();
    expect((writtenDoc as any).stacks.jobs.stages._meta.outputs.publicIp).toBe('5.6.7.8');
    expect(createLogs.join('\n')).toContain('Stack "jobs" registered');

    const StacksList = (await import('../../src/cli/commands/stacks/list')).default;
    const listCommand = new StacksList([], makeOclifConfig() as never);
    const listLogs = captureLogs(listCommand);
    await listCommand.run();
    expect(listLogs.join('\n')).toContain('Stacks:');
    expect(listLogs.join('\n')).toContain('api -> web');

    const StacksInspect = (await import('../../src/cli/commands/stacks/inspect')).default;
    const inspectCommand = new StacksInspect(['web'], makeOclifConfig() as never);
    const inspectLogs = captureLogs(inspectCommand);
    await inspectCommand.run();
    expect(inspectLogs.join('\n')).toContain('Stack: web');
    expect(inspectLogs.join('\n')).toContain('publicIp: 1.2.3.4');
  });

  test('adds, inspects, and removes server entries', async () => {
    const doc = {
      stacks: {
        web: {
          preset: 'ecs',
          stages: {
            prod: {
              status: 'active',
              outputs: { host: 'api.example.com', serverName: 'shared-1' },
              updatedAt: '2026-04-19T10:00:00.000Z',
            },
          },
        },
      },
      services: {
        api: {
          stack: 'web',
          repo: 'github.com/example/api',
          port: 3000,
          domain: 'api.example.com',
          stages: {
            prod: {
              status: 'deployed',
              deployedAt: '2026-04-19T10:00:00.000Z',
            },
          },
        },
      },
    };
    const writes: unknown[] = [];

    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      createRegistryFromConfig: () => ({
        read: async () => doc,
        lock: async () => ({ etag: 'etag', release: async () => undefined }),
        write: async (nextDoc: unknown) => {
          writes.push(JSON.parse(JSON.stringify(nextDoc)));
        },
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));
    mock.module('node:child_process', () => ({
      spawnSync: () => ({ status: 0 }),
    }));

    const ServersAdd = (await import('../../src/cli/commands/servers/add')).default;
    const addCommand = new ServersAdd(
      ['shared-2', '--host', '5.6.7.8', '--stack', 'web', '--stage', 'prod'],
      makeOclifConfig() as never,
    );
    const addLogs = captureLogs(addCommand);
    await addCommand.run();
    expect(addLogs.join('\n')).toContain('Server "shared-2" registered');
    expect((writes[0] as any).stacks.web.stages.prod.outputs.serverName).toBe('shared-2');

    const ServersInspect = (await import('../../src/cli/commands/servers/inspect')).default;
    const inspectCommand = new ServersInspect(
      ['web', '--stage', 'prod'],
      makeOclifConfig() as never,
    );
    const inspectLogs = captureLogs(inspectCommand);
    await inspectCommand.run();
    expect(inspectLogs.join('\n')).toContain('Host: 5.6.7.8');
    expect(inspectLogs.join('\n')).toContain('api.example.com');

    const ServersRemove = (await import('../../src/cli/commands/servers/remove')).default;
    const removeCommand = new ServersRemove(
      ['web', '--stage', 'prod', '--yes'],
      makeOclifConfig() as never,
    );
    const removeLogs = captureLogs(removeCommand);
    await removeCommand.run();
    expect(removeLogs.join('\n')).toContain('Removed stage "prod"');
  });
});
