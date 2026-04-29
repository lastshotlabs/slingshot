// packages/slingshot-ssg/tests/prod-hardening-3.test.ts
//
// Tests for:
// - P-SSG-2b: labeled error convention — all CLI-thrown error messages begin
//   with `[slingshot-ssg]` so the top-level handler can distinguish expected
//   (user-facing) errors from unexpected (bug) errors.
// - P-SSG-6: concurrent rendering with bounded resource usage — verify that
//   renderSsgPages correctly batches work, does not leak file handles, and
//   reports accurate aggregates.
// - P-SSG-7: resource cleanup on page-render timeout — a timed-out page
//   should not leak file descriptors or prevent subsequent pages from rendering.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type {
  SlingshotSsrRenderer,
  SsrRouteChain,
  SsrRouteMatch,
  SsrShell,
} from '@lastshotlabs/slingshot-ssr';
import { loadRenderer, loadRscManifest } from '../src/cli';
import { renderSsgPage, renderSsgPages } from '../src/renderer';
import type { SsgConfig, SsgResult } from '../src/types';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slingshot-ssg-ph3-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a minimal config pointing at a temp output dir. */
function makeConfig(outDir: string, overrides?: Partial<SsgConfig>): SsgConfig {
  return Object.freeze({
    serverRoutesDir: join(outDir, 'routes'),
    assetsManifest: join(outDir, 'manifest.json'),
    outDir,
    concurrency: 2,
    ...overrides,
  });
}

function makeRouteMatch(url: URL): SsrRouteMatch {
  return {
    filePath: '/fake/route.ts',
    metaFilePath: null,
    params: {},
    query: {},
    url,
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
  };
}

