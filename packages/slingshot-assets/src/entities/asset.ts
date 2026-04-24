import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';

/**
 * Entity definition for an uploaded asset.
 *
 * Replaces the bespoke upload registry with a standard entity that participates in
 * CRUD lifecycle, events, and permissions.
 */
export const Asset = defineEntity('Asset', {
  namespace: 'assets',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    key: field.string({ immutable: true }),
    ownerUserId: field.string({ optional: true }),
    tenantId: field.string({ optional: true }),
    mimeType: field.string({ optional: true }),
    size: field.integer({ optional: true }),
    bucket: field.string({ optional: true }),
    originalName: field.string({ optional: true }),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    index(['key'], { unique: true }),
    index(['ownerUserId']),
    index(['tenantId', 'ownerUserId']),
  ],
  routes: {
    defaults: { auth: 'userAuth' },
    dataScope: { field: 'ownerUserId', from: 'ctx:actor.id' },
    get: {},
    list: {},
    create: {
      auth: 'userAuth',
      event: {
        key: 'assets:asset.created',
        payload: ['id', 'key', 'ownerUserId', 'mimeType'],
        exposure: ['client-safe'],
        scope: {
          userId: 'record:ownerUserId',
          resourceType: 'assets:asset',
          resourceId: 'record:id',
        },
      },
    },
    delete: {
      auth: 'userAuth',
      event: {
        key: 'assets:asset.deleted',
        payload: ['id', 'key'],
        exposure: ['client-safe'],
        scope: {
          resourceType: 'assets:asset',
          resourceId: 'record:id',
        },
      },
      middleware: ['deleteStorageFile'],
    },
    operations: {
      listByOwner: { auth: 'userAuth' },
      existsByKey: { auth: 'userAuth' },
      findByKey: { auth: 'userAuth' },
      presignUpload: { auth: 'userAuth' },
      presignDownload: { auth: 'userAuth' },
      serveImage: { auth: 'userAuth' },
    },
    middleware: { deleteStorageFile: true },
  },
});

/**
 * Named operations for the `Asset` entity.
 */
export const assetOperations = defineOperations(Asset, {
  /**
   * List assets owned by a specific user.
   */
  listByOwner: op.lookup({
    fields: { ownerUserId: 'param:ownerUserId' },
    returns: 'many',
  }),

  /**
   * Check whether an asset exists for a storage key.
   */
  existsByKey: op.exists({
    fields: { key: 'param:key' },
  }),

  /**
   * Find a single asset by storage key.
   */
  findByKey: op.lookup({
    fields: { key: 'param:key' },
    returns: 'one',
  }),

  /**
   * Generate a presigned upload URL for a new asset.
   *
   * The runtime handler is wired by the assets plugin's adapter closure.
   */
  presignUpload: op.custom({
    http: { method: 'post' },
  }),

  /**
   * Generate a presigned download URL for an existing asset.
   *
   * The runtime handler is wired by the assets plugin's adapter closure.
   */
  presignDownload: op.custom({
    http: { method: 'post' },
  }),

  /**
   * Serve an optimized image transform for an existing asset.
   *
   * The runtime handler is wired by the assets plugin's adapter closure.
   */
  serveImage: op.custom({
    http: { method: 'get', path: ':id/image' },
  }),
});
