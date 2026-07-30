import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

export function collectCommandEntries(directory = 'src/cli/commands'): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(entries, collectCommandEntries(path));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    entries[path.slice('src/'.length, -'.ts'.length).replaceAll('\\', '/')] = path.replaceAll(
      '\\',
      '/',
    );
  }
  return entries;
}

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'cli/dev-runner': 'src/cli/dev-runner.ts',
    ...collectCommandEntries(),
  },
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: false,
  target: 'node20',
  platform: 'node',
  bundle: true,
  outExtension: () => ({ js: '.js' }),
  // Bundle all @lastshotlabs workspace packages inline so the CLI doesn't depend
  // on their dist files at runtime. Workspace dists use "moduleResolution: bundler"
  // which omits .js extensions — Node.js ESM cannot resolve those at runtime.
  noExternal: [/^@lastshotlabs\//],
  external: [
    '@lastshotlabs/slingshot-orchestration-temporal',
    '@oclif/core',
    '@temporalio/activity',
    '@temporalio/client',
    '@temporalio/common',
    '@temporalio/worker',
    '@temporalio/workflow',
    '@swc/core',
    '@swc/wasm',
    '@hono/zod-openapi',
    '@simplewebauthn/server',
    '@aws-sdk/client-s3',
    '@aws-sdk/client-ssm',
    '@aws-sdk/lib-storage',
    '@aws-sdk/s3-request-presigner',
    'arctic',
    'bullmq',
    'hono',
    'hono/cookie',
    'ioredis',
    'jose',
    'mongoose',
    'node:fs',
    'node:path',
    'node:child_process',
    'node:process',
    'node:buffer',
    'otpauth',
    'fs',
    'path',
    'pg',
    'samlify',
    'child_process',
    'bun:sqlite',
    'better-sqlite3',
    'mongodb',
  ],
  banner: {
    // The CLI is Bun-native — `slingshot start` dynamically imports the app's
    // `app.config.ts` (a TypeScript module), which Node cannot load. Use Bun so
    // bare `slingshot ...` invocations (e.g. via package scripts) run correctly.
    js: '#!/usr/bin/env bun',
  },
});
