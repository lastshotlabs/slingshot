import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Vitest config for the runtime-node package.
 *
 * The adapter targets Node.js and uses Node-native HTTP, WebSocket, argon2,
 * and better-sqlite3 behavior. Run its entire suite in a real Node process so
 * upgrades and native integrations are tested in the supported runtime.
 */
export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
});
