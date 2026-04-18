import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { POLL_VOTE_POLICY_KEY } from '../policy';

/**
 * A single vote cast against a poll. One row per user per selected
 * option — multi-select polls allow multiple rows for the same
 * `(pollId, userId)` pair with different `optionIndex` values.
 */
export const PollVote = defineEntity('PollVote', {
  namespace: 'polls',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    pollId: field.string({ immutable: true }),
    userId: field.string({ immutable: true }),
    optionIndex: field.integer(),
    sourceType: field.string({ immutable: true }),
    sourceId: field.string({ immutable: true }),
    scopeId: field.string({ immutable: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['pollId', 'userId', 'optionIndex'], { unique: true }),
    index(['pollId', 'optionIndex']),
    index(['sourceType', 'sourceId']),
  ],
  routes: {
    dataScope: [
      { field: 'userId', from: 'ctx:authUserId', applyTo: ['create', 'delete'] },
      { field: 'sourceType', from: 'ctx:__voteSourceType', applyTo: ['create'] },
      { field: 'sourceId', from: 'ctx:__voteSourceId', applyTo: ['create'] },
      { field: 'scopeId', from: 'ctx:__voteScopeId', applyTo: ['create'] },
    ],
    defaults: {
      auth: 'userAuth',
      permission: { requires: 'poll:read', policy: { resolver: POLL_VOTE_POLICY_KEY } },
    },
    get: {},
    list: {},
    create: {
      // applyTo: [] prevents the pre-handler policy pass — the client body
      // has { pollId, optionIndex } with no sourceType. The pollVoteGuard
      // fetches the poll and injects sourceType via context variables.
      permission: {
        requires: 'poll:vote',
        policy: { resolver: POLL_VOTE_POLICY_KEY, applyTo: [] },
      },
      event: {
        key: 'polls:poll.voted',
        payload: ['pollId', 'optionIndex', 'userId', 'sourceType', 'sourceId', 'scopeId'],
      },
      middleware: ['pollVoteGuard', 'pollVoteRateLimit'],
    },
    delete: {
      permission: { requires: 'poll:vote', policy: { resolver: POLL_VOTE_POLICY_KEY } },
      event: {
        key: 'polls:poll.vote_retracted',
        payload: ['pollId', 'optionIndex', 'userId', 'sourceType', 'sourceId', 'scopeId'],
      },
    },
    operations: {
      // Named ops receive { pollId } — no sourceType discriminator for the
      // dispatch-based policy resolver. Skip the pre-handler policy pass;
      // permission checks (poll:read) still enforce access.
      listByPoll: {
        permission: {
          requires: 'poll:read',
          policy: { resolver: POLL_VOTE_POLICY_KEY, applyTo: [] },
        },
      },
      myVotes: {
        permission: {
          requires: 'poll:read',
          policy: { resolver: POLL_VOTE_POLICY_KEY, applyTo: [] },
        },
      },
      countByOption: {
        permission: {
          requires: 'poll:read',
          policy: { resolver: POLL_VOTE_POLICY_KEY, applyTo: [] },
        },
      },
    },
    clientSafeEvents: ['polls:poll.voted', 'polls:poll.vote_retracted'],
  },
});
