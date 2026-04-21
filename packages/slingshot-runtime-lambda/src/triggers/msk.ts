import type { HandlerMeta, TriggerAdapter, TriggerRecord } from '@lastshotlabs/slingshot-core';
import { decodeBase64JsonOrText, firstString } from '../correlation';

type MskRecord = {
  topic: string;
  partition: number;
  offset: number;
  key?: string;
  value: string;
  headers?: Array<Record<string, string[]>>;
};

type MskEvent = { records: Record<string, MskRecord[]> };

function readHeader(record: MskRecord, name: string): string | null {
  for (const entry of record.headers ?? []) {
    for (const [key, values] of Object.entries(entry)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        return values[0] ?? null;
      }
    }
  }
  return null;
}

export const mskTrigger: TriggerAdapter<MskEvent, void> = {
  kind: 'msk',
  extractInputs(event): TriggerRecord[] {
    return Object.values(event.records).flatMap(records =>
      records.map(record => ({
        body: decodeBase64JsonOrText(record.value),
        meta: {
          topic: record.topic,
          partition: record.partition,
          offset: record.offset,
          headers: record.headers ?? [],
        },
        naturalKey: `msk:${record.topic}:${record.partition}:${record.offset}`,
      })),
    );
  },
  extractMeta(_event, record): Partial<HandlerMeta> {
    const meta = record.meta as {
      topic?: string;
      partition?: number;
      offset?: number;
      headers?: Array<Record<string, string[]>>;
    };
    const correlationId =
      firstString(
        readHeader(
          {
            topic: meta.topic ?? '',
            partition: meta.partition ?? 0,
            offset: meta.offset ?? 0,
            value: '',
            headers: meta.headers ?? [],
          },
          'correlationId',
        ),
        `${meta.topic}:${meta.partition}:${meta.offset}`,
      ) ?? undefined;
    return {
      requestId: `${meta.topic}:${meta.partition}:${meta.offset}`,
      correlationId,
      idempotencyKey: record.naturalKey,
    };
  },
  assembleResult() {
    return undefined;
  },
};
