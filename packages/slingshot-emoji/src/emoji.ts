import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';

/**
 * Declarative manifest defining the Emoji entity.
 *
 * Uses the manifest-driven entity system (`createEntityPlugin` with `manifest`).
 * Defines a single entity with lookup operations for org-scoped queries and
 * permission-guarded CRUD routes. The `update` route is intentionally disabled —
 * emojis are immutable once created (delete and re-upload to change).
 *
 * The `uploadKey` field references a file managed by the framework upload system.
 * Clients presign, upload to storage, then POST emoji metadata with the key.
 *
 * @remarks
 * Shortcode uniqueness is enforced by the `[orgId, shortcode]` unique index.
 * Shortcode format — lowercase alphanumeric + underscores, 2–32 chars — is
 * validated by middleware in `createEmojiPlugin()` on the create route.
 */
export const emojiManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'emoji',
  entities: {
    Emoji: {
      fields: {
        id: { type: 'string', primary: true, default: 'uuid' },
        orgId: { type: 'string' },
        name: { type: 'string' },
        shortcode: { type: 'string' },
        category: { type: 'string', optional: true },
        animated: { type: 'boolean', default: false },
        uploadKey: { type: 'string' },
        createdBy: { type: 'string' },
        createdAt: { type: 'date', default: 'now' },
      },
      indexes: [
        { fields: ['orgId', 'shortcode'], unique: true },
        { fields: ['orgId'] },
        { fields: ['orgId', 'category'] },
      ],
      operations: {
        listByOrg: {
          kind: 'lookup',
          fields: { orgId: 'param:orgId' },
          returns: 'many',
        },
        getByShortcode: {
          kind: 'lookup',
          fields: { orgId: 'param:orgId', shortcode: 'param:shortcode' },
          returns: 'one',
        },
        listByCategory: {
          kind: 'lookup',
          fields: { orgId: 'param:orgId', category: 'param:category' },
          returns: 'many',
        },
      },
      routes: {
        defaults: { auth: 'userAuth' },
        list: {
          permission: { requires: 'emoji:emoji.read' },
        },
        get: {
          permission: { requires: 'emoji:emoji.read' },
        },
        create: {
          permission: { requires: 'emoji:emoji.write' },
          event: {
            key: 'emoji:emoji.created',
            payload: ['id', 'shortcode', 'name', 'orgId', 'createdBy'],
          },
        },
        delete: {
          permission: { requires: 'emoji:emoji.delete' },
          event: {
            key: 'emoji:emoji.deleted',
            payload: ['id', 'shortcode', 'uploadKey', 'orgId'],
          },
        },
        disable: ['update'],
        operations: {
          listByOrg: {
            permission: { requires: 'emoji:emoji.read' },
          },
          getByShortcode: {
            permission: { requires: 'emoji:emoji.read' },
          },
          listByCategory: {
            permission: { requires: 'emoji:emoji.read' },
          },
        },
        permissions: {
          resourceType: 'emoji:emoji',
          actions: ['read', 'write', 'delete'],
          roles: {
            'org:admin': ['*'],
            'org:member': ['read', 'write'],
          },
        },
        clientSafeEvents: ['emoji:emoji.created', 'emoji:emoji.deleted'],
      },
    },
  },
};
