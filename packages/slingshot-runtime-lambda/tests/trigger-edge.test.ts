/**
 * Edge-case tests for Lambda trigger adapters beyond what triggers.test.ts
 * covers: S3 event parsing, DynamoDB stream record parsing, SNS message
 * parsing, and EventBridge event detail extraction with edge inputs.
 */
import { describe, expect, test } from 'bun:test';
import { dynamodbStreamsTrigger } from '../src/triggers/dynamodb-streams';
import { eventbridgeTrigger } from '../src/triggers/eventbridge';
import { s3Trigger } from '../src/triggers/s3';
import { snsTrigger } from '../src/triggers/sns';

describe('S3 trigger edge cases', () => {
  test('extracts naturalKey from bucket/object/sequencer', () => {
    const [record] = s3Trigger.extractInputs({
      Records: [
        {
          s3: {
            bucket: { name: 'my-bucket' },
            object: { key: 'path/to/file.png', sequencer: '007' },
          },
        },
      ],
    });
    expect(record.naturalKey).toBe('s3:my-bucket:path/to/file.png:007');
    expect(record.meta).toMatchObject({
      bucket: 'my-bucket',
      key: 'path/to/file.png',
      sequencer: '007',
    });
  });

  test('uses "none" suffix when sequencer is missing', () => {
    const [record] = s3Trigger.extractInputs({
      Records: [
        {
          s3: {
            bucket: { name: 'uploads' },
            object: { key: 'image.jpg' },
          },
        },
      ],
    });
    expect(record.naturalKey).toBe('s3:uploads:image.jpg:none');
  });

  test('extractMeta handles missing sequencer in meta', () => {
    const [record] = s3Trigger.extractInputs({
      Records: [
        {
          s3: {
            bucket: { name: 'b' },
            object: { key: 'k' },
          },
        },
      ],
    });
    const meta = s3Trigger.extractMeta({ Records: [] } as never, record);
    expect(meta.requestId).toBe('k');
    expect(meta.correlationId).toContain('b:k:none');
    expect(meta.idempotencyKey).toBe('s3:b:k:none');
  });

  test('assembleResult returns undefined for S3', () => {
    const result = s3Trigger.assembleResult([]);
    expect(result).toBeUndefined();
  });

  test('empty Records array produces no records', () => {
    const records = s3Trigger.extractInputs({ Records: [] });
    expect(records).toEqual([]);
  });
});

describe('DynamoDB Streams trigger edge cases', () => {
  test('extracts naturalKey from eventID', () => {
    const [record] = dynamodbStreamsTrigger.extractInputs({
      Records: [{ eventID: 'dyn-123', eventName: 'INSERT', dynamodb: { NewImage: {} } }],
    });
    expect(record.naturalKey).toBe('dynamodb:dyn-123');
    expect(record.body).toEqual({
      eventID: 'dyn-123',
      eventName: 'INSERT',
      dynamodb: { NewImage: {} },
    });
  });

  test('extractMeta uses eventID as requestId and correlationId', () => {
    const [record] = dynamodbStreamsTrigger.extractInputs({
      Records: [{ eventID: 'dyn-456', eventName: 'MODIFY' }],
    });
    const meta = dynamodbStreamsTrigger.extractMeta({ Records: [] }, record);
    expect(meta.requestId).toBe('dyn-456');
    expect(meta.correlationId).toBe('dyn-456');
    expect(meta.idempotencyKey).toBe('dynamodb:dyn-456');
  });

  test('handles empty dynamodb object', () => {
    const [record] = dynamodbStreamsTrigger.extractInputs({
      Records: [{ eventID: 'dyn-789', eventName: 'REMOVE', dynamodb: {} }],
    });
    expect(record.naturalKey).toBe('dynamodb:dyn-789');
  });

  test('handles missing eventName', () => {
    const records = dynamodbStreamsTrigger.extractInputs({
      Records: [{ eventID: 'no-name', dynamodb: { Keys: { id: '1' } } }],
    });
    expect(records).toHaveLength(1);
    expect(records[0].naturalKey).toBe('dynamodb:no-name');
  });

  test('empty Records array produces no records', () => {
    const records = dynamodbStreamsTrigger.extractInputs({ Records: [] });
    expect(records).toEqual([]);
  });
});

