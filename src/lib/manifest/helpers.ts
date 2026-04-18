/**
 * Shared manifest helper schemas — handler references, plugin references, and storage references.
 *
 * These schemas are used by domain files and the top-level assembly.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Handler reference — serializable substitute for function-typed fields
// ---------------------------------------------------------------------------

export const appManifestHandlerRefSchema = z.object({
  handler: z.string().describe('Handler name resolved from the manifest runtime registry.'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Static parameters forwarded to the resolved handler. Omit to call the handler without params.',
    ),
});

export type AppManifestHandlerRef = z.infer<typeof appManifestHandlerRefSchema>;

// ---------------------------------------------------------------------------
// Plugin reference — declarative plugin instantiation
// ---------------------------------------------------------------------------

export const pluginRefSchema = z.object({
  plugin: z
    .string()
    .describe('Built-in or registered plugin name to instantiate from the manifest.'),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Plugin-specific configuration object passed to the named plugin. Omit to use the plugin defaults.',
    ),
});

export type PluginRef = z.infer<typeof pluginRefSchema>;

// ---------------------------------------------------------------------------
// Storage adapter reference
// ---------------------------------------------------------------------------

export const storageRefSchema = z.object({
  adapter: z
    .enum(['memory', 'local', 's3'])
    .describe('Storage adapter to use for uploads. One of: memory, local, s3.'),
  config: z
    .object({
      directory: z
        .string()
        .optional()
        .describe(
          'Filesystem directory used by the local storage adapter. Omit when the adapter does not use a local directory.',
        ),
      bucket: z
        .string()
        .optional()
        .describe(
          'Bucket name used by the S3 storage adapter. Omit when the adapter does not use buckets.',
        ),
      region: z
        .string()
        .optional()
        .describe(
          'Storage region for S3-compatible adapters. Omit to use the provider default region resolution.',
        ),
      endpoint: z
        .string()
        .optional()
        .describe(
          'Custom endpoint URL for S3-compatible adapters. Omit to use the provider default endpoint.',
        ),
      accessKeyId: z
        .string()
        .optional()
        .describe('Access key ID for S3-compatible adapters. Omit to use ambient credentials.'),
      secretAccessKey: z
        .string()
        .optional()
        .describe('Secret access key for S3-compatible adapters. Omit to use ambient credentials.'),
      pathStyle: z
        .boolean()
        .optional()
        .describe(
          'Whether S3 requests use path-style bucket addressing. Omit to use the adapter default.',
        ),
      keyPrefix: z
        .string()
        .optional()
        .describe(
          'Prefix applied to generated storage keys. Omit to store objects at the adapter root.',
        ),
    })
    .loose()
    .optional()
    .describe('Adapter-specific storage settings. Omit to use the adapter defaults.'),
});

export type StorageRef = z.infer<typeof storageRefSchema>;
