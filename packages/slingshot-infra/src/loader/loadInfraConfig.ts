import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DefineInfraConfig } from '../types/infra';

const INFRA_CONFIG_FILES = [
  'slingshot.infra.ts',
  'slingshot.infra.js',
  'slingshot.infra.mts',
  'slingshot.infra.mjs',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Load and return the infra config from a `slingshot.infra.{ts,js,mts,mjs}`
 * file in the specified directory.
 *
 * Unlike `loadPlatformConfig()`, the search does not traverse upward — the
 * config file must exist in `dir`.
 *
 * TypeScript config files require the Bun runtime.
 *
 * @param dir - Directory to search in. Default: `process.cwd()`.
 * @returns The validated `DefineInfraConfig` and the resolved file path.
 *
 * @throws {Error} If no config file is found in `dir`, a `.ts` config is
 *   loaded under Node.js, or the default export is not a valid config.
 *
 * @example
 * ```ts
 * import { loadInfraConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const { config } = await loadInfraConfig(import.meta.dir);
 * console.log('App deploys to stacks:', config.stacks);
 * ```
 */
export async function loadInfraConfig(dir?: string): Promise<{
  config: DefineInfraConfig;
  configPath: string;
}> {
  const searchDir = dir ?? process.cwd();

  for (const filename of INFRA_CONFIG_FILES) {
    const candidate = join(searchDir, filename);
    if (existsSync(candidate)) {
      if (candidate.endsWith('.ts') && typeof globalThis.Bun === 'undefined') {
        throw new Error(
          `[slingshot-infra] Cannot import ${candidate} — TypeScript config files require Bun runtime. ` +
            'Run the CLI with `bunx slingshot` or use a .js config file.',
        );
      }

      const imported: unknown = await import(candidate);
      const config = isRecord(imported) && 'default' in imported ? imported.default : undefined;

      if (!isRecord(config)) {
        throw new Error(
          `[slingshot-infra] ${candidate} must export a default value from defineInfra().`,
        );
      }

      return { config: config as unknown as DefineInfraConfig, configPath: candidate };
    }
  }

  throw new Error(
    `[slingshot-infra] Could not find slingshot.infra.ts in ${searchDir}. ` +
      'Create one to configure infrastructure for this app.',
  );
}
