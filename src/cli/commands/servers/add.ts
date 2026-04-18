import { spawnSync } from 'node:child_process';
import { Args, Command, Flags } from '@oclif/core';
import { createRegistryFromConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import { resolvePlatformConfig } from '../../utils/resolvePlatformConfig';

export default class ServersAdd extends Command {
  static override description = 'Register a server host for a stack/stage in the registry';

  static override examples = [
    'slingshot servers add shared-1 --host 54.123.45.67 --stack main --stage prod',
  ];

  static override args = {
    name: Args.string({ description: 'Server name (e.g. shared-1)', required: true }),
  };

  static override flags = {
    host: Flags.string({ description: 'Server IP address or hostname', required: true }),
    stack: Flags.string({ description: 'Stack name', required: true }),
    stage: Flags.string({ description: 'Stage name', required: true }),
    platform: Flags.string({ description: 'Target platform (for multi-platform configs)' }),
  };

  async run() {
    const { args, flags } = await this.parse(ServersAdd);
    const { config: rawConfig } = await loadPlatformConfig();
    const config = resolvePlatformConfig(rawConfig, flags.platform);
    const { stack: stackName, stage: stageName } = flags;

    // Validate SSH reachability before writing to registry
    this.log(`Validating SSH access to ${flags.host}...`);
    const ssh = spawnSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', flags.host, 'echo ok'],
      { encoding: 'utf-8' },
    );
    if (ssh.status !== 0) {
      this.error(
        `Cannot reach ${flags.host} via SSH. ` +
          'Ensure the host is reachable and your SSH key is authorized.',
      );
    }

    const registry = createRegistryFromConfig(config.registry);
    const lock = await registry.lock(120000);
    try {
      const doc = await registry.read();
      if (!doc) this.error('Registry not initialized. Run: slingshot registry init');

      if (!Object.hasOwn(doc.stacks, stackName)) {
        this.error(`Stack "${stackName}" not found. Run: slingshot stacks list`);
      }

      // Write host to the stack stage outputs
      if (!Object.hasOwn(doc.stacks[stackName].stages, stageName)) {
        doc.stacks[stackName].stages[stageName] = {
          status: 'active',
          outputs: {},
          updatedAt: new Date().toISOString(),
        };
      }

      doc.stacks[stackName].stages[stageName].outputs.host = flags.host;
      doc.stacks[stackName].stages[stageName].outputs.serverName = args.name;
      doc.stacks[stackName].stages[stageName].updatedAt = new Date().toISOString();

      await registry.write(doc, lock.etag);
    } finally {
      await lock.release();
    }

    this.log(`\u2713 Server "${args.name}" registered`);
    this.log(`  Stack: ${stackName}  Stage: ${stageName}  Host: ${flags.host}`);
  }
}
