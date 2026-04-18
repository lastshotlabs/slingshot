import { z } from 'zod';

// Tracks whether this file was imported — read by preloadSchemas tests
(globalThis as any).__fixtureUserSchemaLoaded = true;

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().optional(),
});

export const ProfileSchema = z.object({
  userId: z.string(),
  bio: z.string().optional(),
});
