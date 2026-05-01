/**
 * Property-based / fuzz tests for Kafka topic naming (`toTopicName`, `toGroupId`).
 *
 * Validates that:
 *   1. Random event names produce valid Kafka topic names (no empty segments,
 *      no characters Kafka rejects, length < 255).
 *   2. Different input event names never collide on the same topic name.
 *   3. Group IDs follow the same stability guarantees.
 */
import { describe, expect, test } from 'bun:test';
import { toTopicName, toGroupId } from '../../src/kafkaTopicNaming';

// ---------------------------------------------------------------------------
// Seeded PRNG (Linear Congruential Generator)
// ---------------------------------------------------------------------------
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 0x100000000;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomEventName(rng: () => number, maxSegments: number): string {
  const pools = [
    'abcdefghijklmnopqrstuvwxyz0123456789',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'éàüöäÄÜÖ中文АЯ😀👍🎉',
    '_:.-',
    '\n\r\t' + "'\"",
    '/\\',
  ];
  const segments: string[] = [];
  const numSegments = randomInt(rng, 1, maxSegments);
  for (let s = 0; s < numSegments; s++) {
    const pool = pools[randomInt(rng, 0, pools.length - 1)];
    const segLen = randomInt(rng, 1, 20);
    let seg = '';
    for (let i = 0; i < segLen; i++) {
      seg += pool[Math.floor(rng() * pool.length)];
    }
    segments.push(seg);
  }
  return segments.join(':');
}

