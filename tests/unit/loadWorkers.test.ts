import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { loadWorkers } from '../../src/framework/workers/loadWorkers';
import * as queueModule from '../../src/lib/queue';

const tempDirs: string[] = [];

afterEach(() => {
  const mocked = queueModule.createQueueFactory as unknown as { mockRestore?: () => void };
  mocked.mockRestore?.();

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempWorkersDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slingshot-workers-'));
  tempDirs.push(dir);
  return dir;
}

describe('loadWorkers', () => {
  test('persists current worker names and cleans up stale schedulers from previous deploys', async () => {
    const workersDir = createTempWorkersDir();
    writeFileSync(
      join(workersDir, 'worker-a.ts'),
      "export default async function boot() { return ['keep-b', 'new-c']; }\n",
      'utf8',
    );

    const cleanupStaleSchedulers = mock(async () => {});
    const createQueueFactory = spyOn(queueModule, 'createQueueFactory').mockReturnValue({
      createQueue: mock(() => {
        throw new Error('not used');
      }),
      createWorker: mock(() => {
        throw new Error('not used');
      }),
      createCronWorker: mock(() => {
        throw new Error('not used');
      }),
      cleanupStaleSchedulers,
      createDLQHandler: mock(() => {
        throw new Error('not used');
      }),
    } as unknown as never);

    const save = mock(async () => {});

    await loadWorkers({
      workersDir: workersDir.replace(/\\/g, '/'),
      runtime: {
        glob: {
          scan: async () => ['worker-a.ts'],
        },
      } as unknown as never,
      resolvedSecrets: {
        redisHost: '127.0.0.1:6379',
      },
      persistence: {
        cronRegistry: {
          getAll: async () => new Set(['old-a', 'keep-b']),
          save,
        },
      },
    });

    expect(createQueueFactory).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);

    const savedNames = [...((save.mock.calls[0]?.[0] as ReadonlySet<string>) ?? [])].sort();
    expect(savedNames).toEqual(['keep-b', 'new-c']);

    expect(cleanupStaleSchedulers).toHaveBeenCalledTimes(1);
    const [currentNames, knownNames] = cleanupStaleSchedulers.mock.calls[0] as unknown as [
      string[],
      ReadonlySet<string>,
    ];
    expect([...currentNames].sort()).toEqual(['keep-b', 'new-c']);
    expect([...knownNames].sort()).toEqual(['keep-b', 'new-c', 'old-a']);
  });

  test('swallows error when createQueueFactory throws (bullmq not installed path)', async () => {
    // Exercises the catch block at lines 24-26: when createQueueFactory throws, worker
    // bootstrapping is skipped gracefully rather than crashing the server.
    const workersDir = createTempWorkersDir();
    writeFileSync(
      join(workersDir, 'worker-safe.ts'),
      "export default async function boot() { return ['some-job']; }\n",
      'utf8',
    );

    const createQueueFactory = spyOn(queueModule, 'createQueueFactory').mockImplementation(() => {
      throw new Error('Cannot find module bullmq');
    });
    const save = mock(async () => {});

    // Should not throw — error is swallowed silently
    await expect(
      loadWorkers({
        workersDir: workersDir.replace(/\\/g, '/'),
        runtime: {
          glob: {
            scan: async () => ['worker-safe.ts'],
          },
        } as unknown as never,
        resolvedSecrets: {
          redisHost: '127.0.0.1:6379',
        },
        persistence: {
          cronRegistry: {
            getAll: async () => new Set<string>(),
            save,
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(createQueueFactory).toHaveBeenCalledTimes(1);
    // Workers were not initialized — queueFactory is null — so no scheduler names collected
    const savedNames = [...((save.mock.calls[0]?.[0] as ReadonlySet<string>) ?? [])];
    expect(savedNames).toEqual([]);
  });

  test('swallows error when cleanupStaleSchedulers throws (best-effort path)', async () => {
    // Exercises the catch block at lines 59-61: when cleanupStaleSchedulers throws,
    // the error is swallowed to avoid crashing on Redis unavailability.
    const workersDir = createTempWorkersDir();
    writeFileSync(
      join(workersDir, 'worker-c.ts'),
      "export default async function boot() { return ['job-x']; }\n",
      'utf8',
    );

    const cleanupStaleSchedulers = mock(async () => {
      throw new Error('Redis unavailable');
    });
    spyOn(queueModule, 'createQueueFactory').mockReturnValue({
      createQueue: mock(() => { throw new Error('not used'); }),
      createWorker: mock(() => { throw new Error('not used'); }),
      createCronWorker: mock(() => { throw new Error('not used'); }),
      cleanupStaleSchedulers,
      createDLQHandler: mock(() => { throw new Error('not used'); }),
    } as unknown as never);

    const save = mock(async () => {});

    await expect(
      loadWorkers({
        workersDir: workersDir.replace(/\\/g, '/'),
        runtime: {
          glob: { scan: async () => ['worker-c.ts'] },
        } as unknown as never,
        resolvedSecrets: { redisHost: '127.0.0.1:6379' },
        persistence: {
          cronRegistry: {
            getAll: async () => new Set<string>(),
            save,
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(cleanupStaleSchedulers).toHaveBeenCalledTimes(1);
  });

  test('skips worker bootstrapping cleanup when redis secrets are unavailable', async () => {
    const workersDir = createTempWorkersDir();
    writeFileSync(
      join(workersDir, 'worker-b.ts'),
      "export default async function boot() { throw new Error('should not run without queue factory'); }\n",
      'utf8',
    );

    const createQueueFactory = spyOn(queueModule, 'createQueueFactory');
    const save = mock(async () => {});

    await loadWorkers({
      workersDir: workersDir.replace(/\\/g, '/'),
      runtime: {
        glob: {
          scan: async () => ['worker-b.ts'],
        },
      } as unknown as never,
      resolvedSecrets: {},
      persistence: {
        cronRegistry: {
          getAll: async () => new Set(['old-a']),
          save,
        },
      },
    });

    expect(createQueueFactory).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    const savedNames = [...((save.mock.calls[0]?.[0] as ReadonlySet<string>) ?? [])];
    expect(savedNames).toEqual([]);
  });
});
