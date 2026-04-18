import { existsSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, Flags } from '@oclif/core';
import { generateInfraTemplate } from '@lastshotlabs/slingshot-infra';

export default class InfraInit extends Command {
  static override description = 'Scaffold a slingshot.infra.ts config file';

  static override flags = {
    dir: Flags.string({ description: 'Output directory', default: '.' }),
    port: Flags.integer({ description: 'App port', default: 3000 }),
  };

  async run() {
    const { flags } = await this.parse(InfraInit);
    const outDir = flags.dir;
    const filePath = join(outDir, 'slingshot.infra.ts');

    if (existsSync(filePath)) {
      this.warn(`${filePath} already exists — skipping. Remove it first to re-scaffold.`);
      return;
    }

    // Try to read stack names from an existing platform config
    let stacks: string[] | undefined;
    const platformPath = join(outDir, 'slingshot.platform.ts');
    if (existsSync(platformPath)) {
      try {
        const content = readFileSync(platformPath, 'utf-8');
        const stackMatches = content.match(/stacks:\s*\{([^}]*)\}/);
        if (stackMatches) {
          const names = [...stackMatches[1].matchAll(/['"]([^'"]+)['"]\s*:/g)].map(m => m[1]);
          if (names.length > 0) {
            stacks = names;
            this.log(`Found stacks in slingshot.platform.ts: ${stacks.join(', ')}`);
          }
        }
      } catch {
        // Ignore read errors — fall back to default stacks
      }
    }

    const template = generateInfraTemplate({
      stacks,
      port: flags.port,
    });

    writeFileSync(filePath, template, 'utf-8');
    this.log(`\u2713 Created ${filePath}`);
    this.log('\nNext steps:');
    this.log('  1. Ensure slingshot.platform.ts exists (run: bunx slingshot platform init)');
    this.log('  2. Edit slingshot.infra.ts — set stacks, size, and resources');
    this.log('  3. Deploy with: bunx slingshot deploy --stage dev');
  }
}
