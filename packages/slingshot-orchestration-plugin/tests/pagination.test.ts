// packages/slingshot-orchestration-plugin/tests/pagination.test.ts
//
// Tests for parseListRunsQuery() — the URL search-params-to-RunFilter converter
// used by GET /runs. The function is internal to routes.ts, so we test it
// through the HTTP layer by mounting a router with a mock runtime whose listRuns
// captures the parsed filter.
//
// Coverage includes:
// - Default limit/offset when omitted
// - Limit clamping [1, 1000]
// - Offset floor (0)
// - Status, type, and name filters
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { OrchestrationRuntime, Run, RunFilter } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationRouter } from '../src/routes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeRun(id: string): Run {
  return {
    id,
    type: 'task' as const,
    name: 'mock-task',
    status: 'pending' as const,
    input: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Build a harness runtime whose listRuns delegates to the provided spy.
 *
 * The spy receives the parsed RunFilter and returns canned data.
 * A default spy returns 3 fake runs with a total of 3.
 */
function makeSpyRuntime(
  listRunsImpl: (filter?: RunFilter) => Promise<{ runs: Run[]; total: number }> = mock(
    async () => ({ runs: [makeFakeRun('r1'), makeFakeRun('r2'), makeFakeRun('r3')], total: 3 }),
  ),
): { runtime: OrchestrationRuntime; listRunsSpy: typeof listRunsImpl } {
  const listRunsSpy = mock(listRunsImpl);
  const runtime: OrchestrationRuntime = {
    runTask: mock(async () => ({ id: 'run-mock', result: async () => ({}) })),
    runWorkflow: mock(async () => ({ id: 'run-mock', result: async () => ({}) })),
    getRun: mock(async () => null),
    cancelRun: mock(async () => {}),
    signal: mock(async () => {}),
    schedule: mock(async () => ({ id: 'sched-mock' })),
    listRuns: listRunsSpy,
    onProgress: mock(() => () => {}),
    supports: (cap: string) => cap === 'observability',
  } as unknown as OrchestrationRuntime;
  return { runtime, listRunsSpy };
}

function mountRouter(runtime: OrchestrationRuntime): Hono {
  const app = new Hono();
  app.route('/orchestration', createOrchestrationRouter({ runtime, tasks: [], workflows: [] }));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P-OPLUGIN-5 — pagination parameter parsing', () => {
  // ── Limit ──────────────────────────────────────────────────────────────

  test('default filter has no limit or offset when query is empty', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs');

    expect(captured).toBeDefined();
    // When no limit/offset is provided, parseListRunsQuery leaves them undefined
    // so the batched scan or direct call can apply its own defaults.
    expect(captured!.limit).toBeUndefined();
    expect(captured!.offset).toBeUndefined();
  });

  test('limit is parsed from query string', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?limit=10');

    expect(captured?.limit).toBe(10);
  });

  test('limit is clamped to max 1000', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?limit=5000');

    expect(captured?.limit).toBe(1000);
  });

  test('limit is clamped to min 1 when negative', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?limit=-5');

    expect(captured?.limit).toBe(1);
  });

  test('limit is clamped to min 1 when zero', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?limit=0');

    expect(captured?.limit).toBe(1);
  });

  test('non-numeric limit string leaves limit undefined', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?limit=abc');

    // Number('abc') = NaN, Math.trunc(NaN) = NaN, NaN >= 1 is false -> undefined
    expect(captured?.limit).toBeUndefined();
  });

  // ── Offset ─────────────────────────────────────────────────────────────

  test('offset is parsed from query string', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?offset=20');

    expect(captured?.offset).toBe(20);
  });

  test('offset is clamped to 0 when negative', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?offset=-1');

    expect(captured?.offset).toBe(0);
  });

  test('non-numeric offset string leaves offset undefined', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?offset=xyz');

    expect(captured?.offset).toBeUndefined();
  });

  // ── Status filter ──────────────────────────────────────────────────────

  test('single valid status is passed as a string', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?status=pending');

    expect(captured?.status).toBe('pending');
  });

  test('multiple statuses are passed as an array', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?status=pending&status=running');

    expect(Array.isArray(captured?.status)).toBe(true);
    expect(captured?.status).toContain('pending');
    expect(captured?.status).toContain('running');
  });

  test('invalid status values are filtered out', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?status=invalid_status');

    // All statuses invalid -> undefined
    expect(captured?.status).toBeUndefined();
  });

  test('all valid RunStatus values are accepted', async () => {
    const validStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'];
    for (const status of validStatuses) {
      let captured: RunFilter | undefined;
      const { runtime } = makeSpyRuntime(async filter => {
        captured = filter;
        return { runs: [], total: 0 };
      });
      const app = mountRouter(runtime);

      await app.request(`/orchestration/runs?status=${status}`);
      expect(captured?.status).toBe(status);
    }
  });

  test('mixed valid and invalid statuses keep only the valid ones (single valid = string, not array)', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?status=pending&status=invalid_xyz');

    // When only one valid status remains, parseListRunsQuery returns the string directly.
    expect(captured?.status).toBe('pending');
  });

  // ── Type filter ────────────────────────────────────────────────────────

  test('type=task is passed through', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?type=task');

    expect(captured?.type).toBe('task');
  });

  test('type=workflow is passed through', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?type=workflow');

    expect(captured?.type).toBe('workflow');
  });

  test('invalid type value is ignored', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?type=invalid');

    expect(captured?.type).toBeUndefined();
  });

  // ── Name filter ────────────────────────────────────────────────────────

  test('name filter is passed through', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?name=my-task');

    expect(captured?.name).toBe('my-task');
  });

  test('empty name query param passes through as empty string', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request('/orchestration/runs?name=');

    // searchParams.get('name') returns '' and '' ?? undefined is '' since
    // empty string is not nullish. This is the current behaviour — the empty
    // string is passed through rather than being normalised to undefined.
    expect(captured?.name).toBe('');
  });

  // ── Combined ───────────────────────────────────────────────────────────

  test('all query parameters are parsed together', async () => {
    let captured: RunFilter | undefined;
    const { runtime } = makeSpyRuntime(async filter => {
      captured = filter;
      return { runs: [], total: 0 };
    });
    const app = mountRouter(runtime);

    await app.request(
      '/orchestration/runs?limit=25&offset=5&status=completed&type=workflow&name=my-wf',
    );

    expect(captured?.limit).toBe(25);
    expect(captured?.offset).toBe(5);
    expect(captured?.status).toBe('completed');
    expect(captured?.type).toBe('workflow');
    expect(captured?.name).toBe('my-wf');
  });
});
