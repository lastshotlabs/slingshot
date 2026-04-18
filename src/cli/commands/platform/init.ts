import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, Flags } from '@oclif/core';
import { generatePlatformTemplate } from '@lastshotlabs/slingshot-infra';
import { multiSelect, selectOption, textInput } from '../../utils/tui';

const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'sa-east-1',
  'ca-central-1',
];

const PRESET_OPTIONS = ['ecs', 'ec2-nginx'];

const RESOURCE_OPTIONS = ['postgres', 'redis', 'mongo', 'kafka'];

const DEFAULT_STAGE_OPTIONS = ['dev', 'staging', 'prod'];

export default class PlatformInit extends Command {
  static override description = 'Scaffold a slingshot.platform.ts config file';

  static override flags = {
    dir: Flags.string({ description: 'Output directory', default: '.' }),
    org: Flags.string({ description: 'Organization name' }),
    region: Flags.string({ description: 'AWS region', default: 'us-east-1' }),
    preset: Flags.string({ description: 'Default stack preset', default: 'ecs' }),
  };

  async run() {
    const { flags } = await this.parse(PlatformInit);
    const outDir = flags.dir;
    const filePath = join(outDir, 'slingshot.platform.ts');

    if (existsSync(filePath)) {
      this.warn(`${filePath} already exists — skipping. Remove it first to re-scaffold.`);
      return;
    }

    let org: string;
    let region: string;
    let preset: string;
    let resources: string[];
    let stages: string[];

    if (process.stdin.isTTY) {
      // Interactive mode
      org = textInput('Organization name', flags.org ?? 'myorg');

      const regionDefault =
        AWS_REGIONS.indexOf(flags.region) >= 0 ? AWS_REGIONS.indexOf(flags.region) : 0;
      region = selectOption('AWS region:', AWS_REGIONS, regionDefault);

      const presetDefault =
        PRESET_OPTIONS.indexOf(flags.preset) >= 0 ? PRESET_OPTIONS.indexOf(flags.preset) : 0;
      preset = selectOption('Default stack preset:', PRESET_OPTIONS, presetDefault);

      resources = multiSelect('Initial resources (optional):', RESOURCE_OPTIONS);

      stages = multiSelect('Deployment stages:', DEFAULT_STAGE_OPTIONS, ['dev', 'staging', 'prod']);
      if (stages.length === 0) {
        stages = ['dev', 'prod'];
      }
    } else {
      // Non-interactive / CI mode — require --org
      if (!flags.org) {
        this.error(
          'Interactive mode requires a TTY. Pass --org, --region, --preset for non-interactive use.',
        );
      }
      org = flags.org;
      region = flags.region;
      preset = flags.preset;
      resources = [];
      stages = ['dev', 'prod'];
    }

    const template = generatePlatformTemplate({ org, region, preset, resources, stages });

    writeFileSync(filePath, template, 'utf-8');
    this.log(`\u2713 Created ${filePath}`);
    this.log('\nNext steps:');
    this.log(
      '  1. Install infra tooling (dev dependency): bun add -d @lastshotlabs/slingshot-infra',
    );
    this.log('  2. Edit slingshot.platform.ts with your org and region');
    this.log('  3. Run: bunx slingshot registry init');
  }
}
