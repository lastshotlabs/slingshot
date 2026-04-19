import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { POLL_SOURCE_POLICY_KEY } from '../policy';

/**
 * A poll attached to a piece of content. Created alongside the content
 * (the content stores the resulting `pollId` in its sidecar) and
 * referenced by every consumer package via that ID.
 *
 * Polls are content-agnostic: `sourceType` is a free-form string like
 * `'chat:message'` or `'community:thread'` so consumers can query their
 * own polls without this package knowing about their entities.
 */
export const Poll = defineEntity('Poll', {
  namespace: 'polls',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    sourceType: field.string({ immutable: true }),
    sourceId: field.string({ immutable: true }),
    scopeId: field.string({ immutable: true }),
    authorId: field.string({ immutable: true }),
    question: field.string(),
    options: field.json(),
    multiSelect: field.boolean({ default: false }),
    anonymous: field.boolean({ default: false }),
    closed: field.boolean({ default: false }),
    closesAt: field.date({ optional: true }),
    closedBy: field.string({ optional: true }),
    closedAt: field.date({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['sourceType', 'sourceId']),
    index(['scopeId']),
    index(['authorId']),
    index(['closed', 'closesAt']),
  ],
  routes: {
    dataScope: { field: 'authorId', from: 'ctx:authUserId', applyTo: ['create'] },
    defaults: {
      auth: 'userAuth',
      permission: { requires: 'poll:read', policy: { resolver: POLL_SOURCE_POLICY_KEY } },
    },
    get: {},
    list: {},
    create: {
      permission: { requires: 'poll:create', policy: { resolver: POLL_SOURCE_POLICY_KEY } },
      middleware: ['pollCreateGuard', 'pollCreateRateLimit'],
      event: {
        key: 'polls:poll.created',
        payload: ['id', 'sourceType', 'sourceId', 'authorId', 'scopeId'],
      },
    },
    delete: {
      permission: { requires: 'poll:admin', policy: { resolver: POLL_SOURCE_POLICY_KEY } },
      event: {
        key: 'polls:poll.deleted',
        payload: ['id', 'scopeId'],
      },
    },
    operations: {
      listBySource: { method: 'post', path: 'list-by-source' },
      closePoll: {
        // applyTo: [] prevents the pre-handler policy pass — closePoll body
        // is { id } with no sourceType discriminator, so the dispatched
        // resolver cannot determine the source type. Permission (poll:admin)
        // is still enforced via evaluateRouteAuth.
        permission: {
          requires: 'poll:admin',
          policy: { resolver: POLL_SOURCE_POLICY_KEY, applyTo: [] },
        },
        event: {
          key: 'polls:poll.closed',
          payload: ['id', 'sourceType', 'sourceId', 'scopeId', 'closedBy'],
        },
      },
      // `results` is mounted manually in the plugin — cross-entity access
      // (poll + votes) cannot go through a single entity's op.custom factory.
    },
    clientSafeEvents: ['polls:poll.created', 'polls:poll.closed', 'polls:poll.deleted'],
    permissions: {
      resourceType: 'poll',
      actions: ['read', 'vote', 'create', 'admin'],
    },
  },
});
