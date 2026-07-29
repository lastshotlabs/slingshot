import { Command, Flags } from '@oclif/core';
import { openEventOperations } from '../../../lib/events/operations';

export default class EventsOutboxStatus extends Command {
  static override description =
    'Show transactional outbox counts, pending age, and expired leases.';
  static override flags = {
    config: Flags.string({ char: 'c', description: 'Path to app.config.ts.' }),
    'db-url': Flags.string({ description: 'Override the configured reliability database.' }),
    json: Flags.boolean({ description: 'Print machine-readable JSON.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EventsOutboxStatus);
    const handle = await openEventOperations({ config: flags.config, dbUrl: flags['db-url'] });
    try {
      const status = await handle.operations.status(new Date().toISOString());
      if (flags.json) {
        this.log(JSON.stringify({ store: handle.store, ...status }, null, 2));
        return;
      }
      this.log(`Store: ${handle.store}`);
      for (const [name, count] of Object.entries(status.counts)) this.log(`${name}: ${count}`);
      this.log(`oldest pending: ${status.oldestPendingAt ?? '(none)'}`);
      this.log(`expired leases: ${status.expiredLeases}`);
    } finally {
      await handle.close();
    }
  }
}
