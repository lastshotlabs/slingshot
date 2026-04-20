import { describe, expect, spyOn, test } from 'bun:test';
import { albTrigger } from '../src/triggers/alb';
import { apigwTrigger } from '../src/triggers/apigw';
import { apigwV2Trigger } from '../src/triggers/apigw-v2';
import { dynamodbStreamsTrigger } from '../src/triggers/dynamodb-streams';
import { eventbridgeTrigger } from '../src/triggers/eventbridge';
import { kinesisTrigger } from '../src/triggers/kinesis';
import { mskTrigger } from '../src/triggers/msk';
import { resolveLambdaTrigger } from '../src/triggers/index';
import { s3Trigger } from '../src/triggers/s3';
import { scheduleTrigger } from '../src/triggers/schedule';
import { snsTrigger } from '../src/triggers/sns';
import { sqsTrigger } from '../src/triggers/sqs';

describe('lambda trigger adapters', () => {
  test('apigwTrigger decodes base64 bodies and assembles HTTP results', () => {
    const body = Buffer.from(JSON.stringify({ note: 'hello' })).toString('base64');
    const [record] = apigwTrigger.extractInputs({
      body,
      isBase64Encoded: true,
      headers: {
        'x-correlation-id': 'corr-1',
        'idempotency-key': 'idem-1',
      },
      queryStringParameters: { page: '1' },
      pathParameters: { id: '123' },
      requestContext: {
        requestId: 'req-1',
        identity: { sourceIp: '127.0.0.1', userAgent: 'agent' },
      },
      httpMethod: 'POST',
      path: '/orders/123',
    });

    expect(record.body).toEqual({ page: '1', note: 'hello', id: '123' });
    expect(apigwTrigger.extractMeta({ requestContext: { requestId: 'req-1' } }, record)).toMatchObject(
      { requestId: 'req-1' },
    );
    expect(
      apigwTrigger.assembleResult([
        {
          meta: { http: { status: 201 } },
          result: 'success',
          output: { ok: true },
        },
      ]),
    ).toEqual({
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
      isBase64Encoded: false,
    });
  });

  test('apigwV2Trigger merges query, body, and path params', () => {
    const body = Buffer.from(JSON.stringify({ action: 'approve' })).toString('base64');
    const [record] = apigwV2Trigger.extractInputs({
      body,
      isBase64Encoded: true,
      headers: { 'x-request-id': 'legacy-1' },
      queryStringParameters: { verbose: 'true' },
      pathParameters: { id: 'abc' },
      requestContext: {
        requestId: 'req-2',
        http: {
          method: 'POST',
          path: '/orders/abc',
          sourceIp: '10.0.0.1',
          userAgent: 'agent',
        },
      },
    });

    expect(record.body).toEqual({ verbose: 'true', action: 'approve', id: 'abc' });
    expect(apigwV2Trigger.extractMeta({ requestContext: { requestId: 'req-2' } }, record)).toMatchObject(
      { requestId: 'req-2' },
    );
  });

  test('albTrigger decodes base64 bodies and preserves successful status descriptions', () => {
    const body = Buffer.from(JSON.stringify({ ok: true })).toString('base64');
    const [record] = albTrigger.extractInputs({
      body,
      isBase64Encoded: true,
      headers: { 'x-request-id': 'req-alb' },
      queryStringParameters: { page: '1' },
      path: '/health',
      httpMethod: 'POST',
      requestContext: { elb: { targetGroupArn: 'arn:aws:elb:target' } },
    });

    expect(record.body).toEqual({ page: '1', ok: true });
    expect(
      albTrigger.assembleResult([
        {
          meta: { http: { status: 201 } },
          result: 'success',
          output: { created: true },
        },
      ]),
    ).toEqual({
      statusCode: 201,
      statusDescription: '201 OK',
      isBase64Encoded: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ created: true }),
    });
  });

  test('sqsTrigger extracts natural keys, correlation ids, and batch failures', () => {
    const records = sqsTrigger.extractInputs({
      Records: [
        {
          messageId: 'm-1',
          body: JSON.stringify({ ok: true }),
          messageAttributes: {
            correlationId: { stringValue: 'corr-1' },
          },
        },
      ],
    });

    expect(records[0].naturalKey).toBe('sqs:m-1');
    expect(sqsTrigger.extractMeta({ Records: [] }, records[0])).toMatchObject({
      requestId: 'm-1',
      correlationId: 'corr-1',
      idempotencyKey: 'sqs:m-1',
    });
    expect(
      sqsTrigger.assembleResult([
        { meta: { messageId: 'm-1' }, result: 'error', error: new Error('boom') },
      ]),
    ).toEqual({
      batchItemFailures: [{ itemIdentifier: 'm-1' }],
    });
  });

  test('mskTrigger flattens topic-partition records and reads correlation headers', () => {
    const records = mskTrigger.extractInputs({
      records: {
        'topic-0': [
          {
            topic: 'orders',
            partition: 0,
            offset: 12,
            value: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
            headers: [{ correlationId: ['corr-12'] }],
          },
        ],
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0].body).toEqual({ ok: true });
    expect(mskTrigger.extractMeta({ records: {} }, records[0])).toMatchObject({
      requestId: 'orders:0:12',
      correlationId: 'corr-12',
      idempotencyKey: 'msk:orders:0:12',
    });
  });

  test('kinesisTrigger decodes base64 payloads', () => {
    const [record] = kinesisTrigger.extractInputs({
      Records: [
        {
          eventID: 'evt-1',
          kinesis: {
            sequenceNumber: 'seq-1',
            data: Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64'),
            partitionKey: 'pk-1',
          },
        },
      ],
    });

    expect(record.body).toEqual({ hello: 'world' });
    expect(kinesisTrigger.extractMeta({ Records: [] }, record)).toMatchObject({
      requestId: 'seq-1',
      correlationId: 'seq-1',
      idempotencyKey: 'kinesis:seq-1',
    });
  });

  test('dynamodbStreamsTrigger exposes natural ids', () => {
    const [record] = dynamodbStreamsTrigger.extractInputs({
      Records: [{ eventID: 'dyn-1', eventName: 'INSERT', dynamodb: { NewImage: {} } }],
    });

    expect(record.naturalKey).toBe('dynamodb:dyn-1');
    expect(dynamodbStreamsTrigger.extractMeta({ Records: [] }, record)).toMatchObject({
      requestId: 'dyn-1',
      correlationId: 'dyn-1',
    });
  });

  test('s3Trigger derives correlation ids from bucket, key, and sequencer', () => {
    const [record] = s3Trigger.extractInputs({
      Records: [
        {
          s3: {
            bucket: { name: 'uploads' },
            object: { key: 'image.png', sequencer: '001' },
          },
        },
      ],
    });

    expect(record.naturalKey).toBe('s3:uploads:image.png:001');
    expect(s3Trigger.extractMeta({ Records: [] }, record)).toMatchObject({
      requestId: '001',
      correlationId: 'uploads:image.png:001',
    });
  });

  test('snsTrigger parses JSON payloads and message attributes', () => {
    const [record] = snsTrigger.extractInputs({
      Records: [
        {
          Sns: {
            MessageId: 'sns-1',
            Message: JSON.stringify({ topic: 'orders' }),
            MessageAttributes: {
              correlationId: { Value: 'corr-sns-1' },
            },
          },
        },
      ],
    });

    expect(record.body).toEqual({ topic: 'orders' });
    expect(snsTrigger.extractMeta({ Records: [] }, record)).toMatchObject({
      requestId: 'sns-1',
      correlationId: 'corr-sns-1',
      idempotencyKey: 'sns:sns-1',
    });
  });

  test('eventbridgeTrigger and scheduleTrigger derive correlation ids correctly', () => {
    const [eventRecord] = eventbridgeTrigger.extractInputs({
      id: 'eb-1',
      detail: { correlationId: 'corr-eb-1', ok: true },
      detailType: 'OrderCreated',
      source: 'orders',
    });
    expect(eventbridgeTrigger.extractMeta({ id: 'eb-1', detail: { correlationId: 'corr-eb-1' } }, eventRecord)).toMatchObject({
      requestId: 'eb-1',
      correlationId: 'corr-eb-1',
      idempotencyKey: 'eb:eb-1',
    });

    const randomUuidSpy = spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-0000-0000-000000000000',
    );
    const [scheduleRecord] = scheduleTrigger.extractInputs({
      detail: { ok: true },
      resources: [],
    });
    expect(scheduleTrigger.extractMeta({}, scheduleRecord)).toMatchObject({
      requestId: undefined,
      correlationId: '00000000-0000-0000-0000-000000000000',
      idempotencyKey: undefined,
    });
    randomUuidSpy.mockRestore();
  });

  test('resolveLambdaTrigger throws for unsupported trigger kinds', () => {
    expect(() => resolveLambdaTrigger('unknown-trigger' as never)).toThrow(
      "Unsupported Lambda trigger 'unknown-trigger'",
    );
  });
});
