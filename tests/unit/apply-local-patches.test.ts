import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const KAFKAJS_REQUEST_QUEUE_SNIPPET = `  scheduleCheckPendingRequests() {
    // If we're throttled: Schedule checkPendingRequests when the throttle
    // should be resolved. If there is already something scheduled we assume that that
    // will be fine, and potentially fix up a new timeout if needed at that time.
    // Note that if we're merely "overloaded" by having too many inflight requests
    // we will anyways check the queue when one of them gets fulfilled.
    let scheduleAt = this.throttledUntil - Date.now()
    if (!this.throttleCheckTimeoutId) {
      if (this.pending.length > 0) {
        scheduleAt = scheduleAt > 0 ? scheduleAt : CHECK_PENDING_REQUESTS_INTERVAL
      }
      this.throttleCheckTimeoutId = setTimeout(() => {
        this.throttleCheckTimeoutId = null
        this.checkPendingRequests()
      }, scheduleAt)
    }
  }
}`;

describe('apply local patches', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  async function createTempRoot(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'slingshot-local-patches-'));
    return tempDir;
  }

  function createLogger(): { logger: ConsoleLike; messages: string[]; warnings: string[] } {
    const messages: string[] = [];
    const warnings: string[] = [];
    return {
      messages,
      warnings,
      logger: {
        log: message => messages.push(message),
        warn: message => warnings.push(message),
      },
    };
  }

  test('skips cleanly when KafkaJS is not installed locally', async () => {
    const rootDir = await createTempRoot();
    const { applyLocalPatches } = await import(
      `../../scripts/apply-local-patches.ts?empty=${Date.now()}`
    );
    const { logger, messages } = createLogger();

    expect(applyLocalPatches(rootDir, logger)).toEqual({
      patchedCount: 0,
      alreadyPatchedCount: 0,
      skippedCount: 0,
    });
    expect(messages).toEqual([
      '[postinstall] No local KafkaJS installation found; skipping local patches.',
    ]);
  });

  test('patches, detects already-patched files, and reports unexpected source drift', async () => {
    const rootDir = await createTempRoot();
    const requestQueueDir = join(
      rootDir,
      'node_modules',
      'kafkajs',
      'src',
      'network',
      'requestQueue',
    );
    const requestQueuePath = join(requestQueueDir, 'index.js');
    await mkdir(requestQueueDir, { recursive: true });
    await writeFile(requestQueuePath, `${KAFKAJS_REQUEST_QUEUE_SNIPPET}\n`, 'utf8');

    const { applyLocalPatches, collectKafkaJsRequestQueueFiles, KAFKAJS_TIMEOUT_PATCH_MARKER } =
      await import(`../../scripts/apply-local-patches.ts?patched=${Date.now()}`);
    const { logger, messages, warnings } = createLogger();

    expect(collectKafkaJsRequestQueueFiles(rootDir)).toEqual([requestQueuePath]);
    expect(applyLocalPatches(rootDir, logger)).toEqual({
      patchedCount: 1,
      alreadyPatchedCount: 0,
      skippedCount: 0,
    });
    expect(await readFile(requestQueuePath, 'utf8')).toContain(KAFKAJS_TIMEOUT_PATCH_MARKER);

    expect(applyLocalPatches(rootDir, logger)).toEqual({
      patchedCount: 0,
      alreadyPatchedCount: 1,
      skippedCount: 0,
    });

    await writeFile(requestQueuePath, 'module.exports = {}\n', 'utf8');
    expect(applyLocalPatches(rootDir, logger)).toEqual({
      patchedCount: 0,
      alreadyPatchedCount: 0,
      skippedCount: 1,
    });
    expect(messages.some(message => message.includes('KafkaJS local patch already applied'))).toBe(
      true,
    );
    expect(warnings[0]).toContain('KafkaJS patch target did not match expected source');
  });
});

interface ConsoleLike {
  log(message: string): void;
  warn(message: string): void;
}
