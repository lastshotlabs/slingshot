import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, entity, op } from '@lastshotlabs/slingshot-entity';

/**
 * Custom emoji entity.
 *
 * Shortcode uniqueness is enforced by the `[orgId, shortcode]` unique index.
 * The `uploadKey` field references a file managed by the framework upload
 * system. Clients presign, upload to storage, then POST emoji metadata with
 * the key. Emojis are immutable once created — the `update` route is
 * intentionally disabled.
 */
export const EmojiEntity = defineEntity('Emoji', {
  namespace: 'emoji',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    orgId: field.string(),
    name: field.string(),
    shortcode: field.string(),
    category: field.string({ optional: true }),
    animated: field.boolean({ default: false }),
    uploadKey: field.string(),
    createdBy: field.string(),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [
    index(['orgId', 'shortcode'], { unique: true }),
    index(['orgId']),
    index(['orgId', 'category']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    list: { permission: { requires: 'emoji:emoji.read' } },
    get: { permission: { requires: 'emoji:emoji.read' } },
    create: {
      permission: { requires: 'emoji:emoji.write' },
      middleware: ['shortcodeGuard'],
      event: {
        key: 'emoji:emoji.created',
        payload: ['id', 'shortcode', 'name', 'orgId', 'createdBy'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:createdBy',
          resourceType: 'emoji:emoji',
          resourceId: 'record:id',
        },
      },
    },
    delete: {
      permission: { requires: 'emoji:emoji.delete' },
      event: {
        key: 'emoji:emoji.deleted',
        payload: ['id', 'shortcode', 'uploadKey', 'orgId'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'emoji:emoji',
          resourceId: 'record:id',
        },
      },
    },
    disable: ['update'],
    operations: {
      listByOrg: { permission: { requires: 'emoji:emoji.read' } },
      getByShortcode: { permission: { requires: 'emoji:emoji.read' } },
      listByCategory: { permission: { requires: 'emoji:emoji.read' } },
    },
    permissions: {
      resourceType: 'emoji:emoji',
      actions: ['read', 'write', 'delete'],
      roles: {
        'org:admin': ['*'],
        'org:member': ['read', 'write'],
      },
    },
    middleware: { shortcodeGuard: true },
  },
});

export const emojiOperations = defineOperations(EmojiEntity, {
  listByOrg: op.lookup({
    fields: { orgId: 'param:orgId' },
    returns: 'many',
  }),
  getByShortcode: op.lookup({
    fields: { orgId: 'param:orgId', shortcode: 'param:shortcode' },
    returns: 'one',
  }),
  listByCategory: op.lookup({
    fields: { orgId: 'param:orgId', category: 'param:category' },
    returns: 'many',
  }),
});

export const emojiModule = entity({ config: EmojiEntity, operations: emojiOperations });
