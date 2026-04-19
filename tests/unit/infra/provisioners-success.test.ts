import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MongoResourceConfig } from '../../../packages/slingshot-infra/src/resource/provisioners/mongo';
import type { ResourceProvisionerContext } from '../../../packages/slingshot-infra/src/types/resource';

const provisionViaSstMock = mock(async () => ({
  success: true,
  outputs: {
    docsHost: 'docdb.cluster.local',
    docsPort: '27017',
    docsUsername: 'admin',
    docsPassword: 'secret',
    docsDatabase: 'testorg',
  },
}));

const destroyViaSstMock = mock(async () => {});

mock.module('../../../packages/slingshot-infra/src/resource/provisionViaSst', () => ({
  provisionViaSst: provisionViaSstMock,
  destroyViaSst: destroyViaSstMock,
  // Include the real parseSstOutputs so sst-provisioning.test.ts can import it from this module.
  parseSstOutputs(stdout: string): Record<string, string> {
    const outputs: Record<string, string> = {};
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*"outputs"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.outputs && typeof parsed.outputs === 'object') {
          for (const [key, value] of Object.entries(parsed.outputs)) {
            outputs[key] = String(value);
          }
          return outputs;
        }
      }
    } catch {
      // Not JSON, fall through to line-based parsing
    }
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*(\w+)\s*=\s*(.+)$/);
      if (match) {
        outputs[match[1].trim()] = match[2].trim();
      }
    }
    return outputs;
  },
}));

/**
 * Build a globalThis.fetch replacement that simulates MongoDB Atlas API responses.
 *
 * The real digestFetch() does a two-step HTTP flow:
 *   1. First request → always 401 with WWW-Authenticate: Digest header
 *   2. Second request (with Authorization: Digest) → real response
 *
 * We track which cluster names have been deleted for polling simulation.
 */
function makeAtlasFetch(
  deletedClusters: Set<string>,
): (url: string | URL | Request, opts?: RequestInit) => Promise<Response> {
  const digestChallenge = new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate':
        'Digest realm="MMS Public API", qop="auth", nonce="testnonce123", opaque="testopaque456"',
    },
  });

  // Track call count per URL+method to distinguish challenge vs authenticated request
  const callCounts = new Map<string, number>();

  return async (url: string | URL | Request, opts?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const method = opts?.method ?? 'GET';
    const key = `${method}:${urlStr}`;
    const count = (callCounts.get(key) ?? 0) + 1;
    callCounts.set(key, count);

    // First call to any URL returns a 401 digest challenge
    if (count === 1) {
      return digestChallenge.clone();
    }

    // Second call (authenticated) — return actual response
    const clusterKey = urlStr.includes('/clusters/')
      ? urlStr.split('/clusters/')[1]!.split('?')[0]!
      : '';

    if (method === 'POST' && urlStr.endsWith('/clusters')) {
      return new Response('{}', { status: 200 });
    }

    if (method === 'GET' && urlStr.includes('/clusters/')) {
      if (deletedClusters.has(clusterKey)) {
        return new Response('{}', { status: 404 });
      }
      return new Response(
        JSON.stringify({
          stateName: 'IDLE',
          connectionStrings: { standardSrv: 'mongodb+srv://cluster0.example.mongodb.net' },
        }),
        { status: 200 },
      );
    }

    if (method === 'POST' && urlStr.endsWith('/databaseUsers')) {
      return new Response('{}', { status: 200 });
    }

    if (method === 'DELETE' && urlStr.includes('/clusters/')) {
      deletedClusters.add(clusterKey);
      return new Response('{}', { status: 202 });
    }

    if (method === 'DELETE' && urlStr.includes('/databaseUsers/')) {
      return new Response('{}', { status: 204 });
    }

    return new Response('{}', { status: 200 });
  };
}

function makeCtx(overrides: Partial<ResourceProvisionerContext> = {}): ResourceProvisionerContext {
  const ctx = {
    resourceName: 'docs',
    config: {
      type: 'documentdb',
      provision: true,
      stages: {
        dev: { instanceClass: 'db.t3.medium' },
      },
    },
    stageName: 'dev',
    region: 'us-east-1',
    platform: 'testorg',
    ...overrides,
  };
  return ctx as ResourceProvisionerContext;
}

