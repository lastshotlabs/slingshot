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
    } as never);

    const save = mock(async (_names: ReadonlySet<string>) => {});

    await loadWorkers({
      workersDir: workersDir.replace(/\\/g, '/'),
      runtime: {
        glob: {
          scan: async () => ['worker-a.ts'],
        },
      } as never,
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

  test('skips worker bootstrapping cleanup when redis secrets are unavailable', async () => {
    const workersDir = createTempWorkersDir();
    writeFileSync(
      join(workersDir, 'worker-b.ts'),
      "export default async function boot() { throw new Error('should not run without queue factory'); }\n",
      'utf8',
    );

    const createQueueFactory = spyOn(queueModule, 'createQueueFactory');
    const save = mock(async (_names: ReadonlySet<string>) => {});

    await loadWorkers({
      workersDir: workersDir.replace(/\\/g, '/'),
      runtime: {
        glob: {
          scan: async () => ['worker-b.ts'],
        },
      } as never,
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