describe('SNS trigger edge cases', () => {
  test('extracts naturalKey and body from SNS message', () => {
    const [record] = snsTrigger.extractInputs({
      Records: [
        {
          Sns: {
            MessageId: 'sns-msg-1',
            Message: JSON.stringify({ topic: 'orders', action: 'created' }),
            MessageAttributes: {
              correlationId: { Value: 'corr-sns-99' },
            },
          },
        },
      ],
    });
    expect(record.naturalKey).toBe('sns:sns-msg-1');
    expect(record.body).toEqual({ topic: 'orders', action: 'created' });
  });

  test('extractMeta reads correlationId from MessageAttributes', () => {
    const [record] = snsTrigger.extractInputs({
      Records: [
        {
          Sns: {
            MessageId: 'sns-2',
            Message: '{}',
            MessageAttributes: {
              correlationId: { Value: 'my-correlation-id' },
            },
          },
        },
      ],
    });
    const meta = snsTrigger.extractMeta({ Records: [] }, record);
    expect(meta.correlationId).toBe('my-correlation-id');
    expect(meta.idempotencyKey).toBe('sns:sns-2');
  });

  test('falls back to messageId when correlationId is missing from attributes', () => {
    const [record] = snsTrigger.extractInputs({
      Records: [
        {
          Sns: {
            MessageId: 'sns-3',
            Message: '{}',
            MessageAttributes: {},
          },
        },
      ],
    });
    const meta = snsTrigger.extractMeta({ Records: [] }, record);
    // Should fall back to messageId
    expect(meta.correlationId).toBe('sns-3');
  });

  test('handles non-JSON message body gracefully', () => {
    const [record] = snsTrigger.extractInputs({
      Records: [
        {
          Sns: {
            MessageId: 'sns-4',
            Message: 'plain text notification',
            MessageAttributes: {},
          },
        },
      ],
    });
    expect(record.body).toBe('plain text notification');
  });

  test('handles missing MessageAttributes', () => {
    const [record] = snsTrigger.extractInputs({
      Records: [
        {
          Sns: {
            MessageId: 'sns-5',
            Message: JSON.stringify({ ok: true }),
          },
        },
      ],
    });
    expect(record.naturalKey).toBe('sns:sns-5');
    const meta = snsTrigger.extractMeta({ Records: [] }, record);
    expect(meta.correlationId).toBe('sns-5');
  });

  test('empty Records array produces no records', () => {
    const records = snsTrigger.extractInputs({ Records: [] });
    expect(records).toEqual([]);
  });
});

describe('EventBridge trigger edge cases', () => {
  test('extracts body from detail field', () => {
    const [record] = eventbridgeTrigger.extractInputs({
      id: 'eb-1',
      detail: { orderId: '123', amount: 99.95 },
      detailType: 'OrderCreated',
      source: 'orders',
    });
    expect(record.body).toEqual({ orderId: '123', amount: 99.95 });
    expect(record.naturalKey).toBe('eb:eb-1');
  });

  test('falls back to whole event when detail is missing', () => {
    const event = { id: 'eb-2', detailType: 'Test', source: 'test' };
    const [record] = eventbridgeTrigger.extractInputs(event);
    expect(record.body).toEqual(event);
  });

  test('extractMeta reads correlationId from detail', () => {
    const [record] = eventbridgeTrigger.extractInputs({
      id: 'eb-3',
      detail: { correlationId: 'corr-eb-3', ok: true },
      detailType: 'Test',
    });
    const meta = eventbridgeTrigger.extractMeta(
      { id: 'eb-3', detail: { correlationId: 'corr-eb-3', ok: true } },
      record,
    );
    expect(meta.correlationId).toBe('corr-eb-3');
    expect(meta.requestId).toBe('eb-3');
    expect(meta.idempotencyKey).toBe('eb:eb-3');
  });

  test('falls back to event id for correlationId when detail has none', () => {
    const [record] = eventbridgeTrigger.extractInputs({
      id: 'eb-4',
      detail: { ok: true },
    });
    const meta = eventbridgeTrigger.extractMeta({ id: 'eb-4', detail: { ok: true } }, record);
    expect(meta.correlationId).toBe('eb-4');
  });

  test('naturalKey is undefined when event has no id', () => {
    const [record] = eventbridgeTrigger.extractInputs({
      detail: { ok: true },
      source: 'test',
    });
    expect(record.naturalKey).toBeUndefined();
  });

  test('returns single record array always', () => {
    const records = eventbridgeTrigger.extractInputs({
      id: 'eb-5',
      detail: {},
    });
    expect(records).toHaveLength(1);
  });

  test('extractMeta handles missing detail gracefully', () => {
    const [record] = eventbridgeTrigger.extractInputs({
      id: 'eb-6',
    } as never);
    const meta = eventbridgeTrigger.extractMeta({ id: 'eb-6' } as never, record);
    expect(meta.correlationId).toBe('eb-6');
  });
});
