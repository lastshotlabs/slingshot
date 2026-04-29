import { describe, expect, test } from 'bun:test';
import {
  ApnsDeliveryError,
  FcmTokenError,
  PushRouterError,
  PushTopicFanoutError,
  WebPushDeliveryError,
} from '../../src/errors';

describe('push error classes', () => {
  test('ApnsDeliveryError has the correct name and code', () => {
    const err = new ApnsDeliveryError('apns delivery failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApnsDeliveryError');
    expect(err.code).toBe('APNS_DELIVERY_ERROR');
    expect(err.message).toBe('apns delivery failed');
  });

  test('ApnsDeliveryError accepts ErrorOptions', () => {
    const cause = new Error('underlying network error');
    const err = new ApnsDeliveryError('apns delivery failed', { cause });
    expect(err.cause).toBe(cause);
  });

  test('WebPushDeliveryError has the correct name and code', () => {
    const err = new WebPushDeliveryError('web push delivery failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WebPushDeliveryError');
    expect(err.code).toBe('WEB_PUSH_DELIVERY_ERROR');
    expect(err.message).toBe('web push delivery failed');
  });

  test('WebPushDeliveryError accepts ErrorOptions', () => {
    const cause = new Error('underlying error');
    const err = new WebPushDeliveryError('web push delivery failed', { cause });
    expect(err.cause).toBe(cause);
  });

  test('PushRouterError has the correct name and code', () => {
    const err = new PushRouterError('router circuit breaker open');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PushRouterError');
    expect(err.code).toBe('PUSH_ROUTER_ERROR');
    expect(err.message).toBe('router circuit breaker open');
  });

  test('PushRouterError accepts ErrorOptions', () => {
    const cause = new Error('underlying cause');
    const err = new PushRouterError('router error', { cause });
    expect(err.cause).toBe(cause);
  });

  test('PushTopicFanoutError has the correct name and code', () => {
    const err = new PushTopicFanoutError('topic fanout failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PushTopicFanoutError');
    expect(err.code).toBe('PUSH_TOPIC_FANOUT_ERROR');
    expect(err.message).toBe('topic fanout failed');
  });

  test('PushTopicFanoutError accepts ErrorOptions', () => {
    const cause = new Error('membership enumeration failed');
    const err = new PushTopicFanoutError('topic fanout failed', { cause });
    expect(err.cause).toBe(cause);
  });

  test('FcmTokenError is still exported from errors', () => {
    const err = new FcmTokenError('token fetch failed', 401);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FcmTokenError');
    expect((err as unknown as Record<string, unknown>).code).toBeUndefined();
    expect(err.statusCode).toBe(401);
  });

  test('error classes can be differentiated with instanceof', () => {
    const apns = new ApnsDeliveryError('test');
    const web = new WebPushDeliveryError('test');
    const router = new PushRouterError('test');
    const fanout = new PushTopicFanoutError('test');

    expect(apns).toBeInstanceOf(ApnsDeliveryError);
    expect(web).toBeInstanceOf(WebPushDeliveryError);
    expect(router).toBeInstanceOf(PushRouterError);
    expect(fanout).toBeInstanceOf(PushTopicFanoutError);

    expect(apns).not.toBeInstanceOf(WebPushDeliveryError);
    expect(router).not.toBeInstanceOf(PushTopicFanoutError);
    expect(fanout).not.toBeInstanceOf(PushRouterError);
  });
});
