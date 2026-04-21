/**
 * Unit tests for the Deploy CLI command.
 *
 * Targets the uncovered lines:
 * - lines 109-115: confirm() private method — readline-based y/N prompt
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as realInfra from './infra/realBunshotInfra';

// Minimal oclif config stub
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

// Build a factory that produces a readline mock with the given answer
function makeReadlineMock(answer: string) {
  return {
    createInterface: () => ({
      question: (_msg: string, cb: (a: string) => void) => cb(answer),
      close: () => {},
    }),
  };
}

afterAll(() => {
  mock.restore();
});

describe('Deploy.run()', () => {
  test('--plan flag computes and displays a deploy plan', async () => {
    const planText = 'mock plan output';
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      loadInfraConfig: async () => ({
        config: { platform: {} },
        configPath: '/app/slingshot.infra.ts',
      }),
      createRegistryFromConfig: () => ({}),
      createPresetRegistry: () => ({}),
      createEcsPreset: () => ({}),
      createEc2NginxPreset: () => ({}),
      formatDeployPlan: () => planText,
      runDeployPipeline: async () => ({
        plan: { services: [] },
        services: [],
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));

    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy(['--stage', 'staging', '--plan'], makeOclifConfig() as never);

    const logged: string[] = [];
    cmd.log = (...args: any[]) => {
      logged.push(args.join(' '));
    };

    await cmd.run();
    expect(logged.some(l => l.includes(planText))).toBe(true);
  });

  test('--dry-run deploys without confirmation prompt', async () => {
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      loadInfraConfig: async () => ({
        config: { platform: {} },
        configPath: '/app/slingshot.infra.ts',
      }),
      createRegistryFromConfig: () => ({}),
      createPresetRegistry: () => ({}),
      createEcsPreset: () => ({}),
      createEc2NginxPreset: () => ({}),
      formatDeployPlan: () => '',
      runDeployPipeline: async () => ({
        services: [
          {
            name: 'web',
            stack: 'ecs',
            result: { success: true, serviceUrl: 'https://web.example.com' },
          },
        ],
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));

    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy(['--stage', 'staging', '--dry-run'], makeOclifConfig() as never);

    const logged: string[] = [];
    cmd.log = (...args: any[]) => {
      logged.push(args.join(' '));
    };

    await cmd.run();
    expect(logged.some(l => l.includes('dry run'))).toBe(true);
    expect(logged.some(l => l.includes('web'))).toBe(true);
  });

  test('--yes skips confirmation and deploys directly', async () => {
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      loadInfraConfig: async () => ({
        config: { platform: {} },
        configPath: '/app/slingshot.infra.ts',
      }),
      createRegistryFromConfig: () => ({}),
      createPresetRegistry: () => ({}),
      createEcsPreset: () => ({}),
      createEc2NginxPreset: () => ({}),
      formatDeployPlan: () => 'plan-text',
      runDeployPipeline: async () => ({
        plan: { services: [] },
        services: [{ name: 'api', stack: 'ecs', result: { success: true } }],
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));

    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy(['--stage', 'prod', '--yes'], makeOclifConfig() as never);

    const logged: string[] = [];
    cmd.log = (...args: any[]) => {
      logged.push(args.join(' '));
    };

    await cmd.run();
    expect(logged.some(l => l.includes('api'))).toBe(true);
  });

  test('deploy cancelled when user declines confirmation', async () => {
    mock.module('node:readline', () => makeReadlineMock('n'));
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      loadInfraConfig: async () => ({
        config: { platform: {} },
        configPath: '/app/slingshot.infra.ts',
      }),
      createRegistryFromConfig: () => ({}),
      createPresetRegistry: () => ({}),
      createEcsPreset: () => ({}),
      createEc2NginxPreset: () => ({}),
      formatDeployPlan: () => '',
      runDeployPipeline: async () => ({
        plan: { services: [] },
        services: [],
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));

    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy(['--stage', 'prod'], makeOclifConfig() as never);

    const logged: string[] = [];
    cmd.log = (...args: any[]) => {
      logged.push(args.join(' '));
    };

    await cmd.run();
    expect(logged.some(l => l.includes('Deploy cancelled'))).toBe(true);
  });

  test('shows failure icon when service deploy fails', async () => {
    mock.module('@lastshotlabs/slingshot-infra', () => ({
      ...realInfra,
      loadPlatformConfig: async () => ({ config: { registry: {} } }),
      loadInfraConfig: async () => ({
        config: { platform: {} },
        configPath: '/app/slingshot.infra.ts',
      }),
      createRegistryFromConfig: () => ({}),
      createPresetRegistry: () => ({}),
      createEcsPreset: () => ({}),
      createEc2NginxPreset: () => ({}),
      formatDeployPlan: () => '',
      runDeployPipeline: async () => ({
        plan: { services: [] },
        services: [{ name: 'worker', stack: 'ec2', result: { success: false, error: 'timeout' } }],
      }),
    }));
    mock.module('../../src/cli/utils/resolvePlatformConfig', () => ({
      resolvePlatformConfig: () => ({ registry: {} }),
    }));

    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy(['--stage', 'prod', '--yes'], makeOclifConfig() as never);

    const logged: string[] = [];
    cmd.log = (...args: any[]) => {
      logged.push(args.join(' '));
    };

    await cmd.run();
    expect(logged.some(l => l.includes('\u2717') && l.includes('timeout'))).toBe(true);
  });
});

describe('Deploy.confirm (lines 109-115)', () => {
  test('resolves true when user enters "y"', async () => {
    mock.module('node:readline', () => makeReadlineMock('y'));
    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy([], makeOclifConfig() as never);
    const result = await (cmd as any).confirm('Proceed? ');
    expect(result).toBe(true);
  });

  test('resolves true when user enters "yes"', async () => {
    mock.module('node:readline', () => makeReadlineMock('yes'));
    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy([], makeOclifConfig() as never);
    const result = await (cmd as any).confirm('Proceed? ');
    expect(result).toBe(true);
  });

  test('resolves true when user enters "YES" (case insensitive)', async () => {
    mock.module('node:readline', () => makeReadlineMock('YES'));
    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy([], makeOclifConfig() as never);
    const result = await (cmd as any).confirm('Proceed? ');
    expect(result).toBe(true);
  });

  test('resolves false when user enters "n"', async () => {
    mock.module('node:readline', () => makeReadlineMock('n'));
    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy([], makeOclifConfig() as never);
    const result = await (cmd as any).confirm('Proceed? ');
    expect(result).toBe(false);
  });

  test('resolves false when user enters empty string', async () => {
    mock.module('node:readline', () => makeReadlineMock(''));
    const Deploy = (await import('../../src/cli/commands/deploy')).default;
    const cmd = new Deploy([], makeOclifConfig() as never);
    const result = await (cmd as any).confirm('Proceed? ');
    expect(result).toBe(false);
  });
});
