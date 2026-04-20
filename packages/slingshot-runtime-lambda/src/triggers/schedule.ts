import type {
  HandlerMeta,
  TriggerAdapter,
  TriggerRecord,
} from '@lastshotlabs/slingshot-core';
import { firstString } from '../correlation';

type ScheduleEvent = {
  id?: string;
  time?: string;
  detail?: Record<string, unknown>;
  resources?: string[];
};

export const scheduleTrigger: TriggerAdapter<ScheduleEvent, void> = {
  kind: 'schedule',
  extractInputs(event): TriggerRecord[] {
    return [
      {
        body: event.detail ?? event,
        meta: { id: event.id, time: event.time, resources: event.resources ?? [] },
        naturalKey: event.id && event.time ? `sched:${event.id}:${event.time}` : undefined,
      },
    ];
  },
  extractMeta(event): Partial<HandlerMeta> {
    return {
      requestId: event.id,
      correlationId: firstString(event.id) ?? crypto.randomUUID(),
      idempotencyKey: event.id && event.time ? `sched:${event.id}:${event.time}` : undefined,
    };
  },
  assembleResult() {
    return undefined;
  },
};
