import { z } from 'zod';

/** Request schema for the bespoke interactions dispatch route. */
export const dispatchRequestSchema = z.object({
  messageKind: z.enum(['chat:message', 'community:thread', 'community:reply', 'community:post']),
  messageId: z.string().min(1).max(128),
  actionId: z.string().min(1).max(100),
  values: z.union([z.array(z.string()).max(25), z.record(z.string(), z.string())]).optional(),
});

/** Dispatcher response schema shared by all handler kinds. */
export const dispatchResultSchema = z.object({
  status: z.enum(['ok', 'error']),
  message: z.string().optional(),
  messageUpdate: z
    .object({
      components: z.unknown(),
    })
    .optional(),
  modal: z.unknown().optional(),
  body: z.unknown().optional(),
});

/** Parsed dispatch request payload. */
export type DispatchRequest = z.infer<typeof dispatchRequestSchema>;
/** Parsed dispatch response payload. */
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
