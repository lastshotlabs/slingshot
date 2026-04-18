import { createServerFromManifest } from '@lib/createServerFromManifest';
import { Command, Flags } from '@oclif/core';
import { existsSync } from 'fs';
import { resolve } from 'path';

export default class Start extends Command {
  static override description =
    'Start a Slingshot server from a manifest file. ' +
    'Reads app.manifest.json and slingshot.handlers.ts by convention.';

  static override examples = [
    '<%= config.bin %> start',
    '<%= config.bin %> start --manifest ./config/app.manifest.json',
    '<%= config.bin %> start --manifest ./app.manifest.json --handlers ./src/handlers.ts',
    '<%= config.bin %> start --dry-run',
  ];

  static override flags = {
    manifest: Flags.string({
      char: 'm',
      description: 'Path to the app manifest JSON file',
      default: './app.manifest.json',
    }),
    handlers: Flags.string({
      description: 'Path to the handlers file',
      default: './slingshot.handlers.ts',
    }),
    'dry-run': Flags.boolean({
      description: 'Validate and convert the manifest without starting the server',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Start);

    const manifestPath = resolve(flags.manifest);
    const dryRun = flags['dry-run'];

    if (!existsSync(manifestPath)) {
      this.error(
        `No manifest found at '${flags.manifest}'. ` +
          `Create one or use --manifest to specify a path.`,
      );
    }

    // The --handlers flag overrides the manifest's handlers field.
    // Only pass it when the user explicitly set it (not the default).
    const handlersOverride =
      flags.handlers !== './slingshot.handlers.ts' ? resolve(flags.handlers) : undefined;

    const server = await createServerFromManifest(manifestPath, undefined, {
      dryRun,
      ...(handlersOverride !== undefined ? { handlersPath: handlersOverride } : {}),
    });

    if (!dryRun) {
      this.log(
        `[slingshot] Server running at http://localhost:${(server as { port?: number }).port ?? 3000}`,
      );
    } else {
      this.log(`[slingshot] Dry run complete — manifest is valid.`);
    }
  }
}
