import type {
  HandlerMeta,
  TriggerAdapter,
  TriggerRecord,
} from '@lastshotlabs/slingshot-core';
import { firstString } from '../correlation';

type S3Record = {
  s3: {
    bucket: { name: string };
    object: { key: string; sequencer?: string };
  };
};

type S3Event = { Records: S3Record[] };

export const s3Trigger: TriggerAdapter<S3Event, void> = {
  kind: 's3',
  extractInputs(event): TriggerRecord[] {
    return event.Records.map(record => ({
      body: record,
      meta: {
        bucket: record.s3.bucket.name,
        key: record.s3.object.key,
        sequencer: record.s3.object.sequencer,
      },
      naturalKey: `s3:${record.s3.bucket.name}:${record.s3.object.key}:${record.s3.object.sequencer ?? 'none'}`,
    }));
  },
  extractMeta(_event, record): Partial<HandlerMeta> {
    const meta = record.meta as { bucket?: string; key?: string; sequencer?: string };
    return {
      requestId: firstString(meta.sequencer, meta.key) ?? undefined,
      correlationId:
        firstString(
          meta.bucket && meta.key ? `${meta.bucket}:${meta.key}:${meta.sequencer ?? 'none'}` : null,
        ) ?? undefined,
      idempotencyKey: record.naturalKey,
    };
  },
  assembleResult() {
    return undefined;
  },
};
