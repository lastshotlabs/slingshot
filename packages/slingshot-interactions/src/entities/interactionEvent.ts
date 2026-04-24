import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/** Semantic statuses recorded in the interaction audit trail. */
export type InteractionResponseStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'rateLimited'
  | 'forbidden'
  | 'notFound';

/** Entity definition for persisted interaction-dispatch audit rows. */
export const InteractionEvent = defineEntity('InteractionEvent', {
  namespace: 'interactions',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    messageKind: field.enum(
      ['chat:message', 'community:thread', 'community:reply', 'community:post'] as const,
      { immutable: true },
    ),
    messageId: field.string({ immutable: true }),
    actionId: field.string({ immutable: true }),
    actionIdPrefix: field.string({ immutable: true }),
    handlerKind: field.enum(['webhook', 'route', 'queue', 'none'] as const, {
      immutable: true,
    }),
    responseStatus: field.enum(
      ['ok', 'error', 'timeout', 'rateLimited', 'forbidden', 'notFound'] as const,
      { immutable: true },
    ),
    latencyMs: field.number({ immutable: true }),
    errorDetail: field.string({ optional: true, immutable: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['tenantId', 'userId', 'createdAt'], { direction: 'desc' }),
    index(['messageKind', 'messageId']),
    index(['actionIdPrefix', 'createdAt'], { direction: 'desc' }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['create', 'update', 'delete'],
    dataScope: {
      field: 'userId',
      from: 'ctx:actor.id',
      applyTo: ['get', 'list'],
    },
  },
});

/** Generated query operations for interaction audit reads. */
export const interactionEventOperations = defineOperations(InteractionEvent, {
  listForUser: op.lookup({
    fields: { userId: 'param:userId' },
    returns: 'many',
  }),
  listByPrefixAndUser: op.lookup({
    fields: {
      actionIdPrefix: 'param:actionIdPrefix',
      userId: 'param:userId',
    },
    returns: 'many',
  }),
});
