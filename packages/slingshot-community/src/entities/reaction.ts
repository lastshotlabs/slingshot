import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user reaction (upvote, downvote, or emoji) on a
 * thread or reply.
 *
 * Exported as `ReactionEntity` from the package index.
 *
 * @remarks
 * The `updateScore` custom operation is the core of the scoring system. It is
 * adapter-only (no HTTP route) and is injected by `reactionBuildAdapter` in
 * `plugin.ts` with a handler that reads `config.scoring` from the plugin
 * config closure. The handler:
 * 1. Lists all reactions for the target entity.
 * 2. Computes the score using the configured algorithm
 *    (`computeNetScore` / `computeHotScore` / `computeControversialScore`).
 * 3. Writes `score` and `reactionSummary` back to the target thread or reply.
 *
 * Cascade: when `auth:user.deleted` fires, all reactions by that user are
 * hard-deleted.
 */
export const Reaction = defineEntity('Reaction', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    targetId: field.string(),
    targetType: field.enum(['thread', 'reply'] as const),
    containerId: field.string({ optional: true }),
    userId: field.string(),
    type: field.enum(['upvote', 'downvote', 'emoji'] as const),
    value: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [
    index(['targetId', 'targetType']),
    index(['targetId', 'targetType', 'userId'], { unique: true }),
    index(['containerId']),
    index(['userId']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'userId', from: 'ctx:actor.id' },

    get: { auth: 'none' },
    list: { auth: 'none' },

    create: {
      event: {
        key: 'community:reaction.added',
        payload: ['targetId', 'targetType', 'tenantId', 'containerId', 'userId', 'type', 'value'],
        exposure: ['client-safe', 'tenant-webhook'],
        scope: {
          tenantId: 'record:tenantId',
          userId: 'record:userId',
          actorId: 'ctx:actorId',
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
    },
    delete: {
      event: {
        key: 'community:reaction.removed',
        payload: ['targetId', 'targetType', 'tenantId', 'containerId', 'userId', 'type'],
        exposure: ['client-safe', 'tenant-webhook'],
        scope: {
          tenantId: 'record:tenantId',
          userId: 'record:userId',
          actorId: 'ctx:actorId',
          resourceType: 'community:container',
          resourceId: 'record:containerId',
        },
      },
    },

    operations: {
      listByTarget: { auth: 'none' },
      getUserReaction: { auth: 'none' },
      updateScore: { auth: 'userAuth' },
    },
    cascades: [
      {
        event: 'auth:user.deleted',
        batch: { action: 'delete', filter: { userId: 'param:userId' } },
      },
    ],
  },
});

/**
 * Custom operations for the Reaction entity.
 *
 * - `listByTarget`: all reactions on a specific thread or reply.
 * - `getUserReaction`: the calling user's reaction on a specific target.
 * - `updateScore`: adapter-only op (no HTTP route). Handler injected by
 *   `reactionBuildAdapter` in `plugin.ts`. Aggregates reactions, computes the
 *   configured algorithm's score, and writes `score` + `reactionSummary` to
 *   the target thread or reply.
 */
export const reactionOperations = defineOperations(Reaction, {
  listByTarget: op.lookup({
    fields: { targetId: 'param:targetId', targetType: 'param:targetType' },
    returns: 'many',
  }),

  getUserReaction: op.lookup({
    fields: {
      targetId: 'param:targetId',
      targetType: 'param:targetType',
      userId: 'param:userId',
    },
    returns: 'one',
  }),

  /**
   * Compute and persist the score for a reaction target.
   *
   * Adapter-only — no HTTP route is mounted. Called after a reaction is
   * created or deleted. The actual implementation is injected onto the
   * adapter by `reactionBuildAdapter` in `plugin.ts` because the handler
   * must close over the frozen `config.scoring` value from the plugin config.
   */
  updateScore: op.custom({}),
});