describe('provisioner success paths', () => {
  let originalSetTimeout: typeof setTimeout;
  let originalDateNow: typeof Date.now;
  let originalFetch: typeof globalThis.fetch;
  const deletedClusters = new Set<string>();

  beforeEach(() => {
    provisionViaSstMock.mockClear();
    destroyViaSstMock.mockClear();
    deletedClusters.clear();
    originalSetTimeout = globalThis.setTimeout;
    originalDateNow = Date.now;
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeAtlasFetch(deletedClusters) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    delete process.env.ATLAS_PUBLIC_KEY;
    delete process.env.ATLAS_PRIVATE_KEY;
  });

  it('DocumentDB provision uses SST outputs and maps connection env', async () => {
    const { createDocumentDbProvisioner } =
      await import('../../../packages/slingshot-infra/src/resource/provisioners/documentdb');

    const provisioner = createDocumentDbProvisioner();
    const result = await provisioner.provision(makeCtx());

    expect(provisionViaSstMock).toHaveBeenCalledTimes(1);
    const call = (provisionViaSstMock.mock.calls[0] as unknown[])[0] as { sstConfig: string };
    expect(call.sstConfig).toContain('aws.docdb.Cluster');
    expect(call.sstConfig).toContain('DocsPassword');
    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.DOCUMENTDB_HOST).toBe('docdb.cluster.local');
    expect(result.connectionEnv.DOCUMENTDB_PORT).toBe('27017');
    expect(result.connectionEnv.DOCUMENTDB_USER).toBe('admin');
    expect(result.connectionEnv.DOCUMENTDB_PASSWORD).toBe('secret');
    expect(result.connectionEnv.DOCUMENTDB_DB).toBe('testorg');
  });

  it('DocumentDB destroy uses SST destroy path', async () => {
    const { createDocumentDbProvisioner } =
      await import('../../../packages/slingshot-infra/src/resource/provisioners/documentdb');

    const provisioner = createDocumentDbProvisioner();
    await provisioner.destroy(makeCtx());

    expect(destroyViaSstMock).toHaveBeenCalledTimes(1);
    const call = (destroyViaSstMock.mock.calls[0] as unknown[])[0] as { sstConfig: string };
    expect(call.sstConfig).toContain('aws.docdb.Cluster');
    expect(call.sstConfig).toContain('DocsPassword');
  });

  it('Mongo provision creates a cluster, user, and connection env', async () => {
    const { createMongoProvisioner } =
      await import('../../../packages/slingshot-infra/src/resource/provisioners/mongo');

    process.env.ATLAS_PUBLIC_KEY = 'pub';
    process.env.ATLAS_PRIVATE_KEY = 'priv';
    globalThis.setTimeout = ((cb: TimerHandler) => {
      if (typeof cb === 'function') cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    let nowCalls = 0;
    Date.now = (() => {
      nowCalls += 1;
      return nowCalls === 1 ? 0 : 1;
    }) as typeof Date.now;

    const provisioner = createMongoProvisioner();
    const mongoConfigData = {
      type: 'mongo',
      provision: true,
      atlas: {
        orgId: 'org-1',
        projectId: 'proj-1',
      },
      stages: {
        dev: { instanceClass: 'M20' },
      },
    };
    const mongoConfig = mongoConfigData as unknown as MongoResourceConfig;
    const mongoCtxData = {
      resourceName: 'mongo',
      config: mongoConfig,
      stageName: 'dev',
      region: 'us-east-1',
      platform: 'testorg',
    };
    const mongoCtx = mongoCtxData as unknown as ResourceProvisionerContext;
    const result = await provisioner.provision(mongoCtx);

    expect(result.status).toBe('provisioned');
    expect(result.connectionEnv.MONGO_URL).toContain('mongodb+srv://');
    expect(result.connectionEnv.MONGO_HOST).toBe('cluster0.example.mongodb.net');
    expect(result.connectionEnv.MONGO_USER).toBe('testorg-dev');
    expect(result.connectionEnv.MONGO_DB).toBe('testorg');
  });

  it('Mongo destroy deletes the cluster and user then polls for deletion', async () => {
    const { createMongoProvisioner } =
      await import('../../../packages/slingshot-infra/src/resource/provisioners/mongo');

    process.env.ATLAS_PUBLIC_KEY = 'pub';
    process.env.ATLAS_PRIVATE_KEY = 'priv';
    globalThis.setTimeout = ((cb: TimerHandler) => {
      if (typeof cb === 'function') cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    let nowCalls = 0;
    Date.now = (() => {
      nowCalls += 1;
      return nowCalls === 1 ? 0 : 1;
    }) as typeof Date.now;

    const provisioner = createMongoProvisioner();
    const destroyMongoConfigData = {
      type: 'mongo',
      provision: true,
      atlas: {
        orgId: 'org-1',
        projectId: 'proj-1',
      },
    };
    const destroyMongoConfig = destroyMongoConfigData as unknown as MongoResourceConfig;
    const destroyCtxData = {
      resourceName: 'mongo',
      config: destroyMongoConfig,
      stageName: 'dev',
      region: 'us-east-1',
      platform: 'testorg',
    };
    const destroyCtx = destroyCtxData as unknown as ResourceProvisionerContext;
    await provisioner.destroy(destroyCtx);

    // destroy() calls: DELETE cluster, DELETE user, GET cluster (poll until gone)
    // Each is a 2-step digest flow (challenge + authenticated), so 6 fetch calls total
    // The cluster delete returns 202, then polling GET returns 404 (cluster deleted)
    expect(deletedClusters.size).toBeGreaterThan(0);
  });
});
