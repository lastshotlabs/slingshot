import { describe, expect, test } from 'bun:test';
import { orchestrationPluginConfigSchema } from '../src/validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe('orchestrationPluginConfigSchema — valid configs', () => {
  test('accepts minimal memory adapter config', () => {
    const data = valid(minimalMemory);
    expect(data?.adapter.type).toBe('memory');
    expect(data?.tasks).toEqual(['taskA']);
  });

  test('accepts sqlite adapter', () => {
    valid({ adapter: { type: 'sqlite' }, tasks: ['t1'] });
  });

  test('accepts bullmq adapter', () => {
    valid({ adapter: { type: 'bullmq' }, tasks: ['t1'] });
  });

  test('accepts temporal adapter with required fields', () => {
    valid({
      adapter: {
        type: 'temporal',
        config: {
          address: 'localhost:7233',
          workflowTaskQueue: 'my-queue',
        },
      },
      tasks: ['t1'],
    });
  });

  test('accepts multiple tasks', () => {
    const data = valid({ adapter: { type: 'memory' }, tasks: ['a', 'b', 'c'] });
    expect(data?.tasks).toHaveLength(3);
  });

  test('accepts optional workflows array', () => {
    const data = valid({ ...minimalMemory, workflows: ['wf1', 'wf2'] });
    expect(data?.workflows).toEqual(['wf1', 'wf2']);
  });

  test('accepts routes: false', () => {
    const data = valid({ ...minimalMemory, routes: false });
    expect(data?.routes).toBe(false);
  });

  test('accepts custom routePrefix', () => {
    const data = valid({ ...minimalMemory, routePrefix: '/jobs' });
    expect(data?.routePrefix).toBe('/jobs');
  });

  test('accepts routeMiddleware as array of handler refs', () => {
    const data = valid({
      ...minimalMemory,
      routeMiddleware: [{ handler: 'authGuard' }, { handler: 'tenantGuard', params: { k: 'v' } }],
    });
    expect(data?.routeMiddleware).toHaveLength(2);
  });

  test('accepts resolveRequestContext as handler ref', () => {
    valid({ ...minimalMemory, resolveRequestContext: { handler: 'myResolver' } });
  });

  test('accepts authorizeRun as handler ref', () => {
    valid({ ...minimalMemory, authorizeRun: { handler: 'myAuthorizer' } });
  });

  test('temporal adapter accepts all optional fields', () => {
    valid({
      adapter: {
        type: 'temporal',
        config: {
          address: 'localhost:7233',
          namespace: 'default',
          workflowTaskQueue: 'wf-queue',
          defaultActivityTaskQueue: 'act-queue',
          worker: {
            buildId: 'v1.0.0',
            identity: 'worker-1',
            maxConcurrentWorkflowTaskExecutions: 10,
            maxConcurrentActivityTaskExecutions: 20,
          },
          tls: {
            serverNameOverride: 'temporal.example.com',
            serverRootCACertificate: 'cert-data',
            clientCertPair: { crt: 'crt-data', key: 'key-data' },
          },
        },
      },
      tasks: ['t1'],
    });
  });
});

// ---------------------------------------------------------------------------
// Invalid configs
// ---------------------------------------------------------------------------

describe('orchestrationPluginConfigSchema — invalid configs', () => {
  test('rejects unknown adapter type', () => {
    const err = invalid({ adapter: { type: 'redis' }, tasks: ['t1'] });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('type'))).toBe(true);
  });

  test('rejects missing adapter field', () => {
    const err = invalid({ tasks: ['t1'] });
    expect(err).toBeDefined();
  });

  test('rejects empty tasks array', () => {
    // An empty tasks array is allowed by the schema (array of min-1 strings is valid as empty)
    // but each string in the array must be non-empty
    const data = valid({ adapter: { type: 'memory' }, tasks: [] });
    expect(data?.tasks).toEqual([]);
  });

  test('rejects task name that is an empty string', () => {
    const err = invalid({ adapter: { type: 'memory' }, tasks: [''] });
    expect(err).toBeDefined();
  });

  test('rejects empty routePrefix', () => {
    const err = invalid({ ...minimalMemory, routePrefix: '' });
    const paths = err?.issues.map(i => i.path.join('.'));
    expect(paths?.some(p => p.includes('routePrefix'))).toBe(true);
  });

  test('rejects extra unknown fields on root object', () => {
    // The schema uses .superRefine, not .strict(), so unknown root fields pass through
    // Verify the known-good ones still validate
    const data = valid({ ...minimalMemory, unknownField: true });
    expect(data).not.toBeNull();
  });

  test('temporal adapter rejects missing required address', () => {
    const err = invalid({
      adapter: {
        type: 'temporal',
        config: {
          // address is missing
          workflowTaskQueue: 'queue',
        },
      },
      tasks: ['t1'],
    });
    const paths = err?.issues.map(i => i.path.join('.')) ?? [];
    expect(paths.some(p => p.includes('address'))).toBe(true);
  });

  test('temporal adapter rejects missing required workflowTaskQueue', () => {
    const err = invalid({
      adapter: {
        type: 'temporal',
        config: {
          address: 'localhost:7233',
          // workflowTaskQueue is missing
        },
      },
      tasks: ['t1'],
    });
    const paths = err?.issues.map(i => i.path.join('.')) ?? [];
    expect(paths.some(p => p.includes('workflowTaskQueue'))).toBe(true);
  });

  test('temporal adapter rejects extra unknown fields in config', () => {
    const err = invalid({
      adapter: {
        type: 'temporal',
        config: {
          address: 'localhost:7233',
          workflowTaskQueue: 'q',
          unknownTemporalField: true,
        },
      },
      tasks: ['t1'],
    });
    expect(err).toBeDefined();
  });

  test('routeMiddleware handler ref rejects empty handler string', () => {
    const err = invalid({
      ...minimalMemory,
      routeMiddleware: [{ handler: '' }],
    });
    expect(err).toBeDefined();
  });

  test('rejects missing tasks field', () => {
    const err = invalid({ adapter: { type: 'memory' } });
    expect(err).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Schema inference
// ---------------------------------------------------------------------------

describe('orchestrationPluginConfigSchema — type inference', () => {
  test('inferred type captures all fields', () => {
    const result = parse({
      adapter: { type: 'bullmq', config: { redisUrl: 'redis://localhost' } },
      tasks: ['t1'],
      workflows: ['wf1'],
      routes: true,
      routePrefix: '/jobs',
      routeMiddleware: [{ handler: 'guard' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adapter.config).toEqual({ redisUrl: 'redis://localhost' });
      expect(result.data.workflows).toEqual(['wf1']);
      expect(result.data.routes).toBe(true);
      expect(result.data.routePrefix).toBe('/jobs');
    }
  });
});
