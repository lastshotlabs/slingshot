import { z } from 'zod';
import { appManifestHandlerRefSchema, storageRefSchema } from './helpers';

// -- Upload --
const uploadPresignedSectionSchema = z.object({
  expirySeconds: z
    .number()
    .optional()
    .describe('Lifetime of generated upload URLs in seconds. Omit to use the upload default.'),
  path: z
    .string()
    .optional()
    .describe(
      'Route path used for presigned upload URL generation. Omit to use the upload default path.',
    ),
});

export const uploadSectionSchema = z.object({
  storage: storageRefSchema.describe('Storage adapter used for uploaded files.'),
  maxFileSize: z
    .number()
    .optional()
    .describe(
      'Maximum upload size in bytes for a single file. Omit to use the upload default limit.',
    ),
  maxFiles: z
    .number()
    .optional()
    .describe(
      'Maximum number of files accepted per request. Omit to use the upload default limit.',
    ),
  allowedMimeTypes: z
    .array(z.string())
    .optional()
    .describe('Allowed MIME types for uploads. Omit to allow the upload default MIME-type policy.'),
  keyPrefix: z
    .string()
    .optional()
    .describe(
      'Prefix applied to generated upload keys. Omit to store objects at the adapter root.',
    ),
  generateKey: appManifestHandlerRefSchema
    .optional()
    .describe(
      'Handler reference that generates storage keys for uploads. Omit to use the framework default key generator.',
    ),
  tenantScopedKeys: z
    .boolean()
    .optional()
    .describe('Whether upload keys are namespaced by tenant ID. Omit to use the upload default.'),
  presignedUrls: z
    .union([z.boolean(), uploadPresignedSectionSchema.loose()])
    .optional()
    .describe(
      'Whether presigned upload URLs are enabled and, optionally, how they are configured. Omit to use the upload default.',
    ),
  authorization: z
    .object({
      authorize: z
        .union([
          z
            .enum(['owner', 'authenticated', 'public'])
            .describe(
              'Built-in upload authorization strategy. ' +
                '"owner" allows access only to the user who uploaded the file (framework default behavior). ' +
                '"authenticated" allows any authenticated user to access any file. ' +
                '"public" allows unauthenticated access to all files.',
            ),
          appManifestHandlerRefSchema,
        ])
        .optional()
        .describe(
          'Upload authorization strategy or handler reference. ' +
            'Omit to use owner-only access (framework default).',
        ),
    })
    .loose()
    .optional()
    .describe(
      'Authorization hooks for upload operations. Omit to use the upload default authorization behavior.',
    ),
  allowExternalKeys: z
    .boolean()
    .optional()
    .describe('Whether callers may supply their own storage keys. Omit to use the upload default.'),
});
