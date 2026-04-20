import type { TriggerAdapter } from '@lastshotlabs/slingshot-core';
import { albTrigger } from './alb';
import { apigwTrigger } from './apigw';
import { apigwV2Trigger } from './apigw-v2';
import { dynamodbStreamsTrigger } from './dynamodb-streams';
import { eventbridgeTrigger } from './eventbridge';
import { kinesisTrigger } from './kinesis';
import { mskTrigger } from './msk';
import { s3Trigger } from './s3';
import { scheduleTrigger } from './schedule';
import { snsTrigger } from './sns';
import { sqsTrigger } from './sqs';

/**
 * Supported AWS event-source kinds understood by the Lambda runtime wrapper.
 */
export type LambdaTriggerKind =
  | 'apigw'
  | 'apigw-v2'
  | 'alb'
  | 'function-url'
  | 'sqs'
  | 'msk'
  | 'kinesis'
  | 'dynamodb-streams'
  | 's3'
  | 'sns'
  | 'eventbridge'
  | 'schedule';

const triggerRegistry: Record<LambdaTriggerKind, TriggerAdapter> = {
  apigw: apigwTrigger,
  'apigw-v2': apigwV2Trigger,
  alb: albTrigger,
  'function-url': apigwV2Trigger,
  sqs: sqsTrigger,
  msk: mskTrigger,
  kinesis: kinesisTrigger,
  'dynamodb-streams': dynamodbStreamsTrigger,
  s3: s3Trigger,
  sns: snsTrigger,
  eventbridge: eventbridgeTrigger,
  schedule: scheduleTrigger,
};

/**
 * Resolve the trigger adapter used to translate one AWS event source into a
 * Slingshot invocation record stream.
 */
export function resolveLambdaTrigger(kind: LambdaTriggerKind): TriggerAdapter {
  const adapter = triggerRegistry[kind];
  if (!adapter) {
    throw new Error(`Unsupported Lambda trigger '${kind}'`);
  }
  return adapter;
}

/** First-party Lambda trigger adapters exported for direct composition. */
export { apigwTrigger } from './apigw';
export { apigwV2Trigger } from './apigw-v2';
export { albTrigger } from './alb';
export { sqsTrigger } from './sqs';
export { mskTrigger } from './msk';
export { kinesisTrigger } from './kinesis';
export { dynamodbStreamsTrigger } from './dynamodb-streams';
export { s3Trigger } from './s3';
export { snsTrigger } from './sns';
export { eventbridgeTrigger } from './eventbridge';
export { scheduleTrigger } from './schedule';
