/**
 * Bootstrap script invoked by `slingshot dev` under `bun --watch`.
 *
 * Loads `app.config.ts`, calls `createServer`, and exits when stopped.
 * Bun's watcher restarts this entire process when any imported file changes,
 * which gives us a clean restart with no in-process state to invalidate.
 *
 * The wrapping `dev` command spawns this script via `Bun.spawn` and forwards
 * signals; this script just needs to boot the server and stay alive until
 * Bun kills it.
 */
import { discoverAppConfig, loadAppConfig } from './commands/start';
import { createServer } from '../server';

const cwd = process.cwd();
const configOverride = process.env.SLINGSHOT_DEV_CONFIG ?? undefined;

const configPath = discoverAppConfig(cwd, configOverride);
if (!configPath) {
  console.error(
    `[slingshot dev] No app.config.ts found in ${cwd}. ` +
      `Create one (or pass --config) to use slingshot dev.`,
  );
  process.exit(1);
}

console.log(`[slingshot dev] Loading config from ${configPath}`);
const config = await loadAppConfig(configPath);

try {
  const server = await createServer(config);
  const port = (server as { port?: number }).port ?? 3000;
  console.log(`[slingshot dev] Server running at http://localhost:${port} — watching for changes`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[slingshot dev] Server failed to start:\n  ${message}`);
  // Exit 1 so bun --watch surfaces the failure clearly; the next save will retry.
  process.exit(1);
}
