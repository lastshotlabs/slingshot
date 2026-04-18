import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type {
  DestroyResourceResult,
  DestroyResourcesParams,
} from '../../../packages/slingshot-infra/src/resource/destroyResources';
import * as realInfra from './realBunshotInfra';

// Import lazily so the mock.module call above wins over the real package.
async function loadPlatformDestroyCommand() {
  const mod = await import('../../../src/cli/commands/platform/destroy');
  return mod.default;
}

// ---------------------------------------------------------------------------
// Minimal oclif config mock
// ---------------------------------------------------------------------------

function makeOclifConfig() {
  return {
    runHook: mock(async () => ({ successes: [], failures: [] })),
    findCommand: mock(() => undefined),
    pjson: { oclif: {} },
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockDestroyResources = mock(
  async (): Promise<DestroyResourceResult[]> => [
    { name: 'postgres', status: 'destroyed' },
    { name: 'redis', status: 'destroyed' },
  ],
);

const mockLoadPlatformConfig = mock(async () => ({
  config: {
    org: 'testorg',
    provider: 'aws' as const,
    region: 'us-east-1',
    registry: { provider: 'local' as const, path: '/tmp/test.json' },
    stages: { dev: {}, prod: {} },
    resources: {
      postgres: {
        type: 'postgres' as const,
        provision: false,
      },
      redis: {
        type: 'redis' as const,
        provision: false,
      },
    },
  },
}));

const mockCreateRegistryFromConfig = mock(() => ({
  name: 'mock',
  read: mock(async () => null),
  write: mock(async () => ({ etag: 'test' })),
  initialize: mock(async () => {}),
  lock: mock(async () => ({ etag: 'test', release: mock(async () => {}) })),
}));

mock.module('@lastshotlabs/slingshot-infra', () => ({
  // Spread real implementations so other test files that import from direct source paths
  // are not affected by this mock. Only override functions this test file needs to control.
  ...realInfra,
  destroyResources: mockDestroyResources,
  loadPlatformConfig: mockLoadPlatformConfig,
  createRegistryFromConfig: mockCreateRegistryFromConfig,
}));

mock.module('../../../src/cli/utils/resolvePlatformConfig', () => ({
  resolvePlatformConfig: (config: unknown) => config,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCommand(argv: string[]) {
  const PlatformDestroy = await loadPlatformDestroyCommand();
  return new PlatformDestroy(argv, makeOclifConfig() as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformDestroy command', () => {
  beforeEach(() => {
    mockDestroyResources.mockClear();
  });

  it('shows resources to destroy before prompting', async () => {
    const cmd = await makeCommand(['--stage', 'dev', '--yes']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await cmd.run();

    const allOutput = logs.join('\n');
    expect(allOutput).toContain('Resources to destroy for stage "dev"');
    expect(allOutput).toContain('postgres');
    expect(allOutput).toContain('redis');
  });

  it('confirmation prompt shown when --yes is absent', async () => {
    const cmd = await makeCommand(['--stage', 'dev']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    spyOn(cmd as never, 'confirm').mockResolvedValue(false);

    await cmd.run();

    expect((cmd as never as { confirm: ReturnType<typeof mock> }).confirm).toHaveBeenCalledTimes(1);
  });

  it('cancels when user answers N', async () => {
    const cmd = await makeCommand(['--stage', 'dev']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    spyOn(cmd as never, 'confirm').mockResolvedValue(false);

    await cmd.run();

    expect(mockDestroyResources).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('cancelled');
  });

  it('--yes flag skips confirmation and calls destroyResources', async () => {
    const cmd = await makeCommand(['--stage', 'dev', '--yes']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const confirmSpy = spyOn(cmd as never, 'confirm');

    await cmd.run();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockDestroyResources).toHaveBeenCalledTimes(1);
  });

  it('passes correct stageName to destroyResources', async () => {
    const cmd = await makeCommand(['--stage', 'prod', '--yes']);

    spyOn(cmd, 'log').mockImplementation(() => {});

    await cmd.run();

    const call = (mockDestroyResources.mock.calls[0] as unknown[])[0] as DestroyResourcesParams;
    expect(call.stageName).toBe('prod');
  });

  it('passes resource flag to destroyResources when specified', async () => {
    const cmd = await makeCommand(['--stage', 'dev', '--resource', 'postgres', '--yes']);

    spyOn(cmd, 'log').mockImplementation(() => {});

    await cmd.run();

    const call = (mockDestroyResources.mock.calls[0] as unknown[])[0] as DestroyResourcesParams;
    expect(call.resource).toBe('postgres');
  });

  it('logs destroyed resources after completion', async () => {
    const cmd = await makeCommand(['--stage', 'dev', '--yes']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await cmd.run();

    const allOutput = logs.join('\n');
    expect(allOutput).toContain('postgres');
    expect(allOutput).toContain('redis');
    expect(allOutput).toContain('Platform destroy complete');
  });

  it('refuses to destroy when destroyResources throws deployed services error', async () => {
    mockDestroyResources.mockImplementationOnce(async () => {
      throw new Error(
        "Stage 'dev' has deployed services. Run 'slingshot rollback' or remove services first.",
      );
    });

    const cmd = await makeCommand(['--stage', 'dev', '--yes']);

    spyOn(cmd, 'log').mockImplementation(() => {});
    spyOn(cmd, 'error').mockImplementation((msg: string | Error) => {
      throw new Error(typeof msg === 'string' ? msg : msg.message);
    });

    await expect(cmd.run()).rejects.toThrow('deployed services');
  });
});
