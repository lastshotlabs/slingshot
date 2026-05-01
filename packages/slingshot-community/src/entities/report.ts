import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a user-submitted content report.
 *
 * Exported as `ReportEntity` from the package index.
 *
 * @remarks
 * List and get operations require the `community:container.review-report`
 * permission. The package-owned auto-moderation middleware can automatically
 * create report records when declarative moderation rules flag content for
 * review.
 */
export const Report = defineEntity('Report', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    containerId: field.string({ optional: true }),
    targetId: field.string(),
    targetType: field.enum(['thread', 'reply', 'user'] as const),
    reporterId: field.string(),
    reason: field.string(),
    status: field.enum(['pending', 'resolved', 'dismissed'] as const, { default: 'pending' }),
    resolvedBy: field.string({ optional: true }),
    resolvedAction: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    index(['status']),
    index(['containerId', 'status']),
    index(['targetId', 'targetType']),
    index(['tenantId']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'reporterId', from: 'ctx:actor.id', applyTo: ['create'] },

    create: {
      middleware: ['reportTargetGuard'],
      event: {
        key: 'community:content.reported',
        payload: ['id', 'containerId', 'targetId', 'targetType', 'reporterId', 'reason'],
      },
    },
    get: {
      permission: {
        requires: 'community:container.review-report',
        scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
      },
    },
    list: {
      permission: {
        requires: 'community:container.review-report',
        scope: { resourceType: 'community:container', resourceId: 'query:containerId' },
      },
    },

    operations: {
      resolve: {
        permission: {
          requires: 'community:container.review-report',
          scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
        },
        middleware: ['auditLog'],
      },
      dismiss: {
        permission: {
          requires: 'community:container.review-report',
          scope: { resourceType: 'community:container', resourceId: 'record:containerId' },
        },
        middleware: ['auditLog'],
      },
    },

    middleware: { auditLog: true, reportTargetGuard: true },
  },
});

/**
 * Custom operations for the Report entity.
 *
 * - `resolve`: pending → resolved state transition; records the moderator's
 *   user ID and a description of the action taken.
 * - `dismiss`: pending → dismissed state transition; records the dismissing
 *   moderator's user ID.
 *
 * Both operations require the `community:container.review-report` permission
 * and are audited via the `auditLog` middleware.
 */
export const reportOperations = defineOperations(Report, {
  resolve: op.transition({
    field: 'status',
    from: 'pending',
    to: 'resolved',
    match: { id: 'param:id' },
    set: { resolvedBy: 'param:actor.id', resolvedAction: 'param:action' },
    returns: 'entity',
  }),

  dismiss: op.transition({
    field: 'status',
    from: 'pending',
    to: 'dismissed',
    match: { id: 'param:id' },
    set: { resolvedBy: 'param:actor.id' },
    returns: 'entity',
  }),
});
