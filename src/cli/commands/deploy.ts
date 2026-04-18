import * as readline from 'node:readline';
import { Command, Flags } from '@oclif/core';
import {
  createEc2NginxPreset,
  createEcsPreset,
  createPresetRegistry,
  createRegistryFromConfig,
  formatDeployPlan,
  loadInfraConfig,
  loadPlatformConfig,
  runDeployPipeline,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../utils/resolvePlatformConfig';

export default class Deploy extends Command {
  static override description = 'Build and deploy app services to a stage';

  static override flags = {
    stage: Flags.string({ description: 'Stage to deploy to', required: true }),
    'dry-run': Flags.boolean({
      description: 'Preview generated files without deploying',
      default: false,
    }),
    plan: Flags.boolean({
      description: 'Show a structured diff of what would change without deploying',
      default: false,
    }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run() {
    const { flags } = await this.parse(Deploy);
    const { config: platform } = await loadPlatformConfig();
    const { config: infra, configPath } = await loadInfraConfig();
    const appRoot = configPath.replace(/\/slingshot\.infra\.\w+$/, '');

    const resolvedPlatform = resolvePlatformConfig(platform, infra.platform);
    const registry = createRegistryFromConfig(resolvedPlatform.registry);
    const presets = createPresetRegistry([createEcsPreset(), createEc2NginxPreset()]);

    if (flags.plan) {
      this.log(`Computing deploy plan for ${flags.stage}...`);

      const result = await runDeployPipeline({
        platform,
        infra,
        stageName: flags.stage,
        registry,
        presetRegistry: presets,
        appRoot,
        plan: true,
      });

      if (result.plan) {
        this.log('');
        this.log(formatDeployPlan(result.plan));
      }
      return;
    }

    this.log(`Deploying to ${flags.stage}${flags['dry-run'] ? ' (dry run)' : ''}...`);

    if (!flags['dry-run']) {
      // Compute plan for confirmation
      const planResult = await runDeployPipeline({
        platform,
        infra,
        stageName: flags.stage,
        registry,
        presetRegistry: presets,
        appRoot,
        plan: true,
      });

      if (planResult.plan) {
        this.log('');
        this.log(formatDeployPlan(planResult.plan));
      }

      if (!flags.yes) {
        const confirmed = await this.confirm('\nProceed with deploy? (y/N) ');
        if (!confirmed) {
          this.log('Deploy cancelled.');
          return;
        }
      }
    }

    const result = await runDeployPipeline({
      platform,
      infra,
      stageName: flags.stage,
      registry,
      presetRegistry: presets,
      appRoot,
      dryRun: flags['dry-run'],
    });

    this.log('');
    for (const svc of result.services) {
      const icon = svc.result.success ? '\u2713' : '\u2717';
      this.log(
        `  ${icon} ${svc.name} -> ${svc.stack}: ${svc.result.success ? 'deployed' : svc.result.error}`,
      );
      if (svc.result.serviceUrl) this.log(`    ${svc.result.serviceUrl}`);
    }
  }

  private confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(message, answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }
}
