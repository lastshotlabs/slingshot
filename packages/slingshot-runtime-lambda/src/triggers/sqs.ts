import type { HandlerMeta, TriggerAdapter, TriggerRecord } from '@lastshotlabs/slingshot-core';
import { decodeMaybeJson, firstString } from '../correlation';

type SqsRecord = {
  messageId: string;
  body: string;
  messageAttributes?: Record<
    string,
    { stringValue?: string; binaryValue?: string; stringListValues?: string[] }
  >;
};

type SqsEvent = { Records: SqsRecord[] };

export const sqsTrigger: TriggerAdapter<
  SqsEvent,
  { batchItemFailures: Array<{ itemIdentifier: string }> }
> = {
  kind: 'sqs',
  extractInputs(event): TriggerRecord[] {
    return event.Records.map(record => ({
      body: decodeMaybeJson(record.body),
      meta: { messageId: record.messageId, messageAttributes: record.messageAttributes ?? {} },
      naturalKey: `sqs:${record.messageId}`,
    }));
  },
  extractMeta(_event, record): Partial<HandlerMeta> {
    const meta = record.meta as {
      messageId?: string;
      messageAttributes?: Record<string, { stringValue?: string }>;
    };
    const messageAttributes = meta.messageAttributes ?? {};
    const correlationId =
      firstString(
        Object.entries(messageAttributes).find(
          ([name]) => name.toLowerCase() === 'correlationid',
        )?.[1]?.stringValue,
        meta.messageId,
      ) ?? undefined;
    return {
      requestId: meta.messageId,
      correlationId,
      idempotencyKey: record.naturalKey,
    };
  },
  assembleResult(outcomes) {
    return {
      batchItemFailures: outcomes
        .filter(outcome => outcome.result === 'error')
        .map(outcome => ({
          itemIdentifier: String(outcome.meta.messageId ?? ''),
        })),
    };
  },
};
