import type {
  HandlerMeta,
  TriggerAdapter,
  TriggerRecord,
} from '@lastshotlabs/slingshot-core';
import { decodeMaybeJson, firstString } from '../correlation';

type SnsRecord = {
  Sns: {
    MessageId: string;
    Message: string;
    MessageAttributes?: Record<string, { Value?: string }>;
  };
};

type SnsEvent = { Records: SnsRecord[] };

export const snsTrigger: TriggerAdapter<SnsEvent, void> = {
  kind: 'sns',
  extractInputs(event): TriggerRecord[] {
    return event.Records.map(record => ({
      body: decodeMaybeJson(record.Sns.Message),
      meta: {
        messageId: record.Sns.MessageId,
        attributes: record.Sns.MessageAttributes ?? {},
      },
      naturalKey: `sns:${record.Sns.MessageId}`,
    }));
  },
  extractMeta(_event, record): Partial<HandlerMeta> {
    const meta = record.meta as {
      messageId?: string;
      attributes?: Record<string, { Value?: string }>;
    };
    const correlationId =
      firstString(
        Object.entries(meta.attributes ?? {}).find(([name]) => name.toLowerCase() === 'correlationid')?.[1]
          ?.Value,
        meta.messageId,
      ) ?? undefined;
    return {
      requestId: meta.messageId,
      correlationId,
      idempotencyKey: record.naturalKey,
    };
  },
  assembleResult() {
    return undefined;
  },
};
