// packages/slingshot-chat/src/entities/reminder.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user reminder.
 *
 * Reminders let users schedule a nudge linked to a room (and optionally a
 * message). A multi-instance-safe scheduler claims due reminders atomically
 * and emits `chat:reminder.triggered` on the event bus.
 *
 * @remarks
 * Key operations:
 * - `listPending`: Untriggered reminders for the calling user.
 * - `claimDueReminders`: Internal atomic batch claim (no HTTP route).
 */
export const Reminder = defineEntity('Reminder', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    userId: field.string({ immutable: true }),
    roomId: field.string({ immutable: true }),
    messageId: field.string({ optional: true, immutable: true }),
    note: field.string({ optional: true }),
    triggerAt: field.date(),
    triggered: field.boolean({ default: false }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['userId', 'triggered']), index(['triggerAt', 'triggered'])],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:authUserId' },
    get: {},
    list: {},
    create: {
      event: { key: 'chat:reminder.created', payload: ['id', 'userId', 'roomId', 'triggerAt'] },
    },
    delete: {},
    operations: {
      listPending: { auth: 'userAuth' },
    },
  },
});

/**
 * Custom operations for the Reminder entity.
 *
 * - `listPending`: Untriggered reminders for a user (HTTP).
 * - `claimDueReminders`: Internal atomic batch claim (no HTTP).
 */
export const reminderOperations = defineOperations(Reminder, {
  /** Untriggered reminders for the calling user. */
  listPending: op.lookup({
    fields: { userId: 'param:authUserId', triggered: false },
    returns: 'many',
  }),

  /** Internal: atomic batch claim of due reminders. No HTTP route. */
  claimDueReminders: op.custom({}),
});
