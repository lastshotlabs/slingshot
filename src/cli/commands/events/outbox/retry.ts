import { Args, Command, Flags } from '@oclif/core';
import { openEventOperations, requireExactConfirmation } from '../../../lib/events/operations';

export default class EventsOutboxRetry extends Command {
  static override description = 'Make dead outbox work retryable and write a replay audit record.';
  static override args = {
    'event-id': Args.string({ description: 'Stable event ID to retry.', required: false }),
  };
  static override flags = {
    config: Flags.string({ char: 'c', description: 'Path to app.config.ts.' }),
    'db-url': Flags.string({ description: 'Override the configured reliability database.' }),
    'all-dead': Flags.boolean({ description: 'Retry a bounded batch of all dead rows.' }),
    limit: Flags.integer({ default: 100, min: 1, max: 1000 }),
    confirm: Flags.string({ description: 'Exact configured app name required for mutation.' }),
    reason: Flags.string({ default: 'operator retry', description: 'Replay audit reason.' }),
    actor: Flags.string({ default: 'slingshot-cli', description: 'Replay audit actor.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EventsOutboxRetry);
    if (Boolean(args['event-id']) === Boolean(flags['all-dead'])) {
      this.error('Provide exactly one event-id or --all-dead.');
    }
    const handle = await openEventOperations({ config: flags.config, dbUrl: flags['db-url'] });
    try {
      requireExactConfirmation(handle.appName, flags.confirm);
      const now = new Date().toISOString();
      if (args['event-id']) {
        const retried = await handle.operations.retryEvent({
          eventId: args['event-id'],
          now,
          actor: flags.actor,
          reason: flags.reason,
        });
        this.log(retried ? `Retry scheduled for ${args['event-id']}.` : 'No dead row matched.');
        return;
      }
      const count = await handle.operations.retryAllDead({
        now,
        actor: flags.actor,
        reason: flags.reason,
        limit: flags.limit,
      });
      this.log(`Retry scheduled for ${count} dead row(s).`);
    } finally {
      await handle.close();
    }
  }
}
