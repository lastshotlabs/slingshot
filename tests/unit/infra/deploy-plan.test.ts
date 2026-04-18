import { describe, expect, it } from 'bun:test';
import { formatDeployPlan } from '../../../packages/slingshot-infra/src/deploy/formatPlan';
import { computeDeployPlan } from '../../../packages/slingshot-infra/src/deploy/plan';
import type { DefineInfraConfig } from '../../../packages/slingshot-infra/src/types/infra';
import type { RegistryDocument } from '../../../packages/slingshot-infra/src/types/registry';

function createInfra(overrides?: Partial<DefineInfraConfig>): DefineInfraConfig {
  return {
    stacks: ['web-stack'],
    ...overrides,
  };
}

function createRegistry(overrides?: Partial<RegistryDocument>): RegistryDocument {
  return {
    version: 1,
    platform: 'test',
    updatedAt: '',
    stacks: {},
    resources: {},
    services: {},
    ...overrides,
  };
}

describe('computeDeployPlan', () => {
  it('marks new service as add', () => {
    const plan = computeDeployPlan({
      infra: createInfra(),
      stageName: 'prod',
      registry: createRegistry(),
      imageTag: '20260401-130000-def7',
    });

    expect(plan.services).toHaveLength(1);
    expect(plan.services[0].serviceName).toBe('default');
    expect(plan.services[0].status).toBe('add');
    expect(plan.services[0].stackName).toBe('web-stack');
    expect(plan.services[0].newImageTag).toBe('20260401-130000-def7');
    expect(plan.services[0].changes).toContain('stack: web-stack (new)');
    expect(plan.services[0].changes).toContain('image tag: 20260401-130000-def7 (new)');
  });

  it('marks existing service with same image as unchanged', () => {
    const plan = computeDeployPlan({
      infra: createInfra(),
      stageName: 'prod',
      registry: createRegistry({
        services: {
          default: {
            stack: 'web-stack',
            repo: '',
            uses: [],
            stages: {
              prod: {
                imageTag: '20260401-120000-abc4',
                deployedAt: '2026-04-01T12:00:00Z',
                status: 'deployed',
              },
            },
          },
        },
      }),
      imageTag: '20260401-120000-abc4',
    });

    expect(plan.services).toHaveLength(1);
    expect(plan.services[0].status).toBe('unchanged');
    expect(plan.services[0].currentImageTag).toBe('20260401-120000-abc4');
    expect(plan.services[0].changes).toHaveLength(0);
  });

  it('marks existing service with different image as update', () => {
    const plan = computeDeployPlan({
      infra: createInfra(),
      stageName: 'prod',
      registry: createRegistry({
        services: {
          default: {
            stack: 'web-stack',
            repo: '',
            uses: [],
            stages: {
              prod: {
                imageTag: '20260401-120000-abc4',
                deployedAt: '2026-04-01T12:00:00Z',
                status: 'deployed',
              },
            },
          },
        },
      }),
      imageTag: '20260401-130000-def7',
    });

    expect(plan.services).toHaveLength(1);
    expect(plan.services[0].status).toBe('update');
    expect(plan.services[0].currentImageTag).toBe('20260401-120000-abc4');
    expect(plan.services[0].newImageTag).toBe('20260401-130000-def7');
    expect(plan.services[0].currentStatus).toBe('deployed');
    expect(plan.services[0].changes).toContain(
      'image tag: 20260401-120000-abc4 \u2192 20260401-130000-def7',
    );
  });

  it('computes correct summary counts', () => {
    const plan = computeDeployPlan({
      infra: createInfra({
        services: {
          api: { path: 'apps/api', stacks: ['web-stack'] },
          worker: { path: 'apps/worker', stacks: ['web-stack'] },
          web: { path: 'apps/web', stacks: ['web-stack'] },
        },
      }),
      stageName: 'prod',
      registry: createRegistry({
        services: {
          api: {
            stack: 'web-stack',
            repo: '',
            uses: [],
            stages: {
              prod: {
                imageTag: '20260401-120000-abc4',
                deployedAt: '2026-04-01T12:00:00Z',
                status: 'deployed',
              },
            },
          },
          worker: {
            stack: 'web-stack',
            repo: '',
            uses: [],
            stages: {
              prod: {
                imageTag: '20260401-130000-def7',
                deployedAt: '2026-04-01T13:00:00Z',
                status: 'deployed',
              },
            },
          },
        },
      }),
      imageTag: '20260401-130000-def7',
    });

    expect(plan.summary.additions).toBe(1); // web is new
    expect(plan.summary.updates).toBe(1); // api has different tag
    expect(plan.summary.unchanged).toBe(1); // worker has same tag
  });

  it('handles multi-service with no stacks override', () => {
    const plan = computeDeployPlan({
      infra: createInfra({
        stacks: ['main-stack'],
        services: {
          api: { path: 'apps/api' },
        },
      }),
      stageName: 'prod',
      registry: createRegistry(),
      imageTag: '20260401-130000-def7',
    });

    expect(plan.services).toHaveLength(1);
    expect(plan.services[0].stackName).toBe('main-stack');
    expect(plan.services[0].status).toBe('add');
  });
});

describe('formatDeployPlan', () => {
  it('uses + indicator for additions', () => {
    const plan = computeDeployPlan({
      infra: createInfra(),
      stageName: 'prod',
      registry: createRegistry(),
      imageTag: '20260401-130000-def7',
    });

    const output = formatDeployPlan(plan);
    expect(output).toContain('+ default (web-stack)');
  });

  it('uses ~ indicator for updates', () => {
    const plan = computeDeployPlan({
      infra: createInfra(),
      stageName: 'prod',
      registry: createRegistry({
        services: {
          default: {
            stack: 'web-stack',
            repo: '',
            uses: [],
            stages: {
              prod: {
                imageTag: '20260401-120000-abc4',
                deployedAt: '',
                status: 'deployed',
              },
            },
          },
        },
      }),
      imageTag: '20260401-130000-def7',
    });

    const output = formatDeployPlan(plan);
    expect(output).toContain('~ default (web-stack)');
  });

  it('uses = indicator for unchanged', () => {
    const plan = computeDeployPlan({
      infra: createInfra(),
      stageName: 'prod',
      registry: createRegistry({
        services: {
          default: {
            stack: 'web-stack',
            repo: '',
            uses: [],
            stages: {
              prod: {
                imageTag: '20260401-120000-abc4',
                deployedAt: '',
                status: 'deployed',
              },
            },
          },
        },
      }),
      imageTag: '20260401-120000-abc4',
    });

    const output = formatDeployPlan(plan);
    expect(output).toContain('= default (web-stack)');
  });

  it('includes summary line', () => {
    const plan = computeDeployPlan({
      infra: createInfra({
        services: {
          api: { path: 'apps/api', stacks: ['web-stack'] },
          worker: { path: 'apps/worker', stacks: ['web-stack'] },
        },
      }),
      stageName: 'prod',
      registry: createRegistry(),
      imageTag: '20260401-130000-def7',
    });

    const output = formatDeployPlan(plan);
    expect(output).toContain('Plan: 2 to add, 0 to update, 0 unchanged');
  });
});
