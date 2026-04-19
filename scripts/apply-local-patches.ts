import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PATCH_MARKER =
  'slingshot-local-patch(kafkajs-timeoutnegativewarning): remove when upstream KafkaJS ships a stable fix for issue #1751 / PR #1768';

const OLD_SNIPPET = `  scheduleCheckPendingRequests() {
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

const NEW_SNIPPET = `  scheduleCheckPendingRequests() {
    // slingshot-local-patch(kafkajs-timeoutnegativewarning): remove when upstream KafkaJS
    // ships a stable fix for issue #1751 / PR #1768. Bun and modern Node warn when
    // setTimeout receives a negative delay; if there are no pending requests and throttling
    // has already expired, there is nothing useful to schedule.
    let scheduleAt = this.throttledUntil - Date.now()
    if (!this.throttleCheckTimeoutId) {
      if (this.pending.length > 0) {
        scheduleAt = scheduleAt > 0 ? scheduleAt : CHECK_PENDING_REQUESTS_INTERVAL
      } else if (scheduleAt <= 0) {
        return
      }
      this.throttleCheckTimeoutId = setTimeout(() => {
        this.throttleCheckTimeoutId = null
        this.checkPendingRequests()
      }, scheduleAt)
    }
  }
}`;

function collectKafkaJsRequestQueueFiles(rootDir: string): string[] {
  const files: string[] = [];

  const bunDir = join(rootDir, 'node_modules', '.bun');
  if (existsSync(bunDir)) {
    for (const entry of readdirSync(bunDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('kafkajs@')) continue;
      const candidate = join(
        bunDir,
        entry.name,
        'node_modules',
        'kafkajs',
        'src',
        'network',
        'requestQueue',
        'index.js',
      );
      if (existsSync(candidate)) {
        files.push(candidate);
      }
    }
  }

  const directCandidate = join(
    rootDir,
    'node_modules',
    'kafkajs',
    'src',
    'network',
    'requestQueue',
    'index.js',
  );
  if (existsSync(directCandidate)) {
    files.push(directCandidate);
  }

  return [...new Set(files)];
}

function patchKafkaJsRequestQueue(filePath: string): 'patched' | 'already-patched' | 'skipped' {
  const source = readFileSync(filePath, 'utf8');
  if (source.includes(PATCH_MARKER)) {
    return 'already-patched';
  }
  if (!source.includes(OLD_SNIPPET)) {
    return 'skipped';
  }

  writeFileSync(filePath, source.replace(OLD_SNIPPET, NEW_SNIPPET), 'utf8');
  return 'patched';
}

const rootDir = resolve(import.meta.dir, '..');
const kafkaJsFiles = collectKafkaJsRequestQueueFiles(rootDir);

if (kafkaJsFiles.length === 0) {
  console.log('[postinstall] No local KafkaJS installation found; skipping local patches.');
  process.exit(0);
}

let patchedCount = 0;
let alreadyPatchedCount = 0;

for (const filePath of kafkaJsFiles) {
  const result = patchKafkaJsRequestQueue(filePath);
  if (result === 'patched') {
    patchedCount += 1;
    console.log(`[postinstall] Patched KafkaJS request queue timeout handling: ${filePath}`);
  } else if (result === 'already-patched') {
    alreadyPatchedCount += 1;
  } else {
    console.warn(
      `[postinstall] KafkaJS patch target did not match expected source; leaving file unchanged: ${filePath}`,
    );
  }
}

if (alreadyPatchedCount > 0 && patchedCount === 0) {
  console.log('[postinstall] KafkaJS local patch already applied.');
}
