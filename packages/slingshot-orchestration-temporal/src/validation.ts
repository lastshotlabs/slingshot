import { z } from 'zod';

const temporalTlsSchema = z
  .object({
    serverNameOverride: z.string().optional(),
    serverRootCACertificate: z.string().optional(),
    clientCertPair: z
      .object({
        crt: z.string(),
        key: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const temporalConnectionConfigSchema = z
  .object({
    address: z.string().min(1),
    namespace: z.string().min(1).optional(),
    workflowTaskQueue: z.string().min(1),
    defaultActivityTaskQueue: z.string().min(1).optional(),
    tls: temporalTlsSchema.optional(),
  })
  .strict();

export const temporalAdapterOptionsSchema = z.object({
  client: z.custom<object>(value => typeof value === 'object' && value !== null),
  connection: z.custom<object>(value => value === undefined || (typeof value === 'object' && value !== null)).optional(),
  namespace: z.string().min(1).optional(),
  workflowTaskQueue: z.string().min(1),
  defaultActivityTaskQueue: z.string().min(1).optional(),
  workflowNamePrefix: z.string().min(1).optional(),
  visibilityQueryPageSize: z.number().int().positive().max(1000).optional(),
  ownsConnection: z.boolean().optional(),
});

export const temporalWorkerOptionsSchema = z.object({
  connection: z.custom<object>(value => typeof value === 'object' && value !== null),
  ownsConnection: z.boolean().optional(),
  namespace: z.string().min(1).optional(),
  workflowTaskQueue: z.string().min(1),
  defaultActivityTaskQueue: z.string().min(1).optional(),
  buildId: z.string().trim().min(1),
  definitionsModulePath: z.string().trim().min(1),
  taskNames: z.array(z.string().trim().min(1)).optional(),
  workflowNames: z.array(z.string().trim().min(1)).optional(),
  generatedWorkflowsDir: z.string().trim().min(1).optional(),
  eventSink: z.custom<object>(value => value === undefined || (typeof value === 'object' && value !== null)).optional(),
  identity: z.string().trim().min(1).optional(),
  maxConcurrentWorkflowTaskExecutions: z.number().int().positive().optional(),
  maxConcurrentActivityTaskExecutions: z.number().int().positive().optional(),
});

export type TemporalConnectionConfig = z.infer<typeof temporalConnectionConfigSchema>;
export type TemporalOrchestrationAdapterOptions = z.infer<typeof temporalAdapterOptionsSchema>;
export type TemporalOrchestrationWorkerOptions = z.infer<typeof temporalWorkerOptionsSchema>;
