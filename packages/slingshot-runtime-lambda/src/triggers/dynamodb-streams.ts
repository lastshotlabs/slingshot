import type {
  HandlerMeta,
  TriggerAdapter,
  TriggerRecord,
} from '@lastshotlabs/slingshot-core';

type DynamoRecord = {
  eventID: string;
  eventName?: string;
  dynamodb?: Record<string, unknown>;
};

type DynamoEvent = { Records: DynamoRecord[] };

export const dynamodbStreamsTrigger: TriggerAdapter<DynamoEvent, void> = {
  kind: 'dynamodb-streams',
  extractInputs(event): TriggerRecord[] {
    return event.Records.map(record => ({
      body: record,
      meta: { eventID: record.eventID, eventName: record.eventName },
      naturalKey: `dynamodb:${record.eventID}`,
    }));
  },
  extractMeta(_event, record): Partial<HandlerMeta> {
    const meta = record.meta as { eventID?: string };
    return {
      requestId: meta.eventID,
      correlationId: meta.eventID,
      idempotencyKey: record.naturalKey,
    };
  },
  assembleResult() {
    return undefined;
  },
};
