import { z } from 'zod';
import { appManifestHandlerRefSchema } from './helpers';

// -- Database --
export const dbSectionSchema = z.object({
  sqlite: z
    .string()
    .optional()
    .describe("Absolute path to the SQLite database file. Omit unless a store uses 'sqlite'."),
  mongo: z
    .union([z.enum(['single', 'separate']), z.literal(false)])
    .optional()
    .describe(
      'Mongo auto-connect mode. One of: single, separate, false. Omit to use the framework default.',
    ),
  redis: z
    .union([
      z.boolean(),
      z.string(),
      z
        .object({
          url: z
            .string()
            .optional()
            .describe('Redis connection URL. Omit to use the environment or runtime default.'),
          maxRetriesPerRequest: z
            .number()
            .optional()
            .describe('Maximum Redis retries per request. Omit to use the Redis client default.'),
        })
        .loose(),
    ])
    .optional()
    .describe(
      'Redis connection toggle or configuration. Omit to use the framework default Redis behavior.',
    ),
  postgres: z
    .string()
    .optional()
    .describe("Postgres connection string. Omit unless a store uses 'postgres'."),
  sessions: z
    .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for sessions. One of: redis, mongo, sqlite, memory, postgres. Omit to use the framework default.',
    ),
  oauthState: z
    .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for OAuth state. One of: redis, mongo, sqlite, memory, postgres. Omit to follow the sessions store.',
    ),
  cache: z
    .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for cache-like framework state. One of: redis, mongo, sqlite, memory, postgres. Omit to use the framework default.',
    ),
  auth: z
    .enum(['mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for the built-in auth adapter. One of: mongo, sqlite, memory, postgres. Omit to use the framework default.',
    ),
});

// -- Jobs --
export const jobsSectionSchema = z.object({
  statusEndpoint: z.boolean().optional(),
  auth: z.union([z.enum(['userAuth', 'none']), z.array(appManifestHandlerRefSchema)]).optional(),
  roles: z.array(z.string()).optional(),
  allowedQueues: z.array(z.string()).optional(),
  scopeToUser: z.boolean().optional(),
  unsafePublic: z.boolean().optional(),
});

// -- Tenancy --
export const tenancySectionSchema = z.object({
  resolution: z.enum(['header', 'subdomain', 'path']),
  headerName: z.string().optional(),
  pathSegment: z.number().optional(),
  listEndpoint: z.string().optional(),
  onResolve: appManifestHandlerRefSchema.optional(),
  cacheTtlMs: z.number().optional(),
  cacheMaxSize: z.number().optional(),
  exemptPaths: z.array(z.string()).optional(),
  rejectionStatus: z.number().optional(),
});
