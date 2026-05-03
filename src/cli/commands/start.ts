import { Command, Flags } from '@oclif/core';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { CreateServerConfig } from '../../server';
import { createServer } from '../../server';

const CONFIG_CANDIDATES = ['app.config.ts', 'app.config.js'] as const;

export async function loadAppConfig(configPath: string): Promise<CreateServerConfig> {
  let mod: { default?: unknown };
  try {
    mod = (await import(configPath)) as { default?: unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[slingshot] Failed to load '${configPath}':\n  ${message}\n` +
        `Check the file for syntax errors and missing imports.`,
      { cause: err },
    );
  }
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(
      `[slingshot] '${configPath}' must export a default value from defineApp(...). ` +
        `Example: export default defineApp({ ... });`,
    );
  }
  return mod.default as CreateServerConfig;
}

export function discoverAppConfig(cwd: string, override?: string): string | null {
  if (override) {
    const p = resolve(cwd, override);
    if (!existsSync(p)) {
      throw new Error(`[slingshot] config file '${override}' not found`);
    }
    return p;
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const p = resolve(cwd, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

export default class Start extends Command {
  static override description =
    'Start a Slingshot server. Reads app.config.ts and boots from its default export.';

  static override examples = [
    '<%= config.bin %> start',
    '<%= config.bin %> start --config ./app.config.ts',
    '<%= config.bin %> start --dry-run',
  ];

  static override flags = {
    config: Flags.string({
      char: 'c',
      description:
        'Path to the app config TS/JS file. Defaults to ./app.config.ts then ./app.config.js.',
    }),
    'dry-run': Flags.boolean({
      description: 'Validate the config without starting the server',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Start);
    const dryRun = flags['dry-run'];
    const cwd = process.cwd();

    const configPath = discoverAppConfig(cwd, flags.config);
    if (!configPath) {
      this.error(
        `No config found. Looked for ${CONFIG_CANDIDATES.join(', ')} in ${cwd}. ` +
          `Create app.config.ts (with \`export default defineApp({ ... })\`) or use --config to specify a path.`,
      );
    }

    const config = await loadAppConfig(configPath);
    if (dryRun) {
      this.log(`[slingshot] Dry run — config loaded from '${configPath}'`);
      return;
    }
    let server;
    try {
      server = await createServer(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[slingshot] Server failed to start (config: ${configPath}):\n  ${message}`, {
        cause: err,
      });
    }
    this.log(
      `[slingshot] Server running at http://localhost:${(server as { port?: number }).port ?? 3000}`,
    );
  }
}
