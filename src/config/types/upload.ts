import type { StorageAdapter } from '@lastshotlabs/slingshot-core';

export interface PresignedUrlConfig {
  expirySeconds?: number;
  path?: string;
}

export interface UploadConfig {
  storage: StorageAdapter;
  maxFileSize?: number;
  maxFiles?: number;
  allowedMimeTypes?: string[];
  keyPrefix?: string;
  generateKey?: (file: File, ctx: { userId?: string; tenantId?: string }) => string;
  tenantScopedKeys?: boolean;
  presignedUrls?: boolean | PresignedUrlConfig;
  /**
   * TTL in seconds for upload registry entries across all backends.
   * Default: 2592000 (30 days).
   */
  registryTtlSeconds?: number;
  /**
   * Authorization callback for upload read/delete operations.
   * Called when registry ownership check fails or key is not in registry.
   */
  authorization?: {
    authorize?: (input: {
      action: 'read' | 'delete';
      key: string;
      userId?: string;
      tenantId?: string;
    }) => boolean | Promise<boolean>;
  };
  /**
   * Allow operations on keys not in the upload registry.
   * When false (default), operations on unknown keys return 404.
   * When true, requires an authorize callback — denies if absent.
   */
  allowExternalKeys?: boolean;
}
