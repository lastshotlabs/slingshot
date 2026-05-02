/**
 * `defineConfig` E2E:
 *  - Boot loads typed config from process.env via NAMESPACE_FIELD mapping
 *  - Validation failure throws at boot (fail fast)
 *  - get() returns typed validated values after boot
 *  - get() throws before boot
 *  - camelCase fields → SCREAMING_SNAKE env var lookup
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig, loadConfigs } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

const baseConfig = {
  meta: { name: 'Config Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

const teardowns: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of teardowns.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

describe('defineConfig', () => {
  test('get() throws before load, returns typed values after', () => {
    const dbConfig = defineConfig({
      namespace: 'database',
      schema: z.object({
        host: z.string(),
        port: z.coerce.number(),
        poolSize: z.coerce.number().default(10),
      }),
    });

    expect(() => dbConfig.get()).toThrow(/has not been loaded yet/);

    loadConfigs([dbConfig], {
      DATABASE_HOST: 'db.example.com',
      DATABASE_PORT: '5433',
      DATABASE_POOL_SIZE: '20',
    });

    const cfg = dbConfig.get();
    expect(cfg.host).toBe('db.example.com');
    expect(cfg.port).toBe(5433);
    expect(cfg.poolSize).toBe(20);
  });

  test('camelCase fields map to SCREAMING_SNAKE env keys', () => {
    const apiConfig = defineConfig({
      namespace: 'api',
      schema: z.object({
        baseUrl: z.string(),
        maxRetries: z.coerce.number(),
      }),
    });

    loadConfigs([apiConfig], {
      API_BASE_URL: 'https://api.example.com',
      API_MAX_RETRIES: '3',
    });

    const cfg = apiConfig.get();
    expect(cfg.baseUrl).toBe('https://api.example.com');
    expect(cfg.maxRetries).toBe(3);
  });

  test('namespace with dots/hyphens flattens to underscores', () => {
    const flagsConfig = defineConfig({
      namespace: 'feature.flags',
      schema: z.object({ enableX: z.string() }),
    });

    loadConfigs([flagsConfig], {
      FEATURE_FLAGS_ENABLE_X: 'true',
    });

    expect(flagsConfig.get().enableX).toBe('true');
  });

  test('validation failure throws at load time with field paths', () => {
    const config = defineConfig({
      namespace: 'strict',
      schema: z.object({
        port: z.coerce.number(),
        required: z.string(),
      }),
    });

    expect(() =>
      loadConfigs([config], {
        STRICT_PORT: 'not-a-number',
        // STRICT_REQUIRED missing
      }),
    ).toThrow(/Config 'strict' validation failed/);
  });

  test('defaults from schema apply when env var is unset', () => {
    const config = defineConfig({
      namespace: 'defaulted',
      schema: z.object({
        host: z.string().default('localhost'),
        timeout: z.coerce.number().default(5000),
      }),
    });

    loadConfigs([config], {});

    const cfg = config.get();
    expect(cfg.host).toBe('localhost');
    expect(cfg.timeout).toBe(5000);
  });

  test('framework loads configs at boot via defineApp({ configs })', async () => {
    process.env.FRAMETEST_LABEL = 'wired';
    const cfg = defineConfig({
      namespace: 'frametest',
      schema: z.object({ label: z.string() }),
    });

    const result = await createApp({
      ...baseConfig,
      configs: [cfg],
    });
    teardowns.push(result.ctx);

    expect(cfg.get().label).toBe('wired');
    delete process.env.FRAMETEST_LABEL;
  });

  test('boot fails fast when a configured value is invalid', async () => {
    process.env.BOOTFAIL_PORT = 'not-a-number';
    const cfg = defineConfig({
      namespace: 'bootfail',
      schema: z.object({ port: z.coerce.number() }),
    });

    await expect(
      createApp({
        ...baseConfig,
        configs: [cfg],
      }),
    ).rejects.toThrow(/Config 'bootfail' validation failed/);
    delete process.env.BOOTFAIL_PORT;
  });
});
