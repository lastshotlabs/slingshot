import { Command, Flags } from '@oclif/core';
import type { OutboxStatus } from '@lastshotlabs/slingshot-events';
import { openEventOperations } from '../../../lib/events/operations';

export default class EventsOutboxList extends Command {
  static override description = 'List a bounded set of transactional outbox rows.';
  static override flags = {
    config: Flags.string({ char: 'c', description: 'Path to app.config.ts.' }),
    'db-url': Flags.string({ description: 'Override the configured reliability database.' }),
    status: Flags.string({
      required: true,
      options: ['pending', 'leased', 'dead', 'delivered'],
      description: 'Lifecycle status to list.',
    }),
    limit: Flags.integer({ default: 100, min: 1, max: 1000 }),
    json: Flags.boolean({ description: 'Print machine-readable JSON.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EventsOutboxList);
    const handle = await openEventOperations({ config: flags.config, dbUrl: flags['db-url'] });
    try {
      const rows = await handle.operations.list(flags.status as OutboxStatus, flags.limit);
      if (flags.json) {
        this.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        this.log('No matching outbox rows.');
        return;
      }
      for (const row of rows) {
        this.log(
          `${row.eventId}  ${row.eventKey}  ${row.status}  attempts=${row.attempts}  created=${row.createdAt}`,
        );
      }
    } finally {
      await handle.close();
    }
  }
}
