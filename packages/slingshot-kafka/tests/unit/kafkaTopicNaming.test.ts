import { describe, expect, test } from 'bun:test';
import { toGroupId, toTopicName } from '../../src/kafkaTopicNaming';

describe('toTopicName', () => {
  test('replaces colons with dots and prepends prefix', () => {
    expect(toTopicName('myapp.events', 'auth:login')).toBe('myapp.events.auth.login');
  });

  test('replaces multiple colons', () => {
    expect(toTopicName('app', 'entity:post:created')).toBe('app.entity.post.created');
  });

  test('event with no colons appended with dot separator', () => {
    expect(toTopicName('prefix', 'healthcheck')).toBe('prefix.healthcheck');
  });

  test('empty prefix produces a leading dot', () => {
    expect(toTopicName('', 'auth:login')).toBe('.auth.login');
  });
});

describe('toGroupId', () => {
  test('combines prefix, topic, and subscription name with dots', () => {
    expect(toGroupId('app', 'app.auth.login', 'audit-worker')).toBe(
      'app.app.auth.login.audit-worker',
    );
  });

  test('works with simple single-segment inputs', () => {
    expect(toGroupId('ns', 'topic', 'worker')).toBe('ns.topic.worker');
  });
});
