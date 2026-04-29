// packages/slingshot-orchestration-plugin/tests/validation-edge.test.ts
//
// Edge-case tests for orchestrationPluginConfigSchema: all config fields,
// invalid adapter types, routeMiddleware validation, and timeout configuration.
import { describe, expect, test } from 'bun:test';
import { orchestrationPluginConfigSchema } from '../src/validation';

function parse(value: unknown) {
  return orchestrationPluginConfigSchema.safeParse(value);
}

function valid(value: unknown) {
  const result = parse(value);
  expect(result.success).toBe(true);
  return result.success ? result.data : null;
}

function invalid(value: unknown) {
  const result = parse(value);
  expect(result.success).toBe(false);
  return result.success ? null : result.error;
}

const minimalMemory = {
  adapter: { type: 'memory' },
  tasks: ['taskA'],
};

describe('orchestrationPluginConfigSchema — all valid adapter types', () => {
  test('accepts memory adapter', () => {
    valid({ adapter: { type: 'memory' }, tasks: ['t1'] });
  });

  test('accepts sqlite adapter', () => {
    valid({ adapter: { type: 'sqlite' }, tasks: ['t1'] });
  });

  test('accepts bullmq adapter', () => {
    valid({ adapter: { type: 'bullmq' }, tasks: ['t1'] });
  });

  test('accepts temporal adapter', () => {
    valid({
      adapter: {
        type: 'temporal',
        config: {
          address: 'localhost:7233',
          workflowTaskQueue: 'wf-queue',
        },
      },
      tasks: ['t1'],
    });
  });

  test('rejects unknown adapter type', () => {
    const err = invalid({ adapter: { type: 'redis' }, tasks: ['t1'] });
    expect(err).toBeDefined();
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('type'))).toBe(true);
  });

  test('rejects adapter type with wrong casing', () => {
    const err = invalid({ adapter: { type: 'Memory' }, tasks: ['t1'] });
    expect(err).toBeDefined();
  });
});

describe('orchestrationPluginConfigSchema — routeMiddleware validation', () => {
  test('accepts routeMiddleware with valid handler ref', () => {
    const data = valid({
      ...minimalMemory,
      routeMiddleware: [{ handler: 'authGuard' }],
    });
    expect(data?.routeMiddleware).toHaveLength(1);
    expect(data?.routeMiddleware![0].handler).toBe('authGuard');
  });

  test('accepts routeMiddleware with params', () => {
    const data = valid({
      ...minimalMemory,
      routeMiddleware: [{ handler: 'tenantGuard', params: { tenantId: 'abc' } }],
    });
    expect(data?.routeMiddleware![0].params).toEqual({ tenantId: 'abc' });
  });

  test('rejects routeMiddleware with empty handler string', () => {
    const err = invalid({
      ...minimalMemory,
      routeMiddleware: [{ handler: '' }],
    });
    expect(err).toBeDefined();
  });

  test('rejects routeMiddleware with extra unknown fields (strict schema)', () => {
    const err = invalid({
      ...minimalMemory,
      routeMiddleware: [{ handler: 'guard', unknownField: true }],
    });
    expect(err).toBeDefined();
  });

  test('accepts multiple middleware entries', () => {
    const data = valid({
      ...minimalMemory,
      routeMiddleware: [
        { handler: 'auth' },
        { handler: 'tenant', params: { id: 't1' } },
        { handler: 'rate' },
      ],
    });
    expect(data?.routeMiddleware).toHaveLength(3);
  });
});

describe('orchestrationPluginConfigSchema — routePrefix and routes flags', () => {
  test('accepts custom routePrefix', () => {
    const data = valid({ ...minimalMemory, routePrefix: '/custom-prefix' });
    expect(data?.routePrefix).toBe('/custom-prefix');
  });

  test('rejects empty routePrefix', () => {
    const err = invalid({ ...minimalMemory, routePrefix: '' });
    expect(err).toBeDefined();
  });

  test('accepts routes: false', () => {
    const data = valid({ ...minimalMemory, routes: false });
    expect(data?.routes).toBe(false);
  });

  test('accepts routes: true', () => {
    const data = valid({ ...minimalMemory, routes: true });
    expect(data?.routes).toBe(true);
  });
});

describe('orchestrationPluginConfigSchema — workflows and tasks', () => {
  test('accepts single task', () => {
    const data = valid({ ...minimalMemory, tasks: ['my-task'] });
    expect(data?.tasks).toEqual(['my-task']);
  });

  test('accepts multiple tasks', () => {
    const data = valid({ ...minimalMemory, tasks: ['a', 'b', 'c'] });
    expect(data?.tasks).toHaveLength(3);
  });

  test('rejects empty string in tasks array', () => {
    const err = invalid({ adapter: { type: 'memory' }, tasks: ['valid-name', ''] });
    expect(err).toBeDefined();
  });

  test('accepts workflows array', () => {
    const data = valid({ ...minimalMemory, workflows: ['wf1', 'wf2'] });
    expect(data?.workflows).toEqual(['wf1', 'wf2']);
  });
});

describe('orchestrationPluginConfigSchema — resolveRequestContext and authorizeRun', () => {
  test('accepts resolveRequestContext handler ref', () => {
    const data = valid({
      ...minimalMemory,
      resolveRequestContext: { handler: 'myResolver' },
    });
    expect(data?.resolveRequestContext).toBeDefined();
  });

  test('accepts authorizeRun handler ref', () => {
    const data = valid({
      ...minimalMemory,
      authorizeRun: { handler: 'myAuthorizer' },
    });
    expect(data?.authorizeRun).toBeDefined();
  });

  test('rejects resolveRequestContext with empty handler', () => {
    const err = invalid({
      ...minimalMemory,
      resolveRequestContext: { handler: '' },
    });
    expect(err).toBeDefined();
  });
});
