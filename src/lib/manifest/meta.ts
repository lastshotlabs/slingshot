import { z } from 'zod';

// -- Meta --
export const metaSectionSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'Application name shown in generated tooling and metadata. Omit to leave the manifest unnamed.',
    ),
  version: z
    .string()
    .optional()
    .describe(
      'Application version string for metadata and generated output. Omit to leave the version unspecified.',
    ),
});
