import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import { entityConfigToManifestEntry } from '@lastshotlabs/slingshot-entity';
import { Asset, assetOperations } from '../entities/asset';

/**
 * Manifest export for the persisted assets resource.
 *
 * Upload presigning, image serving, and storage cleanup remain package-owned
 * runtime behavior resolved through the manifest runtime registries.
 */
export const assetManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'assets',
  hooks: {
    afterAdapters: [{ handler: 'assets.captureAssetAdapter' }],
  },
  entities: {
    Asset: entityConfigToManifestEntry(Asset, {
      operations: assetOperations.operations,
      operationOverrides: {
        presignUpload: {
          kind: 'custom',
          handler: 'assets.asset.presignUpload',
          http: { method: 'post' },
        },
        presignDownload: {
          kind: 'custom',
          handler: 'assets.asset.presignDownload',
          http: { method: 'post' },
        },
        serveImage: {
          kind: 'custom',
          handler: 'assets.asset.serveImage',
          http: { method: 'get', path: ':id/image' },
        },
      },
      adapterTransforms: [{ handler: 'assets.asset.ttl' }],
    }),
  },
};
