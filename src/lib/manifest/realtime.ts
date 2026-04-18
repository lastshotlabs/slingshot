import { z } from 'zod';
import { appManifestHandlerRefSchema } from './helpers';

// -- TLS --
export const tlsSectionSchema = z.object({
  keyPath: z.string().optional(),
  certPath: z.string().optional(),
  caPath: z.string().optional(),
  passphrase: z.string().optional(),
  serverName: z.string().optional(),
  dhParamsFile: z.string().optional(),
  lowMemoryMode: z.boolean().optional(),
  secureOptions: z.number().optional(),
  rejectUnauthorized: z.boolean().optional(),
  requestCert: z.boolean().optional(),
});

// -- WS Endpoint --
const wsEndpointSchema = z.object({
  upgrade: appManifestHandlerRefSchema.optional(),
  on: z
    .object({
      open: appManifestHandlerRefSchema.optional(),
      message: appManifestHandlerRefSchema.optional(),
      close: appManifestHandlerRefSchema.optional(),
      drain: appManifestHandlerRefSchema.optional(),
    })
    .loose()
    .optional(),
  onRoomSubscribe: appManifestHandlerRefSchema.optional(),
  maxMessageSize: z.number().optional(),
  heartbeat: z
    .union([
      z.boolean(),
      z
        .object({
          intervalMs: z.number().optional(),
          timeoutMs: z.number().optional(),
        })
        .loose(),
    ])
    .optional(),
  presence: z
    .union([z.boolean(), z.object({ broadcastEvents: z.boolean().optional() }).loose()])
    .optional(),
  persistence: z
    .object({
      store: z.string().optional(),
      defaults: z
        .object({
          maxCount: z.number().optional(),
          ttlSeconds: z.number().optional(),
        })
        .optional(),
    })
    .loose()
    .optional(),
});

// -- WS --
export const wsSectionSchema = z.object({
  endpoints: z.record(z.string(), wsEndpointSchema.loose()),
  transport: z
    .union([
      z.literal('in-memory'),
      z.object({
        type: z.literal('redis'),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    ])
    .optional(),
  idleTimeout: z.number().optional(),
  backpressureLimit: z.number().optional(),
  closeOnBackpressureLimit: z.boolean().optional(),
  perMessageDeflate: z.boolean().optional(),
  publishToSelf: z.boolean().optional(),
});

// -- SSE Endpoint --
const sseEndpointSchema = z.object({
  events: z.array(z.string()),
  upgrade: appManifestHandlerRefSchema.optional(),
  filter: appManifestHandlerRefSchema.optional(),
  heartbeat: z.union([z.number(), z.literal(false)]).optional(),
});

// -- SSE --
export const sseSectionSchema = z.object({
  endpoints: z.record(z.string(), sseEndpointSchema.loose()),
});
