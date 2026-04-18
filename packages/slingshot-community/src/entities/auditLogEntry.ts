// packages/slingshot-community/src/entities/auditLogEntry.ts
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for a moderation audit log entry.
 *
 * Audit entries are server-only (no create/update/delete HTTP routes).
 * They are created by middleware after moderation actions (bans, report
 * resolutions, warnings, etc.).
 */
export const AuditLogEntry = defineEntity('AuditLogEntry', {
  namespace: 'community',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    tenantId: field.string({ optional: true }),
    action: field.string({ immutable: true }),
    actorId: field.string({ immutable: true }),
    containerId: field.string({ optional: true, immutable: true }),
    targetId: field.string({ optional: true, immutable: true }),
    targetType: field.string({ optional: true, immutable: true }),
    meta: field.json({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['containerId', 'createdAt'], { direction: 'desc' }),
    index(['actorId', 'createdAt'], { direction: 'desc' }),
    index(['action', 'createdAt'], { direction: 'desc' }),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    list: {
      permission: {
        requires: 'community:container.review-audit',
        scope: { resourceType: 'community:container', resourceId: 'query:containerId' },
      },
    },
    operations: {
      listByContainer: {
        auth: 'userAuth',
        permission: {
          requires: 'community:container.review-audit',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
      },
      listByActor: {
        auth: 'userAuth',
        permission: {
          requires: 'community:container.review-audit',
          scope: { resourceType: 'community:container', resourceId: 'body:containerId' },
        },
      },
    },
  },
});

/**
 * Custom operations for the AuditLogEntry entity.
 *
 * - `listByContainer`: Audit entries for a container (paginated).
 * - `listByActor`: Audit entries by a specific actor.
 */
export const auditLogEntryOperations = defineOperations(AuditLogEntry, {
  listByContainer: op.lookup({
    fields: { containerId: 'param:containerId' },
    returns: 'many',
  }),

  listByActor: op.lookup({
    fields: { actorId: 'param:actorId' },
    returns: 'many',
  }),
});
