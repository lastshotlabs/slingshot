import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/** Entity definition for named push topics. */
export const PushTopic = defineEntity('PushTopic', {
  namespace: 'push',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ default: '' }),
    name: field.string(),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [index(['tenantId', 'name'], { unique: true })],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['create', 'update', 'delete', 'get', 'list'],
  },
});

/** Generated operations for ensuring and resolving topics by name. */
export const pushTopicOperations = defineOperations(PushTopic, {
  ensureByName: op.upsert({
    match: ['tenantId', 'name'],
    set: ['name'],
    onCreate: {
      id: 'uuid',
      createdAt: 'now',
    },
  }),
  findByName: op.lookup({
    fields: { tenantId: 'param:tenantId', name: 'param:name' },
    returns: 'one',
  }),
});
