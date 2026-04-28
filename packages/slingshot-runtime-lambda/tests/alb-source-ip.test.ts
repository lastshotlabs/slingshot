import { describe, expect, test } from 'bun:test';
import { albTrigger } from '../src/triggers/alb';

describe('albTrigger sourceIp extraction', () => {
  test("first hop of 'x-forwarded-for' becomes meta.ip", () => {
    const meta = albTrigger.extractMeta(
      {
        headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
        httpMethod: 'GET',
        path: '/',
        requestContext: { elb: { targetGroupArn: 'arn' } },
      },
      // record arg is unused by extractMeta — pass any minimal value
      { body: {}, meta: {}, naturalKey: undefined } as never,
    );
    expect(meta.ip).toBe('1.2.3.4');
  });

  test('single IP in x-forwarded-for is preserved', () => {
    const meta = albTrigger.extractMeta(
      {
        headers: { 'x-forwarded-for': '203.0.113.42' },
      },
      { body: {}, meta: {}, naturalKey: undefined } as never,
    );
    expect(meta.ip).toBe('203.0.113.42');
  });

  test('whitespace around hops is trimmed', () => {
    const meta = albTrigger.extractMeta(
      {
        headers: { 'x-forwarded-for': '   198.51.100.7  ,   10.0.0.1  ' },
      },
      { body: {}, meta: {}, naturalKey: undefined } as never,
    );
    expect(meta.ip).toBe('198.51.100.7');
  });

  test('missing x-forwarded-for yields meta.ip=null (since ALB requestContext.identity does not exist)', () => {
    const meta = albTrigger.extractMeta(
      {
        headers: { 'user-agent': 'curl/8.0' },
      },
      { body: {}, meta: {}, naturalKey: undefined } as never,
    );
    expect(meta.ip).toBeNull();
  });

  test('empty x-forwarded-for yields meta.ip=null', () => {
    const meta = albTrigger.extractMeta({ headers: { 'x-forwarded-for': '' } }, {
      body: {},
      meta: {},
      naturalKey: undefined,
    } as never);
    expect(meta.ip).toBeNull();
  });

  test('user-agent header is propagated into meta', () => {
    const meta = albTrigger.extractMeta(
      {
        headers: {
          'x-forwarded-for': '1.2.3.4',
          'user-agent': 'Mozilla/5.0 (test)',
        },
      },
      { body: {}, meta: {}, naturalKey: undefined } as never,
    );
    expect(meta.userAgent).toBe('Mozilla/5.0 (test)');
  });

  test('header lookup is case-insensitive', () => {
    const meta = albTrigger.extractMeta(
      {
        headers: { 'X-Forwarded-For': '1.2.3.4, 5.6.7.8' },
      },
      { body: {}, meta: {}, naturalKey: undefined } as never,
    );
    expect(meta.ip).toBe('1.2.3.4');
  });
});
