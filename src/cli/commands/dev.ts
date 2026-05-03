import { Command, Flags } from '@oclif/core';
import { spawn } from 'bun';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * `slingshot dev` — boot the server and restart on source-file changes.
 *
 * Spawns a Bun subprocess running the framework's dev-runner under `bun --watch`.
 * Bun watches every file the runner transitively imports, including the user's
 * `app.config.ts` and everything it pulls in. On change, Bun restarts the
 * subprocess for a clean in-process state every time.
 *
 * Forwards SIGINT and SIGTERM so Ctrl-C exits cleanly without orphaning the
 * subprocess. The exit code of the subprocess becomes the exit code of `dev`.
 */
export default class Dev extends Command {
  static override description =
    'Start a Slingshot server in watch mode. Restarts when source files change.';

  static override examples = [
    '<%= config.bin %> dev',
    '<%= config.bin %> dev --config ./app.config.ts',
  ];

  static override flags = {
    config: Flags.string({
      char: 'c',
      description:
        'Path to the app config TS/JS file. Defaults to ./app.config.ts then ./app.config.js.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Dev);
    const cwd = process.cwd();

    // Resolve the dev-runner script relative to this command's location so it
    // works whether the CLI is run from source (src/cli/commands/dev.ts) or
    // from the published dist (dist/cli/commands/dev.js).
    const here = dirname(fileURLToPath(import.meta.url));
    const runner = resolve(here, '..', 'dev-runner');

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (flags.config) {
      env.SLINGSHOT_DEV_CONFIG = resolve(cwd, flags.config);
    }

    const proc = spawn({
      cmd: ['bun', '--watch', runner],
      cwd,
      stdio: ['inherit', 'inherit', 'inherit'],
      env,
    });

    // Forward signals so Ctrl-C exits the parent oclif process and the bun
    // subprocess together — otherwise bun --watch keeps the terminal hostage.
    const forward = (signal: NodeJS.Signals) => {
      proc.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    const exitCode = await proc.exited;
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    process.exit(exitCode ?? 0);
  }
}
