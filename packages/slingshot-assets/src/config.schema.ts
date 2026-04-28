import { z } from 'zod';
import type { StorageAdapter } from '@lastshotlabs/slingshot-core';

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error("mountPath must start with '/'");
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error("mountPath must not be '/'");
  }

  return normalized;
}

const storageAdapterRefSchema = z.object({
  adapter: z
    .enum(['s3', 'local', 'memory'])
    .describe('Built-in storage adapter to instantiate. One of: s3, local, memory.'),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Adapter-specific configuration passed to the built-in storage adapter. Omit to use the adapter defaults.',
    ),
});

const presignedUrlConfigSchema = z.object({
  expirySeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Lifetime of generated presigned upload URLs in seconds. Omit to use the plugin default.',
    ),
});

const imageConfigSchema = z.object({
  allowedOrigins: z
    .array(z.string())
    .optional()
    .describe(
      'Origins allowed to request image transformations. Omit to allow the plugin default origin policy.',
    ),
  maxWidth: z
    .number()
    .int()
    .positive()
    .max(4096)
    .optional()
    .describe(
      'Maximum transformed image width in pixels. Omit to use the plugin default width limit.',
    ),
  maxHeight: z
    .number()
    .int()
    .positive()
    .max(4096)
    .optional()
    .describe(
      'Maximum transformed image height in pixels. Omit to use the plugin default height limit.',
    ),
  maxInputBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Hard cap on source bytes loaded into memory before image transform. Defends against image-bomb DoS. Default 25 MiB.',
    ),
  transformTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Wall-clock timeout for the Sharp transform pipeline in milliseconds. Default 10 000 ms.',
    ),
  cache: z
    .unknown()
    .optional()
    .describe(
      'Runtime cache implementation for transformed image responses. Omit to disable plugin-managed image caching.',
    ),
});

/**
 * Zod schema for `AssetsPluginConfig`.
 *
 * Runtime object inputs such as `storage` adapter instances and `image.cache`
 * are preserved as unknown values and validated structurally by the plugin.
 *
 * @internal
 */
export const assetsPluginConfigSchema = z.object({
  mountPath: z
    .string()
    .min(1)
    .transform(value => normalizeMountPath(value))
    .optional()
    .describe(
      "URL path prefix for asset routes. Must start with '/'. Trailing slashes are trimmed. Omit to use the plugin default mount path.",
    ),
  storage: z
    .union([
      storageAdapterRefSchema,
      z.custom<StorageAdapter>(value => {
        if (typeof value !== 'object' || value === null) return false;
        return typeof Reflect.get(value as Record<string, unknown>, 'put') === 'function';
      }),
    ])
    .describe(
      'Storage adapter reference or runtime storage adapter instance used for uploaded assets.',
    ),
  maxFileSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum upload size in bytes for a single file. Omit to use the plugin default limit.',
    ),
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum number of files accepted per request. Omit to use the plugin default limit.',
    ),
  allowedMimeTypes: z
    .array(z.string())
    .optional()
    .describe('Allowed MIME types for uploads. Omit to allow the plugin default MIME-type policy.'),
  keyPrefix: z
    .string()
    .optional()
    .describe('Prefix applied to generated storage keys. Omit to write keys at the adapter root.'),
  tenantScopedKeys: z
    .boolean()
    .optional()
    .describe(
      'Whether generated storage keys are namespaced by tenant ID. Omit to use the plugin default tenant-key behavior.',
    ),
  presignedUrls: z
    .union([z.boolean(), presignedUrlConfigSchema])
    .optional()
    .describe(
      'Presigned upload URL support or its configuration. Omit to use the plugin default presigned-URL behavior.',
    ),
  registryTtlSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'How long uploaded asset metadata stays cached in the registry, in seconds. Omit to use the plugin default TTL.',
    ),
  image: imageConfigSchema
    .optional()
    .describe(
      'Image transformation limits and cache settings for image-aware asset routes. Omit to disable image-specific overrides.',
    ),
  tenantId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Fixed tenant ID applied to asset operations. Omit to resolve tenancy from the surrounding app context.',
    ),
  storageRetryAttempts: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      'Number of attempts for storage put/delete operations before giving up. Default: 3. ' +
        'Each retry uses an increasing delay (attempt × 500 ms).',
    ),
  allowOrphanedStorage: z
    .boolean()
    .optional()
    .describe(
      'Allow asset deletes to leave behind storage objects when the manifest runtime ' +
        "doesn't wire a delete-storage middleware. Default false. Only set true as a " +
        'migration opt-out where cleanup runs elsewhere.',
    ),
});

/**
 * Parsed assets plugin config shape inferred from `assetsPluginConfigSchema`.
 *
 * @internal
 */
export type AssetsPluginConfigParsed = z.infer<typeof assetsPluginConfigSchema>;
