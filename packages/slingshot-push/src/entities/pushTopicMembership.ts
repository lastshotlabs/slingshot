import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/** Entity definition linking subscriptions to topics. */
export const PushTopicMembership = defineEntity('PushTopicMembership', {
  namespace: 'push',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    topicId: field.string(),
    subscriptionId: field.string(),
    userId: field.string(),
    tenantId: field.string({ default: '' }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['topicId', 'subscriptionId'], { unique: true }),
    index(['subscriptionId']),
    index(['userId', 'tenantId']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    disable: ['create', 'update', 'delete', 'get', 'list'],
  },
});

/** Generated operations for topic membership fan-out and cleanup. */
export const pushTopicMembershipOperations = defineOperations(PushTopicMembership, {
  ensureMembership: op.upsert({
    match: ['topicId', 'subscriptionId'],
    set: ['userId', 'tenantId'],
    onCreate: {
      id: 'uuid',
      createdAt: 'now',
    },
  }),
  listByTopic: op.lookup({
    fields: { topicId: 'param:topicId' },
    returns: 'many',
  }),
  listBySubscription: op.lookup({
    fields: { subscriptionId: 'param:subscriptionId' },
    returns: 'many',
  }),
  removeByTopicAndSub: op.batch({
    filter: { topicId: 'param:topicId', subscriptionId: 'param:subscriptionId' },
    action: 'delete',
    returns: 'count',
  }),
  removeBySubscription: op.batch({
    filter: { subscriptionId: 'param:subscriptionId' },
    action: 'delete',
    returns: 'count',
  }),
});
