import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { DeployPipelineOptions } from '../../../packages/slingshot-infra/src/deploy/pipeline';
import * as realInfra from './realBunshotInfra';

// Import lazily so the mock.module call above wins over the real package.
async function loadDeployCommand() {
  const mod = await import('../../../src/cli/commands/deploy');
  return mod.default;
}

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

function makeRegistryDoc() {
  return {
    version: 1 as const,
    platform: 'testorg',
    updatedAt: '',
    stacks: { main: { preset: 'mock-preset', stages: {} } },
    resources: {},
    services: {},
  };
}

function makeDeployPipelineResult(plan = false) {
  if (plan) {
    return {
      services: [],
      plan: {
        services: [
          {
            serviceName: 'default',
            stackName: 'main',
            status: 'add' as const,
            newImageTag: '20260402-120000-abc1',
            changes: ['stack: main (new)', 'image tag: 20260402-120000-abc1 (new)'],
          },
        ],
        summary: { additions: 1, updates: 0, unchanged: 0 },
      },
    };
  }
  return {
    services: [
      {
        name: 'default',
        stack: 'main',
        result: { success: true, serviceUrl: 'https://api.example.com' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Mocks for @lastshotlabs/slingshot-infra
// ---------------------------------------------------------------------------

const mockRunDeployPipeline = mock(async (opts: DeployPipelineOptions) => {
  if (opts.plan) return makeDeployPipelineResult(true);
  return makeDeployPipelineResult(false);
});

const mockLoadPlatformConfig = mock(async () => ({
  config: {
    org: 'testorg',
    provider: 'aws' as const,
    region: 'us-east-1',
    registry: { provider: 'local' as const, path: '/tmp/test.json' },
    stacks: { main: { preset: 'mock-preset' } },
    stages: { prod: { env: {} } },
  },
}));

const mockLoadInfraConfig = mock(async () => ({
  config: { stacks: ['main'], uses: [], env: {} },
  configPath: '/app/slingshot.infra.ts',
}));

const mockCreateRegistryFromConfig = mock(() => ({
  name: 'mock',
  read: mock(async () => makeRegistryDoc()),
  write: mock(async () => ({ etag: 'test' })),
  initialize: mock(async () => {}),
  lock: mock(async () => ({ etag: 'test', release: mock(async () => {}) })),
}));

const mockCreatePresetRegistry = mock((presets: unknown) => ({
  get: (_name: string) => presets,
}));

const mockCreateEcsPreset = mock(() => ({
  name: 'ecs',
  generate: mock(() => []),
  deploy: mock(async () => ({ success: true })),
  provisionStack: mock(async () => ({ success: true, outputs: {} })),
  destroyStack: mock(async () => {}),
  defaultLogging: () => ({ driver: 'cloudwatch', retentionDays: 30 }),
}));

const mockCreateEc2NginxPreset = mock(() => ({
  name: 'ec2-nginx',
  generate: mock(() => []),
  deploy: mock(async () => ({ success: true })),
  provisionStack: mock(async () => ({ success: true, outputs: {} })),
  destroyStack: mock(async () => {}),
  defaultLogging: () => ({ driver: 'local', retentionDays: 7 }),
}));

mock.module('@lastshotlabs/slingshot-infra', () => ({
  // Spread real implementations so other test files that import from direct source paths
  // are not affected by this mock. Only override functions this test file needs to control.
  ...realInfra,
  runDeployPipeline: mockRunDeployPipeline,
  loadPlatformConfig: mockLoadPlatformConfig,
  loadInfraConfig: mockLoadInfraConfig,
  createRegistryFromConfig: mockCreateRegistryFromConfig,
  createPresetRegistry: mockCreatePresetRegistry,
  createEcsPreset: mockCreateEcsPreset,
  createEc2NginxPreset: mockCreateEc2NginxPreset,
  formatDeployPlan: (plan: {
    services: Array<{ serviceName: string; stackName: string; status: string; changes: string[] }>;
    summary: { additions: number; updates: number; unchanged: number };
  }) => {
    const lines: string[] = ['Deploy Plan', '==========', ''];
    for (const entry of plan.services) {
      const indicators: Record<string, string> = { add: '+', update: '~', unchanged: '=' };
      lines.push(`  ${indicators[entry.status]} ${entry.serviceName} (${entry.stackName})`);
      for (const change of entry.changes) {
        lines.push(`      ${change}`);
      }
    }
    lines.push('');
    const { additions, updates, unchanged } = plan.summary;
    lines.push(`Plan: ${additions} to add, ${updates} to update, ${unchanged} unchanged`);
    return lines.join('\n');
  },
}));

mock.module('../../../src/cli/utils/resolvePlatformConfig', () => ({
  resolvePlatformConfig: (config: unknown) => config,
}));

// ---------------------------------------------------------------------------
// Minimal oclif config stub required by Command.parse()
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCommand(argv: string[]) {
  const Deploy = await loadDeployCommand();
  return new Deploy(argv, makeOclifConfig() as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Deploy command', () => {
  beforeEach(() => {
    mockRunDeployPipeline.mockClear();
  });

  it('--plan mode calls runDeployPipeline with plan:true and does not call it again', async () => {
    const cmd = await makeCommand(['--stage', 'prod', '--plan']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await cmd.run();

    // Should have been called exactly once with plan: true
    expect(mockRunDeployPipeline).toHaveBeenCalledTimes(1);
    const call = mockRunDeployPipeline.mock.calls[0][0] as DeployPipelineOptions;
    expect(call.plan).toBe(true);
    expect(call.dryRun).toBeUndefined();

    // Should have logged the plan output
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('Deploy Plan');
    expect(allOutput).toContain('+ default (main)');
  });

  it('--dry-run mode does not prompt and does not compute plan beforehand', async () => {
    const cmd = await makeCommand(['--stage', 'prod', '--dry-run']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    // Ensure confirm is never called
    const confirmSpy = spyOn(cmd as never, 'confirm');

    await cmd.run();

    expect(confirmSpy).not.toHaveBeenCalled();

    // dry-run goes directly to runDeployPipeline with dryRun: true — no plan call
    expect(mockRunDeployPipeline).toHaveBeenCalledTimes(1);
    const call = mockRunDeployPipeline.mock.calls[0][0] as DeployPipelineOptions;
    expect(call.dryRun).toBe(true);
    expect(call.plan).toBeUndefined();
  });

  it('--yes flag skips confirmation and proceeds to deploy', async () => {
    const cmd = await makeCommand(['--stage', 'prod', '--yes']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const confirmSpy = spyOn(cmd as never, 'confirm');

    await cmd.run();

    // confirm should NOT have been called
    expect(confirmSpy).not.toHaveBeenCalled();

    // First call is for plan preview, second is the actual deploy
    expect(mockRunDeployPipeline).toHaveBeenCalledTimes(2);
    const planCall = mockRunDeployPipeline.mock.calls[0][0] as DeployPipelineOptions;
    expect(planCall.plan).toBe(true);

    const deployCall = mockRunDeployPipeline.mock.calls[1][0] as DeployPipelineOptions;
    expect(deployCall.plan).toBeUndefined();
    expect(deployCall.dryRun).toBeFalsy();

    // Should show deploy results
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('\u2713 default -> main: deployed');
  });

  it('without --yes prompts the user and cancels when answered N', async () => {
    const cmd = await makeCommand(['--stage', 'prod']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    // Simulate user answering 'n'
    spyOn(cmd as never, 'confirm').mockResolvedValue(false);

    await cmd.run();

    // Only the plan call should have happened, not the actual deploy
    expect(mockRunDeployPipeline).toHaveBeenCalledTimes(1);
    const call = mockRunDeployPipeline.mock.calls[0][0] as DeployPipelineOptions;
    expect(call.plan).toBe(true);

    expect(logs.join('\n')).toContain('Deploy cancelled.');
  });

  it('without --yes prompts and proceeds when answered y', async () => {
    const cmd = await makeCommand(['--stage', 'prod']);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    // Simulate user answering 'y'
    spyOn(cmd as never, 'confirm').mockResolvedValue(true);

    await cmd.run();

    // Both the plan call and the actual deploy call should have happened
    expect(mockRunDeployPipeline).toHaveBeenCalledTimes(2);

    const planCall = mockRunDeployPipeline.mock.calls[0][0] as DeployPipelineOptions;
    expect(planCall.plan).toBe(true);

    const deployCall = mockRunDeployPipeline.mock.calls[1][0] as DeployPipelineOptions;
    expect(deployCall.plan).toBeUndefined();

    const allOutput = logs.join('\n');
    expect(allOutput).toContain('\u2713 default -> main: deployed');
  });
});
