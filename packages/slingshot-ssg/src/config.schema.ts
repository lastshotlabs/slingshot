// packages/slingshot-ssg/src/config.schema.ts
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { validatePluginConfig } from '@lastshotlabs/slingshot-core';
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
    .optional()
    .describe(
      'Maximum number of pages to render in parallel. Must be a positive integer. Omit to use the default (4).',
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
});

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
