import { CompressionTypes, type CompressionTypes as KafkaCompressionTypes } from 'kafkajs';
import { z } from 'zod';

export const saslSchema = z.discriminatedUnion('mechanism', [
  z.object({
    mechanism: z.literal('plain'),
    username: z.string(),
    password: z.string(),
  }),
  z.object({
    mechanism: z.literal('scram-sha-256'),
    username: z.string(),
    password: z.string(),
  }),
  z.object({
    mechanism: z.literal('scram-sha-512'),
    username: z.string(),
    password: z.string(),
  }),
]);

export const sslSchema = z.union([
  z.literal(true),
  z.object({
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
    rejectUnauthorized: z.boolean().optional(),
  }),
]);

export const compressionSchema = z.enum(['gzip', 'snappy', 'lz4', 'zstd']);

export type CompressionCodec = z.infer<typeof compressionSchema>;

export const COMPRESSION_CODEC: Record<CompressionCodec, KafkaCompressionTypes> = {
  gzip: CompressionTypes.GZIP,
  snappy: CompressionTypes.Snappy,
  lz4: CompressionTypes.LZ4,
  zstd: CompressionTypes.ZSTD,
};

export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 100);
  return base + jitter;
}
