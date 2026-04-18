import * as readline from 'node:readline';
import { Command, Flags } from '@oclif/core';
import {
  createEc2NginxPreset,
  createEcsPreset,
  createKafkaProvisioner,
  createPostgresProvisioner,
  createPresetRegistry,
  createProvisionerRegistry,
  createRedisProvisioner,
  createRegistryFromConfig,
  loadPlatformConfig,
} from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class PlatformDeploy extends Command {
  static override description = 'Provision shared resources and stack infrastructure';

  static override flags = {
    stage: Flags.string({ description: 'Stage to provision', required: true }),
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
    yes: Flags.boolean({ char: 'y', description: 'Skip confirmation prompt', default: false }),
  };

  async run() {
    const { flags } = await this.parse(PlatformDeploy);
    const { config: rawConfig } = await loadPlatformConfig();

    const config = resolvePlatformConfig(rawConfig, flags.platform);
    const stageName = flags.stage;

    if (!Object.hasOwn(config.stages, stageName)) {
      this.error(
        `Stage "${stageName}" not found. Available: ${Object.keys(config.stages).join(', ')}`,
      );
    }

    if (!flags.yes) {
      const confirmed = await this.confirm(
        `Provision platform resources for stage "${stageName}"? (y/N) `,
      );
      if (!confirmed) {
        this.log('Platform deploy cancelled.');
        return;
      }
    }

    const registry = createRegistryFromConfig(config.registry);
    const registryDoc = await registry.read();
    if (!registryDoc) this.error('Registry not initialized. Run: slingshot registry init');

    const provisioners = createProvisionerRegistry([
      createPostgresProvisioner(),
      createRedisProvisioner(),
      createKafkaProvisioner(),
    ]);

    if (config.resources) {
      for (const [name, rc] of Object.entries(config.resources)) {
        this.log(`Provisioning ${name} (${rc.type})...`);
        const result = await provisioners.get(rc.type).provision({
          resourceName: name,
          config: rc,
          stageName,
          region: config.region,
          platform: config.org,
        });
        registryDoc.resources[name].stages[stageName] = {
          status: result.status,
          outputs: result.connectionEnv,
          provisionedAt: new Date().toISOString(),
        };
        this.log(`  \u2713 ${name}: ${result.status}`);
      }
    }

    if (config.stacks) {
      const presets = createPresetRegistry([createEcsPreset(), createEc2NginxPreset()]);

      for (const [name, sc] of Object.entries(config.stacks)) {
        this.log(`Provisioning stack "${name}" (${sc.preset})...`);
        const result = await presets.get(sc.preset).provisionStack({
          platform: config,
          infra: { stacks: [name] },
          stage: config.stages[stageName],
          stageName,
          stack: sc,
          stackName: name,
          registry: registryDoc,
          resolvedEnv: {},
          appRoot: process.cwd(),
          serviceName: 'platform',
          imageTag: '',
          dockerRegistry: '',
        });

        registryDoc.stacks[name].stages[stageName] = {
          status: result.success ? 'active' : 'failed',
          outputs: result.outputs,
          updatedAt: new Date().toISOString(),
        };
        this.log(
          `  ${result.success ? '\u2713' : '\u2717'} ${name}: ${result.success ? 'active' : result.error}`,
        );
      }
    }

    const lock = await registry.lock();
    await registry.write(registryDoc, lock.etag);
    await lock.release();
    this.log('\n\u2713 Platform deploy complete');
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
