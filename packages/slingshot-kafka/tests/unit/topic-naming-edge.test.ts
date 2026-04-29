/**
 * Edge-case tests for toTopicName() and toGroupId().
 *
 * These functions are simple string transformers, but there are several
 * edge cases worth covering explicitly: empty strings, special characters,
 * unicode, and boundary inputs that might behave unexpectedly.
 */
import { describe, expect, test } from 'bun:test';
import { toGroupId, toTopicName } from '../../src/kafkaTopicNaming';

// ---------------------------------------------------------------------------
// toTopicName — edge cases
// ---------------------------------------------------------------------------

describe('toTopicName edge cases', () => {
  test('empty event string produces just the prefix and a dot', () => {
    expect(toTopicName('app', '')).toBe('app.');
  });

  test('both prefix and event empty produces just a dot', () => {
    expect(toTopicName('', '')).toBe('.');
  });

  test('event with only colons produces prefix with dots', () => {
    // ':::' has 3 colons → replaced with 3 dots; plus prefix dot = 4 total
    expect(toTopicName('p', ':::')).toBe('p....');
  });

  test('event starting with colon produces leading dot', () => {
    expect(toTopicName('p', ':event')).toBe('p..event');
  });

  test('event ending with colon produces trailing dot', () => {
    expect(toTopicName('p', 'event:')).toBe('p.event.');
  });

  test('event with consecutive colons produces consecutive dots', () => {
    expect(toTopicName('p', 'a::b')).toBe('p.a..b');
  });

  test('event with unicode characters is preserved', () => {
    expect(toTopicName('p', 'event:登录')).toBe('p.event.登录');
  });

  test('event with emoji is preserved', () => {
    expect(toTopicName('p', 'user:signed:up')).toBe('p.user.signed.up');
  });

  test('event with spaces is preserved', () => {
    expect(toTopicName('p', 'my event')).toBe('p.my event');
  });

  test('event with numbers is preserved', () => {
    expect(toTopicName('p', 'v2:event')).toBe('p.v2.event');
  });

  test('prefix with dots does not change event segment', () => {
    expect(toTopicName('my.app', 'auth:login')).toBe('my.app.auth.login');
  });

  test('single-character prefix and event', () => {
    expect(toTopicName('x', 'y')).toBe('x.y');
  });

  test('very long event string does not truncate', () => {
    const longEvent = 'a:'.repeat(100) + 'b';
    const result = toTopicName('p', longEvent);
    expect(result.length).toBeGreaterThan(200);
    expect(result).toMatch(/^p\./);
    expect(result.endsWith('.b')).toBe(true);
  });

  test('event with mixed separators (colons and dots) replaces colons only', () => {
    // Colons are replaced with dots. Existing dots stay dots.
    expect(toTopicName('p', 'entity:post.created')).toBe('p.entity.post.created');
  });

  test('event with underscore is preserved', () => {
    expect(toTopicName('p', 'entity:post_created')).toBe('p.entity.post_created');
  });

  test('event with hyphens is preserved', () => {
    expect(toTopicName('p', 'entity:post-created')).toBe('p.entity.post-created');
  });
});

// ---------------------------------------------------------------------------
// toGroupId — edge cases
// ---------------------------------------------------------------------------

describe('toGroupId edge cases', () => {
  test('empty name produces prefix and topic with trailing dot', () => {
    expect(toGroupId('app', 'app.auth.login', '')).toBe('app.app.auth.login.');
  });

  test('empty prefix produces leading dot', () => {
    expect(toGroupId('', 'app.auth.login', 'worker')).toBe('.app.auth.login.worker');
  });

  test('name with dots is preserved', () => {
    expect(toGroupId('ns', 'topic', 'my.worker.v1')).toBe('ns.topic.my.worker.v1');
  });

  test('name with unicode is preserved', () => {
    expect(toGroupId('ns', 'topic', 'arbeiter:1')).toBe('ns.topic.arbeiter:1');
  });

  test('all three parameters empty produces two dots', () => {
    expect(toGroupId('', '', '')).toBe('..');
  });

  test('long name is not truncated', () => {
    const longName = 'x'.repeat(200);
    const result = toGroupId('p', 't', longName);
    expect(result).toBe(`p.t.${longName}`);
    expect(result.length).toBeGreaterThan(200);
  });

  test('topic with colons is passed through unchanged (colons not replaced in topic arg)', () => {
    // toGroupId does NOT replace colons — it expects the topic to already be
    // sanitized by toTopicName first.
    expect(toGroupId('p', 'app:events', 'worker')).toBe('p.app:events.worker');
  });

  test('prefix and name with special characters are concatenated literally', () => {
    expect(toGroupId('my-app', 'topic.v1', 'consumer-a')).toBe('my-app.topic.v1.consumer-a');
  });
});
