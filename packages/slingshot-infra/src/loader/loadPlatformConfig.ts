import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DefinePlatformConfig } from '../types/platform';

const PLATFORM_CONFIG_FILES = [
  'slingshot.platform.ts',
  'slingshot.platform.js',
  'slingshot.platform.mts',
  'slingshot.platform.mjs',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function findConfigFile(startDir: string): string | null {
  let dir = startDir;
  const root = dirname(dir) === dir ? dir : '/';

  for (;;) {
    for (const filename of PLATFORM_CONFIG_FILES) {
      const candidate = join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return null;
}

/**
 * Load and return the platform config by searching the filesystem for a
 * `slingshot.platform.{ts,js,mts,mjs}` file.
 *
 * Search strategy:
 * 1. If the `SLINGSHOT_PLATFORM` environment variable is set, it is used as the
 *    absolute path to the config file.
 * 2. Otherwise, traverses upward from `startDir` (default: `process.cwd()`)
 *    until a config file is found or the filesystem root is reached.
 *
 * TypeScript config files (`.ts`, `.mts`) require the Bun runtime — an error
 * is thrown when loading them under Node.js.
 *
 * @param startDir - Directory to start searching from. Default: `process.cwd()`.
 * @returns The validated `DefinePlatformConfig` and the resolved file path.
 *
 * @throws {Error} If no config file is found, the file does not exist, a `.ts`
 *   config is loaded under Node.js, or the default export is not a valid config.
 *
 * @example
 * ```ts
 * import { loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
 *
 * const { config, configPath } = await loadPlatformConfig();
 * console.log(`Loaded platform config from ${configPath}`);
 * ```
 */
export async function loadPlatformConfig(startDir?: string): Promise<{
  config: DefinePlatformConfig;
  configPath: string;
}> {
  const searchDir = startDir ?? process.cwd();
  const envPath = process.env.SLINGSHOT_PLATFORM;
  const configPath = envPath ?? findConfigFile(searchDir);

  if (!configPath) {
    throw new Error(
      '[slingshot-infra] Could not find slingshot.platform.ts. ' +
        'Create one with `slingshot platform init` or set SLINGSHOT_PLATFORM env var.',
    );
  }

  if (!existsSync(configPath)) {
    throw new Error(`[slingshot-infra] Platform config not found at: ${configPath}`);
  }

  if (configPath.endsWith('.ts') && typeof globalThis.Bun === 'undefined') {
    throw new Error(
      `[slingshot-infra] Cannot import ${configPath} — TypeScript config files require Bun runtime. ` +
        'Run the CLI with `bunx slingshot` or use a .js config file.',
    );
  }

  const imported: unknown = await import(configPath);
  const config = isRecord(imported) && 'default' in imported ? imported.default : undefined;

  if (!isRecord(config)) {
    throw new Error(
      `[slingshot-infra] ${configPath} must export a default value from definePlatform().`,
    );
  }

  return { config: config as unknown as DefinePlatformConfig, configPath };
}
