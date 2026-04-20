import type {
  HandlerMeta,
  TriggerAdapter,
  TriggerRecord,
} from '@lastshotlabs/slingshot-core';
import { decodeBase64JsonOrText } from '../correlation';

type KinesisRecord = {
  eventID?: string;
  kinesis: {
    sequenceNumber: string;
    data: string;
    partitionKey?: string;
  };
};

type KinesisEvent = { Records: KinesisRecord[] };

export const kinesisTrigger: TriggerAdapter<KinesisEvent, void> = {
  kind: 'kinesis',
  extractInputs(event): TriggerRecord[] {
    return event.Records.map(record => ({
      body: decodeBase64JsonOrText(record.kinesis.data),
      meta: {
        eventID: record.eventID,
        sequenceNumber: record.kinesis.sequenceNumber,
        partitionKey: record.kinesis.partitionKey,
      },
      naturalKey: `kinesis:${record.kinesis.sequenceNumber}`,
    }));
  },
  extractMeta(_event, record): Partial<HandlerMeta> {
    const meta = record.meta as { sequenceNumber?: string };
    return {
      requestId: meta.sequenceNumber,
      correlationId: meta.sequenceNumber,
      idempotencyKey: record.naturalKey,
    };
  },
  assembleResult() {
    return undefined;
  },
};
