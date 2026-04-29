/**
 * P-TEMPORAL-2: verify the workflow module emitted by
 * `generateTemporalWorkflowModule()` bundles successfully through
 * `bundleWorkflowCode()` from `@temporalio/worker`.
 *
 * The generator previously had no test coverage that actually loaded the
 * emitted file through Temporal's worker bundler, so a refactor that broke
 * the bridge module's import shape would only surface at deploy time. This
 * integration test runs the bundler against a fixture-backed module so the
 * compile path is exercised on every CI run that has Temporal SDK native
 * dependencies available.
 *
 * Gated on `TEMPORAL_TEST_ENV=1` because `bundleWorkflowCode` pulls in the
 * Temporal worker bridge which carries native dependencies that are heavy
 * for unit-test CI.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { AnyResolvedWorkflow } from '@lastshotlabs/slingshot-orchestration';
import type { OrchestrationProviderRegistry } from '@lastshotlabs/slingshot-orchestration/provider';
import {
  generateTemporalWorkflowModule,
  resolvePackageWorkflowsPath,
} from '../../src/workflowModuleGenerator';

const REAL_TEMPORAL_ENABLED = process.env['TEMPORAL_TEST_ENV'] === '1';
const itReal = REAL_TEMPORAL_ENABLED ? test : test.skip;

const taskManifest = {
  name: 'bundle-task',
  retry: { maxAttempts: 1, backoff: 'fixed', delayMs: 0, maxDelayMs: 0 },
  timeout: 1000,
  queue: undefined,
  concurrency: undefined,
};

function createRegistry(): OrchestrationProviderRegistry {
  return {
    listTaskManifests: () => [taskManifest],
    getWorkflowManifest: () => ({
      tasks: { 'bundle-task': taskManifest },
      hooks: { onStart: false, onComplete: false, onFail: false },
    }),
  } as unknown as OrchestrationProviderRegistry;
}

describe('temporal workflow module bundles compile (P-TEMPORAL-2)', () => {
  itReal(
    'bundleWorkflowCode loads the generated bridge module without errors',
    async () => {
      const { bundleWorkflowCode } = await import('@temporalio/worker');
      const tempDir = await mkdtemp(join(tmpdir(), 'slingshot-temporal-bundle-'));
      try {
        const definitionsModulePath = join(tempDir, 'definitions.ts');
        await writeFile(
          definitionsModulePath,
          `export const workflows = { 'bundle-flow': { input: { parse: (v) => v } } };\n`,
          'utf8',
        );

        const modulePath = await generateTemporalWorkflowModule({
          generatedWorkflowsDir: join(tempDir, 'generated'),
          definitionsModulePath,
          packageWorkflowsPath: resolvePackageWorkflowsPath(),
          workflows: [{ _tag: 'ResolvedWorkflow', name: 'bundle-flow' } as AnyResolvedWorkflow],
          registry: createRegistry(),
        });

        // bundleWorkflowCode walks the import graph from the workflows module
        // and produces a string of bundled code. A successful return value
        // means the generated module compiled and every import resolved.
        const result = await bundleWorkflowCode({ workflowsPath: modulePath });
        expect(typeof result.code).toBe('string');
        expect(result.code.length).toBeGreaterThan(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
