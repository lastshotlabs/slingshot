import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { AnyResolvedWorkflow } from '@lastshotlabs/slingshot-orchestration';
import type { OrchestrationProviderRegistry } from '@lastshotlabs/slingshot-orchestration/provider';
import {
  generateDirectoryDefinitionsModule,
  generateTemporalWorkflowModule,
  resolvePackageWorkflowsPath,
} from '../src/workflowModuleGenerator';

const taskManifest = {
  name: 'send-email',
  retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 100, maxDelayMs: 1000 },
  timeout: 5000,
  queue: 'mail',
  concurrency: 4,
};

function createRegistry(): OrchestrationProviderRegistry {
  return {
    listTaskManifests: () => [taskManifest],
    getWorkflowManifest: () => ({
      tasks: { 'send-email': taskManifest },
      hooks: { onStart: true, onComplete: false, onFail: true },
    }),
  } as unknown as OrchestrationProviderRegistry;
}

describe('Temporal workflow module generator', () => {
  test('writes a workflow bridge module with manifests and relative imports', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'slingshot-temporal-generator-'));

    try {
      const definitionsModulePath = join(tempDir, 'definitions.ts');
      const packageWorkflowsPath = join(tempDir, 'package-workflows.ts');
      await writeFile(definitionsModulePath, 'export const workflows = {};\n', 'utf8');
      await writeFile(packageWorkflowsPath, 'export const slingshotWorkflowImpl = null;\n', 'utf8');

      const modulePath = await generateTemporalWorkflowModule({
        generatedWorkflowsDir: join(tempDir, 'generated'),
        definitionsModulePath,
        packageWorkflowsPath,
        workflows: [{ _tag: 'ResolvedWorkflow', name: 'welcome-flow' } as AnyResolvedWorkflow],
        registry: createRegistry(),
      });

      const source = await readFile(modulePath, 'utf8');
      expect(source).toContain('from "../package-workflows.ts"');
      expect(source).toContain('import * as definitions from "../definitions.ts"');
      expect(source).toContain('"send-email": {');
      expect(source).toContain('"welcome-flow": {');
      expect(source).toContain('hooks: {');
      expect(source).toContain('export async function slingshotWorkflow(args)');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('writes a sorted definitions barrel and resolves the bundled workflow module', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'slingshot-temporal-definitions-'));

    try {
      const alpha = join(tempDir, 'alpha.ts');
      const zeta = join(tempDir, 'zeta.ts');
      await writeFile(alpha, 'export const alpha = true;\n', 'utf8');
      await writeFile(zeta, 'export const zeta = true;\n', 'utf8');

      const modulePath = await generateDirectoryDefinitionsModule({
        outDir: join(tempDir, 'generated'),
        files: [zeta, alpha],
      });
      const source = await readFile(modulePath, 'utf8');

      expect(source.indexOf('../alpha.ts')).toBeLessThan(source.indexOf('../zeta.ts'));
      expect(resolvePackageWorkflowsPath()).toEndWith('/src/workflows.ts');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
