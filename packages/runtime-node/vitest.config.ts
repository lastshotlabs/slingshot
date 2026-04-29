import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the runtime-node package.
 *
 * Why a separate runner from `bun test`:
 * The SQLite test suite under `tests/node-runtime/nodeRuntime.test.ts`
 * exercises the better-sqlite3 native addon, which is not supported under
 * Bun (https://github.com/oven-sh/bun/issues/4290). Those tests must run in
 * a real Node.js process — vitest provides that here.
 *
 * The `test` script runs `bun test` first (covering everything that works
 * under Bun) and then this vitest pass to fill the SQLite gap.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/node-runtime/nodeRuntime.test.ts', 'tests/node-runtime/node-sqlite-edge.test.ts'],
    globals: true,
  },
});
