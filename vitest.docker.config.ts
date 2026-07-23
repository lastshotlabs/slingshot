import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const rootDir = process.cwd();

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@auth\/(.*)$/,
        replacement: `${resolve(rootDir, 'packages/slingshot-auth/src')}/$1`,
      },
      {
        find: /^@config\/(.*)$/,
        replacement: `${resolve(rootDir, 'src/config')}/$1`,
      },
      {
        find: /^@framework\/(.*)$/,
        replacement: `${resolve(rootDir, 'src/framework')}/$1`,
      },
      {
        find: /^@lib\/(.*)$/,
        replacement: `${resolve(rootDir, 'src/lib')}/$1`,
      },
      {
        find: /^@workers\/(.*)$/,
        replacement: `${resolve(rootDir, 'src/workers')}/$1`,
      },
      {
        find: /^@queues\/(.*)$/,
        replacement: `${resolve(rootDir, 'src/queues')}/$1`,
      },
      {
        find: /^@scripts\/(.*)$/,
        replacement: `${resolve(rootDir, 'src/scripts')}/$1`,
      },
      {
        find: /^@lastshotlabs\/slingshot-orchestration-engine\/provider$/,
        replacement: resolve(
          rootDir,
          'packages/slingshot-orchestration-engine/src/provider/index.ts',
        ),
      },
      {
        find: /^@lastshotlabs\/slingshot-orchestration-engine\/errors$/,
        replacement: resolve(rootDir, 'packages/slingshot-orchestration-engine/src/errors.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot$/,
        replacement: resolve(rootDir, 'src/index.ts'),
      },
      {
        find: /^@app$/,
        replacement: resolve(rootDir, 'src/app.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-auth$/,
        replacement: resolve(rootDir, 'packages/slingshot-auth/src/index.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-core$/,
        replacement: resolve(rootDir, 'packages/slingshot-core/src/index.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-entity$/,
        replacement: resolve(rootDir, 'packages/slingshot-entity/src/index.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-orchestration-engine$/,
        replacement: resolve(rootDir, 'packages/slingshot-orchestration-engine/src/index.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-orchestration$/,
        replacement: resolve(rootDir, 'packages/slingshot-orchestration/src/index.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-orchestration-bullmq$/,
        replacement: resolve(rootDir, 'packages/slingshot-orchestration-bullmq/src/index.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-orchestration-temporal$/,
        replacement: resolve(rootDir, 'packages/slingshot-orchestration-temporal/src/index.ts'),
      },
      {
        find: /^@lastshotlabs\/slingshot-organizations$/,
        replacement: resolve(rootDir, 'packages/slingshot-organizations/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/node-docker/**/*.test.ts'],
    // Some checkouts do not contain Node-specific Docker tests. The Bun-backed
    // Docker suite still has meaningful coverage and must not be reported as a
    // failure merely because this optional shard is empty.
    passWithNoTests: true,
    globals: true,
  },
});
