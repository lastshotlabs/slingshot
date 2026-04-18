import { describe, expect, it } from 'bun:test';
import { defineInfra } from '../../../packages/slingshot-infra/src/config/infraSchema';
import { generateSstConfig } from '../../../packages/slingshot-infra/src/preset/ecs/generators/sst';
import type { PresetContext } from '../../../packages/slingshot-infra/src/types/preset';

function createCtx(overrides?: Partial<PresetContext>): PresetContext {
  return {
    platform: {
      org: 'testorg',
      provider: 'aws',
      region: 'us-east-1',
      registry: { provider: 'local', path: '/tmp/test.json' },
      stages: { prod: {} },
    },
    infra: {
      stacks: ['main'],
      domain: 'api.myapp.com',
      port: 3000,
    },
    stage: {},
    stageName: 'prod',
    stack: { preset: 'ecs' },
    stackName: 'main',
    registry: {
      version: 1,
      platform: 'test',
      updatedAt: '',
      stacks: {},
      resources: {},
      services: {},
    },
    resolvedEnv: { NODE_ENV: 'production' },
    appRoot: '/app',
    serviceName: 'api',
    imageTag: '20260330-120000-abc1',
    dockerRegistry: 'testorg',
    ...overrides,
  };
}

describe('Deploy strategy defaults', () => {
  it('defaults to rolling strategy (no deployment block)', () => {
    const result = generateSstConfig(createCtx());
    expect(result.content).not.toContain('deployment:');
  });

  it('does not include deployment block when explicitly set to rolling', () => {
    const result = generateSstConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          domain: 'api.myapp.com',
          deployStrategy: 'rolling',
        },
      }),
    );
    expect(result.content).not.toContain('deployment:');
  });
});

describe('Blue/green deploy strategy', () => {
  it.todo(
    'generates blue-green deployment config in SST — deploy strategy not yet implemented',
    () => {
      const result = generateSstConfig(
        createCtx({
          infra: {
            stacks: ['main'],
            domain: 'api.myapp.com',
            deployStrategy: 'blue-green',
          },
        }),
      );
      expect(result.content).toContain('deployment:');
      expect(result.content).toContain('"blue-green"');
      expect(result.content).toContain('rollback: { enabled: true }');
      expect(result.content).toContain('terminationWait: "5 minutes"');
    },
  );
});

describe('Canary deploy strategy', () => {
  it.todo(
    'generates canary deployment config with defaults — deploy strategy not yet implemented',
    () => {
      const result = generateSstConfig(
        createCtx({
          infra: {
            stacks: ['main'],
            domain: 'api.myapp.com',
            deployStrategy: 'canary',
          },
        }),
      );
      expect(result.content).toContain('deployment:');
      expect(result.content).toContain('"canary"');
      expect(result.content).toContain('canaryPercent: 10');
      expect(result.content).toContain('evaluationPeriod: "300 seconds"');
      expect(result.content).toContain('autoPromote: true');
    },
  );

  it.todo('uses custom canary percent — deploy strategy not yet implemented', () => {
    const result = generateSstConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          domain: 'api.myapp.com',
          deployStrategy: 'canary',
          canary: { canaryPercent: 25 },
        },
      }),
    );
    expect(result.content).toContain('canaryPercent: 25');
  });

  it.todo('uses custom evaluation period — deploy strategy not yet implemented', () => {
    const result = generateSstConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          domain: 'api.myapp.com',
          deployStrategy: 'canary',
          canary: { evaluationPeriodSeconds: 600 },
        },
      }),
    );
    expect(result.content).toContain('evaluationPeriod: "600 seconds"');
  });

  it.todo('respects autoPromote: false — deploy strategy not yet implemented', () => {
    const result = generateSstConfig(
      createCtx({
        infra: {
          stacks: ['main'],
          domain: 'api.myapp.com',
          deployStrategy: 'canary',
          canary: { autoPromote: false },
        },
      }),
    );
    expect(result.content).toContain('autoPromote: false');
  });

  it.todo(
    'service-level canary overrides infra-level — deploy strategy not yet implemented',
    () => {
      const result = generateSstConfig(
        createCtx({
          infra: {
            stacks: ['main'],
            deployStrategy: 'canary',
            canary: { canaryPercent: 10 },
            services: {
              api: {
                path: 'apps/api',
                stacks: ['main'],
                domain: 'api.myapp.com',
                deployStrategy: 'canary',
                canary: { canaryPercent: 50 },
              },
            },
          },
          stackName: 'main',
        }),
      );
      expect(result.content).toContain('canaryPercent: 50');
    },
  );
});

describe('Schema validation for deploy strategy', () => {
  it('accepts valid deploy strategy values', () => {
    for (const strategy of ['rolling', 'blue-green', 'canary'] as const) {
      expect(() => defineInfra({ stacks: ['main'], deployStrategy: strategy })).not.toThrow();
    }
  });

  it.todo('rejects invalid deploy strategy — schema not yet implemented', () => {
    expect(() => defineInfra({ stacks: ['main'], deployStrategy: 'invalid' as any })).toThrow();
  });

  it.todo('accepts canary config — schema not yet implemented', () => {
    expect(() =>
      defineInfra({
        stacks: ['main'],
        deployStrategy: 'canary',
        canary: { canaryPercent: 20, evaluationPeriodSeconds: 600, autoPromote: false },
      }),
    ).not.toThrow();
  });

  it.todo('rejects canary percent out of range — schema not yet implemented', () => {
    expect(() =>
      defineInfra({
        stacks: ['main'],
        deployStrategy: 'canary',
        canary: { canaryPercent: 0 },
      }),
    ).toThrow();

    expect(() =>
      defineInfra({
        stacks: ['main'],
        deployStrategy: 'canary',
        canary: { canaryPercent: 101 },
      }),
    ).toThrow();
  });

  it('accepts deploy strategy on service declarations', () => {
    expect(() =>
      defineInfra({
        services: {
          api: {
            path: 'apps/api',
            stacks: ['main'],
            deployStrategy: 'blue-green',
          },
        },
      }),
    ).not.toThrow();
  });
});
