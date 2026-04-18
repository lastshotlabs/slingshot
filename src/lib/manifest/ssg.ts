import { z } from 'zod';
import { appManifestHandlerRefSchema } from './helpers';

// -- SSG --
export const ssgSectionSchema = z.object({
  enabled: z.boolean().optional(),
  outDir: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
  clientEntry: z.string().optional(),
  renderer: appManifestHandlerRefSchema.optional(),
  serverRoutesDir: z.string().optional(),
  assetsManifest: z.string().optional(),
});

// -- Versioning --
export const versioningSchema = z.union([
  z.object({
    versions: z.array(z.string()),
    sharedDir: z.string().optional(),
    defaultVersion: z.string().optional(),
  }),
  z.array(z.string()),
]);

// -- Model Schemas --
export const modelSchemasSchema = z.union([
  z.string(),
  z.array(z.string()),
  z
    .object({
      paths: z.union([z.string(), z.array(z.string())]).optional(),
      registration: z.enum(['auto', 'explicit']).optional(),
    })
    .loose(),
]);