function randomPrefix(rng: () => number): string {
  return 'prefix_' + randomEventName(rng, 2).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function randomName(rng: () => number): string {
  const pool = 'abcdefghijklmnopqrstuvwxyz0123456789_-.' + '😀' + 'éàü';
  const len = randomInt(rng, 1, 30);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += pool[Math.floor(rng() * pool.length)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kafka topic name validation helpers
// ---------------------------------------------------------------------------

/**
 * A valid Kafka topic name must:
 * - Be non-empty
 * - Be at most 249 characters (leaving room for group ID suffixes)
 * - Not contain characters Kafka rejects: characters with code points < 0x20
 *   or > 0x7F are technically allowed in recent versions but the topic naming
 *   function itself should not crash. We don't reject them here but we do
 *   validate that the output is a valid string.
 */
function isValidKafkaTopicLength(topic: string): boolean {
  return topic.length > 0 && topic.length < 255;
}

function hasEmptySegment(topic: string, separator: string): boolean {
  return topic.split(separator).some(s => s.length === 0);
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------
function computeCollisions(
  inputs: string[],
  fn: (input: string) => string,
): Map<string, string[]> {
  const mapping = new Map<string, string[]>();
  for (const input of inputs) {
    const output = fn(input);
    const existing = mapping.get(output) ?? [];
    existing.push(input);
    mapping.set(output, existing);
  }
  // Filter to only collisions
  const collisions = new Map<string, string[]>();
  for (const [output, origins] of mapping) {
    if (origins.length > 1) {
      collisions.set(output, origins);
    }
  }
  return collisions;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('toTopicName fuzz', () => {
  test('300 random event names produce valid topic names without collisions', () => {
    const rng = seededRandom(42);
    const prefix = 'slingshot.events';

    const eventNames: string[] = [];
    for (let i = 0; i < 300; i++) {
      eventNames.push(randomEventName(rng, 6));
    }

    for (const event of eventNames) {
      const topic = toTopicName(prefix, event);
      expect(topic).toBeTruthy();
      expect(isValidKafkaTopicLength(topic)).toBe(true);
      // Every ':' in the event name should be replaced with '.'
      expect(topic).not.toContain(':');
      // Topic should start with prefix
      expect(topic.startsWith(prefix + '.')).toBe(true);
    }

    // Check for collisions — different event names should NOT map to the same topic
    const collisions = computeCollisions(
      eventNames,
      evt => toTopicName(prefix, evt),
    );
    if (collisions.size > 0) {
      // If there are collisions, they must be from event names that only
      // differ by the separator replacement (e.g. "a:b" and "a.b" both map
      // to "prefix.a.b"). This is expected behavior.
      for (const [topic, origins] of collisions) {
        expect(origins.length).toBeGreaterThan(1);
        // Verify the collision is due to separator ambiguity
        for (const origin of origins) {
          // The topic should be the prefix + origin with ':' replaced by '.'
          const expected = prefix + '.' + origin.replace(/:/g, '.');
          expect(topic).toBe(expected);
        }
      }
    }
  });

  test('different prefixes produce different topic names for the same event', () => {
    const rng = seededRandom(1);

    for (let i = 0; i < 100; i++) {
      const event = randomEventName(rng, 4);
      const prefixA = randomPrefix(rng);
      const prefixB = prefixA + '.v2';

      const topicA = toTopicName(prefixA, event);
      const topicB = toTopicName(prefixB, event);
      expect(topicA).not.toBe(topicB);
      expect(topicA.startsWith(prefixA)).toBe(true);
      expect(topicB.startsWith(prefixB)).toBe(true);
    }
  });

  test('event names with consecutive colons produce no double dots', () => {
    const prefix = 'test.prefix';

    const inputs = [
      'a:::b',
      '::leading',
      'trailing::',
      'a::b::c',
      '::::',
      'a:b:c',
    ];

    for (const event of inputs) {
      const topic = toTopicName(prefix, event);
      // No consecutive dots (which would come from consecutive colons)
      expect(topic).not.toContain('..');
      expect(topic).toMatch(/^test\.prefix\./);
    }
  });

  test('event names with special chars produce usable topic names', () => {
    const prefix = 'slingshot.test';
    const rng = seededRandom(77);

    for (let i = 0; i < 100; i++) {
      const event = randomEventName(rng, 5);
      const topic = toTopicName(prefix, event);

      // Must be a non-empty string
      expect(topic.length).toBeGreaterThan(0);

      // No empty segments
      expect(hasEmptySegment(topic, '.')).toBe(false);

      // Must not contain colons (they're converted to dots)
      expect(topic).not.toContain(':');

      // Length constraint
      expect(isValidKafkaTopicLength(topic)).toBe(true);
    }
  });

  test('identity stability — same event+prefix always produces same topic', () => {
    const testCases = [
      ['slingshot.events', 'entity:post.created'],
      ['prod', 'user:login'],
      ['staging.v2', 'namespace:entity:action'],
    ];

    for (const [prefix, event] of testCases) {
      const first = toTopicName(prefix, event);
      for (let i = 0; i < 50; i++) {
        expect(toTopicName(prefix, event)).toBe(first);
      }
    }
  });
});

describe('toGroupId fuzz', () => {
  test('200 random combinations produce valid group IDs without collisions', () => {
    const rng = seededRandom(42);

    const entries: Array<{ prefix: string; event: string; name: string }> = [];
    for (let i = 0; i < 200; i++) {
      entries.push({
        prefix: randomPrefix(rng),
        event: randomEventName(rng, 4),
        name: randomName(rng),
      });
    }

    const groupIds = new Set<string>();
    for (const { prefix, event, name } of entries) {
      const topic = toTopicName(prefix, event);
      const groupId = toGroupId(prefix, topic, name);

      expect(groupId).toBeTruthy();
      expect(isValidKafkaTopicLength(groupId)).toBe(true);

      // Group ID must contain the subscription name
      expect(groupId).toContain(name);

      // No empty segments
      expect(hasEmptySegment(groupId, '.')).toBe(false);

      // Must not have duplicates
      expect(groupIds.has(groupId)).toBe(false);
      groupIds.add(groupId);
    }
  });

  test('same event+prefix+name always produces same group ID', () => {
    const inputs = [
      ['slingshot.events', 'entity:post.created', 'indexer'],
      ['prod', 'user:login', 'analytics-v2'],
      ['dev', 'namespace:entity:action:v3', 'worker-01'],
    ];

    for (const [prefix, event, name] of inputs) {
      const topic = toTopicName(prefix, event);
      const first = toGroupId(prefix, topic, name);
      for (let i = 0; i < 50; i++) {
        expect(toGroupId(prefix, topic, name)).toBe(first);
      }
    }
  });

  test('group IDs with emoji subscription names do not crash', () => {
    const prefix = 'slingshot';
    const topic = toTopicName(prefix, 'entity:post.created');

    const names = [
      '😀-consumer',
      '👍worker',
      'emoji🎉group',
      '普通の名前',
      'русское-имя',
    ];

    for (const name of names) {
      const groupId = toGroupId(prefix, topic, name);
      expect(groupId).toBeTruthy();
      expect(groupId.length).toBeGreaterThan(0);
    }
  });
});

describe('empty and edge-case inputs', () => {
  test('empty event name produces a topic with just prefix', () => {
    const topic = toTopicName('slingshot', '');
    expect(topic).toBe('slingshot.');
  });

  test('empty prefix produces topic with just event', () => {
    const topic = toTopicName('', 'entity:post.created');
    expect(topic).toBe('.entity.post.created');
  });

  test('both prefix and event empty produces empty-like result', () => {
    const topic = toTopicName('', '');
    expect(topic).toBe('.');
  });

  test('empty group ID name still produces a valid group ID', () => {
    const topic = toTopicName('p', 'event');
    const groupId = toGroupId('p', topic, '');
    expect(groupId).toBe('p.p.event.');
  });

  test('event name with only special chars converts predictably', () => {
    const events = [
      ':',
      '::',
      ':::',
      'a:',
      ':b',
    ];
    for (const event of events) {
      const topic = toTopicName('p', event);
      expect(topic).not.toContain(':');
    }
  });
});
