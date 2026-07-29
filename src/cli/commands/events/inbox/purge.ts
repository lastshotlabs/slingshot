import { Command, Flags } from '@oclif/core';
import {
  durationBefore,
  openEventOperations,
  requireExactConfirmation,
} from '../../../lib/events/operations';

export default class EventsInboxPurge extends Command {
  static override description = 'Purge a bounded batch of old transactional inbox receipts.';
  static override flags = {
    config: Flags.string({ char: 'c', description: 'Path to app.config.ts.' }),
    'db-url': Flags.string({ description: 'Override the configured reliability database.' }),
    before: Flags.string({ required: true, description: 'Age threshold such as 24h or 30d.' }),
    limit: Flags.integer({ default: 1000, min: 1, max: 10000 }),
    confirm: Flags.string({ description: 'Exact configured app name required for mutation.' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EventsInboxPurge);
    const handle = await openEventOperations({ config: flags.config, dbUrl: flags['db-url'] });
    try {
      requireExactConfirmation(handle.appName, flags.confirm);
      const count = await handle.operations.purgeInbox(durationBefore(flags.before), flags.limit);
      this.log(`Purged ${count} inbox receipt(s).`);
    } finally {
      await handle.close();
    }
  }
}
