// packages/slingshot-ssg/src/config.schema.ts
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { validatePluginConfig } from '@lastshotlabs/slingshot-core';
import { MAX_CONCURRENCY } from './constants';
import type { SsgConfig } from './types';

const absolutePath = (label: string) =>
  z
    .string()
    .min(1)
    .refine(p => isAbsolute(p), {
      message: `${label} must be an absolute path`,
    });

/**
 * Zod schema for {@link SsgConfig}.
 *
 * Validates at the public API boundary before any filesystem operations begin.
 * Unknown keys are stripped (Zod default) and a warning is emitted by
 * `validatePluginConfig` for each unrecognised field.
 *
 * @internal
 */
export const ssgConfigSchema = z.object({
  serverRoutesDir: absolutePath('serverRoutesDir').describe(
    'Absolute path to the server routes directory used by the SSR file-system router.',
  ),
  assetsManifest: absolutePath('assetsManifest').describe(
    'Absolute path to the Vite client manifest JSON (e.g. dist/client/.vite/manifest.json).',
  ),
  outDir: absolutePath('outDir').describe(
    'Absolute path to the output directory where pre-rendered .html files are written.',
  ),
  concurrency: z
    .number()
    .int()
    .positive()
    .max(MAX_CONCURRENCY, {
      message: `concurrency must be between 1 and ${MAX_CONCURRENCY}`,
    })
    .optional()
    .describe(
      `Maximum number of pages to render in parallel. Must be a positive integer between 1 and ${MAX_CONCURRENCY}. Omit to use the default (4).`,
    ),
  clientEntry: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Vite manifest key for the client entry chunk. Omit to auto-detect from common conventions.',
    ),
  staticPathsTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum milliseconds for staticPaths() / generateStaticParams() to run before the build fails. Default: 60000.',
    ),
  maxStaticPathsPerRoute: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum number of parameter sets a single dynamic route may return. Omit to use the default (10000).',
    ),
  renderPageTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Maximum milliseconds a single page render may take before being recorded as failed. Omit to use the default (60000); set 0 to disable.',
    ),
  retry: z
    .object({
      maxAttempts: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe('Maximum render attempts per page (including initial). Default: 3.'),
      baseDelayMs: z
        .number()
        .int()
        .positive()
        .max(60000)
        .optional()
        .describe('Base backoff delay in ms. Default: 1000.'),
      maxDelayMs: z
        .number()
        .int()
        .positive()
        .max(120000)
        .optional()
        .describe('Maximum backoff delay in ms. Default: 30000.'),
    })
    .optional()
    .describe('Retry configuration for transient render failures.'),
  circuitBreaker: z
    .object({
      threshold: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Consecutive failures before breaker trips. Default: 5.'),
      cooldownMs: z
        .number()
        .int()
        .positive()
        .max(300000)
        .optional()
        .describe('Cooldown in ms before half-open probe. Default: 30000.'),
    })
    .optional()
    .describe('Circuit breaker configuration for external HTTP fetches during rendering.'),
});

/** Parsed and validated SSG configuration produced by {@link ssgConfigSchema}. */
export type SsgConfigParsed = z.infer<typeof ssgConfigSchema>;

/**
 * Validate and parse a raw SSG config object.
 *
 * Replaces an unchecked `rawConfig as SsgConfig` cast with schema-enforced
 * validation. Throws a formatted error listing all issues on failure.
 *
 * @param rawConfig - Untyped config value as received from application code or CLI args.
 * @returns The validated config typed as {@link SsgConfig}.
 */
export function parseSsgConfig(rawConfig: unknown): SsgConfig {
  return validatePluginConfig('slingshot-ssg', rawConfig, ssgConfigSchema) as SsgConfig;
}
