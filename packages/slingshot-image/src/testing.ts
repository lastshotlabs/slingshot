// packages/slingshot-image/src/testing.ts
/**
 * Test utilities for `@lastshotlabs/slingshot-image`.
 *
 * Provides helpers for unit and integration testing of image plugins
 * without requiring a real `sharp` installation.
 *
 * @example
 * ```ts
 * import { createImageTestApp, createMockSharpFn } from '@lastshotlabs/slingshot-image/testing';
 *
 * const app = createImageTestApp({ allowedOrigins: ['cdn.example.com'] });
 * const res = await app.request('/_snapshot/image?url=%2Ftest.jpg&w=100');
 * ```
 */
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createMemoryImageCache } from './cache';
import { buildImageRouter } from './routes';
import type { ImageCacheAdapter, ImageTransformResult } from './types';

interface MockSharpPipeline {
  resize: () => MockSharpPipeline;
  avif: () => MockSharpPipeline;
  webp: () => MockSharpPipeline;
  jpeg: () => MockSharpPipeline;
  png: () => MockSharpPipeline;
  toBuffer: () => Promise<Buffer>;
}

/**
 * Options for `createImageTestApp()`.
 */
export interface ImageTestAppOptions {
  /** Allowed origins for SSRF validation. Defaults to `[]`. */
  readonly allowedOrigins?: readonly string[];
  /** Maximum width. Defaults to `4096`. */
  readonly maxWidth?: number;
  /** Maximum height. Defaults to `4096`. */
  readonly maxHeight?: number;
  /** Route prefix. Defaults to `'/_snapshot/image'`. */
  readonly routePrefix?: string;
  /** Custom cache adapter. Defaults to a fresh in-memory LRU cache. */
  readonly cache?: ImageCacheAdapter;
  /**
   * Optional setup callback to register routes on the app before the
   * image router is mounted (e.g., to add test image source routes).
   */
  readonly setup?: (app: Hono<AppEnv>) => void;
}

/**
 * Create a minimal Hono app with the image router registered for testing.
 *
 * This is a lightweight alternative to booting the full plugin lifecycle.
 * It wires `buildImageRouter()` directly onto a fresh Hono instance with
 * the provided configuration.
 *
 * @param opts - Test app configuration.
 * @returns A Hono app ready for `app.request()` calls.
 *
 * @example
 * ```ts
 * const app = createImageTestApp({
 *   allowedOrigins: ['cdn.example.com'],
 *   setup: (app) => {
 *     app.get('/uploads/test.png', (c) =>
 *       c.body(Buffer.from('...'), 200, { 'content-type': 'image/png' })
 *     );
 *   },
 * });
 * const res = await app.request('/_snapshot/image?url=%2Fuploads%2Ftest.png&w=100');
 * ```
 */
export function createImageTestApp(opts?: ImageTestAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const cache = opts?.cache ?? createMemoryImageCache();

  // Run optional setup before mounting the image router
  opts?.setup?.(app);

  buildImageRouter(
    app,
    {
      allowedOrigins: opts?.allowedOrigins ?? [],
      maxWidth: opts?.maxWidth ?? 4096,
      maxHeight: opts?.maxHeight ?? 4096,
      routePrefix: opts?.routePrefix ?? '/_snapshot/image',
    },
    cache,
  );

  return app;
}

/**
 * Create a mock sharp function for testing transform behavior without
 * the real `sharp` library installed.
 *
 * Returns a function that mimics the sharp constructor signature and
 * produces a predictable output buffer.
 *
 * @param outputContentType - MIME type for the mock output. Defaults to `'image/jpeg'`.
 * @returns A function compatible with the sharp constructor shape.
 */
export function createMockSharpFn(
  outputContentType?: string,
): (input?: Buffer) => MockSharpPipeline {
  void outputContentType;
  const makePipeline = (): MockSharpPipeline => ({
    resize: () => makePipeline(),
    avif: () => makePipeline(),
    webp: () => makePipeline(),
    jpeg: () => makePipeline(),
    png: () => makePipeline(),
    toBuffer: () => Promise.resolve(Buffer.from('mock-output')),
  });

  return () => makePipeline();
}

/**
 * Create a mock `ImageTransformResult` for cache testing.
 *
 * @param label - Optional label encoded into the buffer for identification.
 * @param contentType - MIME type. Defaults to `'image/jpeg'`.
 */
export function createMockTransformResult(
  label?: string,
  contentType?: string,
): ImageTransformResult {
  return {
    buffer: new TextEncoder().encode(label ?? 'mock-image').buffer as ArrayBuffer,
    contentType: contentType ?? 'image/jpeg',
  };
}
