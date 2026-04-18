import { z } from 'zod';

/** Zod schema for voice message metadata. */
export const voiceMetadataSchema = z.object({
  duration: z.number().nonnegative(),
  waveform: z.array(z.number().min(0).max(1)).max(256).optional(),
});

/** Zod schema for validating an AssetRef in request bodies. */
export const assetRefSchema = z.object({
  assetId: z.string().min(1),
  filename: z.string().max(255).optional(),
  mimeType: z.string().max(128).optional(),
  size: z.number().int().nonnegative().optional(),
  voice: voiceMetadataSchema.optional(),
});

/** Zod schema for validating an EmbedData object. */
export const embedDataSchema = z.object({
  url: z.url(),
  title: z.string().max(512).optional(),
  description: z.string().max(2048).optional(),
  image: z.url().optional(),
  siteName: z.string().max(256).optional(),
  favicon: z.url().optional(),
  type: z.string().max(64).optional(),
});

/** Zod schema for validating a QuotePreview. */
export const quotePreviewSchema = z.object({
  body: z.string().max(200),
  authorId: z.string().min(1),
});

/** Zod schema for location data. */
export const locationDataSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().max(256).optional(),
  address: z.string().max(512).optional(),
});

/** Zod schema for contact data. */
export const contactDataSchema = z.object({
  name: z.string().min(1).max(256),
  phones: z.array(z.string().max(32)).max(5).optional(),
  emails: z.array(z.email().max(256)).max(5).optional(),
  organization: z.string().max(256).optional(),
});

/** Zod schema for system event data. */
export const systemEventDataSchema = z.object({
  event: z.string().min(1).max(64),
  actorId: z.string().max(128).optional(),
  targetId: z.string().max(128).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
