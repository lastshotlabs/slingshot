import type {
  HandlerMeta,
  TriggerAdapter,
  TriggerRecord,
} from '@lastshotlabs/slingshot-core';
import { firstString } from '../correlation';

type EventBridgeEvent = {
  id?: string;
  detail?: Record<string, unknown>;
  detailType?: string;
  source?: string;
};

export const eventbridgeTrigger: TriggerAdapter<EventBridgeEvent, void> = {
  kind: 'eventbridge',
  extractInputs(event): TriggerRecord[] {
    return [
      {
        body: event.detail ?? event,
        meta: { id: event.id, detailType: event.detailType, source: event.source },
        naturalKey: event.id ? `eb:${event.id}` : undefined,
      },
    ];
  },
  extractMeta(event): Partial<HandlerMeta> {
    const detail = event.detail ?? {};
    return {
      requestId: event.id,
      correlationId: firstString(detail['correlationId'], event.id) ?? undefined,
      idempotencyKey: event.id ? `eb:${event.id}` : undefined,
    };
  },
  assembleResult() {
    return undefined;
  },
};
