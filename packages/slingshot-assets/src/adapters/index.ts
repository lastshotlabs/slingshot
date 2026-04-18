import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import type { StorageAdapterRef } from '../types';
import { type LocalStorageConfig, localStorage } from './local';
import { memoryStorage } from './memory';
import { type S3StorageConfig, s3Storage } from './s3';

function isStorageAdapter(value: StorageAdapter | StorageAdapterRef): value is StorageAdapter {
  return typeof Reflect.get(value, 'put') === 'function';
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseLocalStorageConfig(
  config: Readonly<Record<string, unknown>> | undefined,
): LocalStorageConfig {
  const directory = config ? readString(config, 'directory') : undefined;
  if (!directory) {
    throw new Error('[slingshot-assets] local storage requires a string `directory` config value');
  }

  const baseUrl = config ? readString(config, 'baseUrl') : undefined;
  const fsValue = config?.['fs'];
  const fs =
    fsValue && typeof fsValue === 'object' ? (fsValue as LocalStorageConfig['fs']) : undefined;

  return { directory, ...(baseUrl ? { baseUrl } : {}), ...(fs ? { fs } : {}) };
}

function parseS3StorageConfig(
  config: Readonly<Record<string, unknown>> | undefined,
): S3StorageConfig {
  const bucket = config ? readString(config, 'bucket') : undefined;
  if (!bucket) {
    throw new Error('[slingshot-assets] s3 storage requires a string `bucket` config value');
  }

  const region = config ? readString(config, 'region') : undefined;
  const endpoint = config ? readString(config, 'endpoint') : undefined;
  const publicUrl = config ? readString(config, 'publicUrl') : undefined;
  const forcePathStyle = config ? readBoolean(config, 'forcePathStyle') : undefined;
  const streaming = config ? readBoolean(config, 'streaming') : undefined;

  const credentialsValue = config?.['credentials'];
  let credentials: S3StorageConfig['credentials'] | undefined;
  if (typeof credentialsValue === 'object' && credentialsValue !== null) {
    const accessKeyId = readString(credentialsValue as Record<string, unknown>, 'accessKeyId');
    const secretAccessKey = readString(
      credentialsValue as Record<string, unknown>,
      'secretAccessKey',
    );
    if (accessKeyId && secretAccessKey) {
      credentials = { accessKeyId, secretAccessKey };
    }
  }

  return {
    bucket,
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
    ...(streaming !== undefined ? { streaming } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

/**
 * Resolve a storage adapter from a manifest-compatible reference or pass through an existing
 * runtime adapter instance.
 *
 * @param ref - Runtime adapter instance or manifest-compatible adapter ref.
 * @returns The resolved storage adapter.
 */
export function resolveStorageAdapter(ref: StorageAdapter | StorageAdapterRef): StorageAdapter {
  if (isStorageAdapter(ref)) return ref;

  switch (ref.adapter) {
    case 'memory':
      return memoryStorage();
    case 'local':
      return localStorage(parseLocalStorageConfig(ref.config));
    case 's3':
      return s3Storage(parseS3StorageConfig(ref.config));
  }
}
