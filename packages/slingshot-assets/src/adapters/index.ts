import { z } from 'zod';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import type { StorageAdapterRef } from '../types';
import { type LocalStorageConfig, localStorage } from './local';
import { memoryStorage } from './memory';
import { type S3StorageConfig, s3Storage } from './s3';

function isStorageAdapter(value: StorageAdapter | StorageAdapterRef): value is StorageAdapter {
  return typeof Reflect.get(value, 'put') === 'function';
}

const localStorageConfigSchema = z.object({
  directory: z.string(),
  baseUrl: z.string().optional(),
  fs: z.unknown().optional(),
});

const s3CredentialsSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
});

const s3StorageConfigSchema = z.object({
  bucket: z.string(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  publicUrl: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
  streaming: z.boolean().optional(),
  credentials: s3CredentialsSchema.optional(),
});

function parseLocalStorageConfig(
  config: Readonly<Record<string, unknown>> | undefined,
): LocalStorageConfig {
  if (!config || typeof config !== 'object') {
    throw new Error(
      '[slingshot-assets] local storage requires a config object with a string `directory`',
    );
  }
  const parsed = localStorageConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`[slingshot-assets] local storage config invalid: ${parsed.error.message}`);
  }
  return {
    directory: parsed.data.directory,
    ...(parsed.data.baseUrl !== undefined ? { baseUrl: parsed.data.baseUrl } : {}),
    ...(typeof config['fs'] === 'object' && config['fs'] !== null
      ? { fs: config['fs'] as LocalStorageConfig['fs'] }
      : {}),
  };
}

function parseS3StorageConfig(
  config: Readonly<Record<string, unknown>> | undefined,
): S3StorageConfig {
  if (!config || typeof config !== 'object') {
    throw new Error(
      '[slingshot-assets] s3 storage requires a config object with a string `bucket`',
    );
  }
  const parsed = s3StorageConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`[slingshot-assets] s3 storage config invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Optional override options for built-in adapter resolution. */
export interface ResolveStorageAdapterOptions {
  /** Override the retry attempt count for `put()` and `delete()` on the S3 adapter. */
  readonly storageRetryAttempts?: number;
  /** Override the S3 circuit breaker consecutive-failure threshold. */
  readonly storageCircuitBreakerThreshold?: number;
  /** Override the S3 circuit breaker cooldown in milliseconds. */
  readonly storageCircuitBreakerCooldownMs?: number;
}

/**
 * Resolve a storage adapter from a manifest-compatible reference or pass through an existing
 * runtime adapter instance.
 *
 * @param ref - Runtime adapter instance or manifest-compatible adapter ref.
 * @param options - Optional overrides for built-in adapter configuration.
 * @returns The resolved storage adapter.
 */
export function resolveStorageAdapter(
  ref: StorageAdapter | StorageAdapterRef,
  options?: ResolveStorageAdapterOptions,
): StorageAdapter {
  if (isStorageAdapter(ref)) return ref;

  switch (ref.adapter) {
    case 'memory':
      return memoryStorage();
    case 'local':
      return localStorage(parseLocalStorageConfig(ref.config));
    case 's3': {
      const s3Config = parseS3StorageConfig(ref.config);
      return s3Storage({
        ...s3Config,
        ...(options?.storageRetryAttempts !== undefined
          ? { retryAttempts: options.storageRetryAttempts }
          : {}),
        ...(options?.storageCircuitBreakerThreshold !== undefined
          ? { circuitBreakerThreshold: options.storageCircuitBreakerThreshold }
          : {}),
        ...(options?.storageCircuitBreakerCooldownMs !== undefined
          ? { circuitBreakerCooldownMs: options.storageCircuitBreakerCooldownMs }
          : {}),
      });
    }
  }
}
