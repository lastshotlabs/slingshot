import { existsSync } from 'fs';
import { resolve } from 'path';
import { Command, Flags } from '@oclif/core';
import { createTemporalOrchestrationWorkerFromManifest } from '@lib/createTemporalOrchestrationWorkerFromManifest';

export default class OrchestrationWorker extends Command {
  static override description =
    'Start a Temporal-backed Slingshot orchestration worker from a manifest file.';

  static override examples = [
    '<%= config.bin %> orchestration worker --manifest ./app.manifest.json',
    '<%= config.bin %> orchestration worker --manifest ./app.manifest.json --build-id prod-2026-04-20',
    '<%= config.bin %> orchestration worker --manifest ./app.manifest.json --dry-run',
  ];

  static override flags = {
    manifest: Flags.string({
      char: 'm',
      description: 'Path to the app manifest JSON file',
      default: './app.manifest.json',
    }),
    handlers: Flags.string({
      description: 'Optional handlers file override',
    }),
    'build-id': Flags.string({
      description: 'Override the Temporal worker buildId from manifest config',
    }),
    'dry-run': Flags.boolean({
      description: 'Validate the Temporal worker bootstrap without connecting to Temporal',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(OrchestrationWorker);
    const manifestPath = resolve(flags.manifest);
    if (!existsSync(manifestPath)) {
      this.error(`No manifest found at '${flags.manifest}'.`);
    }

    const plan = await createTemporalOrchestrationWorkerFromManifest(manifestPath, {
      ...(flags.handlers ? { handlersPath: resolve(flags.handlers) } : {}),
      ...(flags['build-id'] ? { buildId: flags['build-id'] } : {}),
      dryRun: flags['dry-run'],
    });

    if (flags['dry-run']) {
      this.log(`[slingshot] Temporal worker dry run complete.`);
      this.log(`[slingshot] definitions: ${plan.definitionsModulePath}`);
      this.log(`[slingshot] workflow queue: ${plan.workflowTaskQueue}`);
      this.log(`[slingshot] activity queues: ${plan.activityTaskQueues.join(', ')}`);
      this.log(`[slingshot] buildId: ${plan.buildId}`);
      return;
    }

    this.log(`[slingshot] Starting Temporal orchestration worker.`);
    this.log(`[slingshot] workflow queue: ${plan.workflowTaskQueue}`);
    this.log(`[slingshot] activity queues: ${plan.activityTaskQueues.join(', ')}`);
    this.log(`[slingshot] buildId: ${plan.buildId}`);
    if (!plan.worker) {
      this.error('Temporal worker plan did not include a worker instance.');
    }
    await plan.worker.run();
  }
}