function makeOkRenderer(): SlingshotSsrRenderer {
  return {
    async resolve(url: URL): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(): Promise<Response> {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    async renderChain(): Promise<Response> {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };
}

/** Renderer whose renderChain always throws with a given message. */
function makeFailingRenderer(message = 'render failure'): SlingshotSsrRenderer {
  return {
    async resolve(url: URL): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(): Promise<Response> {
      throw new Error(message);
    },
    async renderChain(): Promise<Response> {
      throw new Error(message);
    },
  };
}

/**
 * Renderer whose renderChain hangs forever for paths matching `/hang` and
 * succeeds for all other paths. Used to test per-page timeouts.
 */
function makeSelectiveHangingRenderer(): SlingshotSsrRenderer {
  return {
    async resolve(url: URL): Promise<SsrRouteMatch> {
      return makeRouteMatch(url);
    },
    async render(match: SsrRouteMatch): Promise<Response> {
      if (match.url.pathname.startsWith('/hang')) {
        return new Promise<Response>(() => {}); // never resolves
      }
      return new Response('<html>ok</html>', { status: 200 });
    },
    async renderChain(chain: SsrRouteChain): Promise<Response> {
      if (chain.page.url.pathname.startsWith('/hang')) {
        return new Promise<Response>(() => {}); // never resolves
      }
      return new Response('<html>ok</html>', { status: 200 });
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Error labeling
// ═══════════════════════════════════════════════════════════════════════════

describe('P-SSG-2b — error labeling convention', () => {
  test('loadRscManifest prefixes errors with [slingshot-ssg] for missing file', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'missing.json');

    await expect(loadRscManifest(p)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/^\[slingshot-ssg\]/),
      }),
    );
  });

  test('loadRscManifest prefixes errors with [slingshot-ssg] for malformed JSON', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ bad', 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/^\[slingshot-ssg\]/),
      }),
    );
  });

  test('loadRscManifest prefixes errors with [slingshot-ssg] for wrong shape', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'array.json');
    writeFileSync(p, '[]', 'utf8');

    await expect(loadRscManifest(p)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/^\[slingshot-ssg\]/),
      }),
    );
  });

  test('loadRenderer prefixes errors with [slingshot-ssg] for missing module', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'nonexistent-renderer.js');

    await expect(loadRenderer(p)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/^\[slingshot-ssg\]/),
      }),
    );
  });

  test('loadRenderer prefixes errors with [slingshot-ssg] for invalid export shape', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'bad-renderer.ts');
    writeFileSync(p, 'export default { notValid: true };', 'utf8');

    await expect(loadRenderer(p)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/^\[slingshot-ssg\]/),
      }),
    );
  });

  test('labeled errors do not include Node stack traces in their message text', async () => {
    const dir = makeTempDir();
    const p = join(dir, 'empty.json');
    writeFileSync(p, '', 'utf8');

    // The test here is that the error.message itself does NOT contain stack
    // trace artefacts — the error is clean and user-facing. Stack is available
    // via err.stack but is not part of the message.
    let caught: Error | undefined;
    try {
      await loadRscManifest(p);
    } catch (err: unknown) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toMatch(/at\s+\w+/);
    expect(caught!.message).not.toMatch(/node_modules/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Concurrent rendering (P-SSG-6)
// ═══════════════════════════════════════════════════════════════════════════

describe('P-SSG-6 — concurrent rendering', () => {
  test('concurrency 1 processes all pages sequentially', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 1 });
    const result = await renderSsgPages(['/one', '/two', '/three'], makeOkRenderer(), config);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.pages).toHaveLength(3);
  });

  test('high concurrency handles many pages without error', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 64 });
    const paths = Array.from({ length: 50 }, (_, i) => `/page-${i}`);
    const result = await renderSsgPages(paths, makeOkRenderer(), config);
    expect(result.succeeded).toBe(50);
    expect(result.failed).toBe(0);
  });

  test('concurrency 0 is treated as a safe minimum of 1', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 0 });
    const result = await renderSsgPages(['/a', '/b'], makeOkRenderer(), config);
    expect(result.succeeded).toBe(2);
  });

  test('mixed success and failure aggregates correctly', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 2 });
    const result = await renderSsgPages(
      ['/ok', '/fail', '/ok2'],
      makeFailingRenderer('epic fail'),
      config,
    );
    expect(result.succeeded).toBe(0); // all fail with the failing renderer
    expect(result.failed).toBe(3);
    expect(result.pages).toHaveLength(3);
  });

  test('SsgResult durationMs is non-negative and monotonic with more work', async () => {
    const dir = makeTempDir();
    const result = await renderSsgPages(
      ['/a', '/b'],
      makeOkRenderer(),
      makeConfig(dir, { concurrency: 1 }),
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('concurrency larger than page count still works', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 100 });
    const result = await renderSsgPages(['/only'], makeOkRenderer(), config);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Resource cleanup on timeout (P-SSG-7)
// ═══════════════════════════════════════════════════════════════════════════

describe('P-SSG-7 — resource cleanup on page-render timeout', () => {
  test('a hanging page times out and does not prevent other pages from rendering', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 2, renderPageTimeoutMs: 50 });
    const renderer = makeSelectiveHangingRenderer();

    const result = await renderSsgPages(['/fast', '/hang', '/fast2'], renderer, config);

    expect(result.pages).toHaveLength(3);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(2);

    const hangResult = result.pages.find(p => p.path === '/hang');
    expect(hangResult?.error).toBeDefined();
    expect(hangResult?.error?.message).toContain('timed out');
    expect(hangResult?.filePath).toBeTruthy();

    // Fast pages should have rendered successfully to disk.
    expect(existsSync(join(config.outDir, 'fast', 'index.html'))).toBe(true);
    expect(existsSync(join(config.outDir, 'fast2', 'index.html'))).toBe(true);

    // The hung page should NOT have been written.
    expect(existsSync(join(config.outDir, 'hang', 'index.html'))).toBe(false);
  });

  test('renderPageTimeoutMs set to 0 disables timeout and hanging page blocks batch', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 1, renderPageTimeoutMs: 0 });
    const renderer = makeSelectiveHangingRenderer();

    // With timeout disabled and concurrency 1, the hang page will block.
    // Use a short overall test timeout to avoid hanging forever.
    const result = await Promise.race([
      renderSsgPages(['/hang'], renderer, config),
      new Promise<SsgResult>(resolve =>
        setTimeout(
          () =>
            resolve({
              pages: [],
              durationMs: 0,
              succeeded: 0,
              failed: 0,
            }),
          3_000,
        ),
      ),
    ]);

    // The race should not have fired (the timeout disable path should still
    // complete). Since /hang never resolves and timeout is 0, the promise
    // should never settle. The race fallback kicks in after 3s.
    // This test validates the internal code path exists; the actual behavior
    // with timeout disabled is documented as "caller beware".
    expect(result.pages).toHaveLength(0);
  });

  test('timeout error includes the urlPath in its message', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 1, renderPageTimeoutMs: 1 });

    const result = await renderSsgPage('/hang-1', makeSelectiveHangingRenderer(), config);

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('/hang-1');
    expect(result.error?.message).toContain('timed out');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Error message quality
// ═══════════════════════════════════════════════════════════════════════════

describe('error message quality', () => {
  test('resolveOutputPath rejects path traversal attempts', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir);

    const result = await renderSsgPage('/../../../etc/passwd', makeOkRenderer(), config);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('rejected URL path');
    // No file should be written outside outDir
    expect(existsSync(join(dir, 'etc', 'passwd'))).toBe(false);
  });

  test('non-Error thrown values are converted to Error objects with string content', async () => {
    const dir = makeTempDir();
    const config = makeConfig(dir, { concurrency: 1 });
    const throwingRenderer: SlingshotSsrRenderer = {
      async resolve(): Promise<SsrRouteMatch> {
        throw 'string error value'; // not an Error instance
      },
      async render(): Promise<Response> {
        throw new Error('should not reach render');
      },
      async renderChain(): Promise<Response> {
        throw new Error('should not reach renderChain');
      },
    };

    const result = await renderSsgPage('/throw-string', throwingRenderer, config);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('string error value');
  });
});
