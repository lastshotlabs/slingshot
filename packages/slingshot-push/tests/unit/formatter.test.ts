/**
 * Unit tests for compilePushFormatters.
 *
 * Tests ${path} interpolation, fallback behavior, runtime registration,
 * and dataTemplate expansion.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { NotificationRecord } from '@lastshotlabs/slingshot-notifications';
import { compilePushFormatters } from '../../src/formatter';
import type { PushFormatterTemplate } from '../../src/types/config';

function makeNotification(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'notif-1',
    userId: 'user-1',
    tenantId: '',
    source: 'community',
    type: 'community:reply',
    actorId: 'actor-1',
    targetType: 'community:reply',
    targetId: 'reply-1',
    dedupKey: null,
    data: { threadId: 'thread-1', threadTitle: 'Hello world' },
    read: false,
    readAt: null,
    deliverAt: null,
    dispatched: false,
    dispatchedAt: null,
    priority: 'normal',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as NotificationRecord;
}

describe('compilePushFormatters — basic interpolation', () => {
  test('substitutes top-level notification field', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: 'Reply from ${notification.actorId}',
      },
    });
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('Reply from actor-1');
  });

  test('substitutes nested path through data', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: 'Thread: ${notification.data.threadTitle}',
        bodyTemplate: 'threadId=${notification.data.threadId}',
      },
    });
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('Thread: Hello world');
    expect(msg.body).toBe('threadId=thread-1');
  });

  test('missing key resolves to empty string', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: 'Value: ${notification.data.nonexistent}',
      },
    });
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('Value: ');
  });

  test('nested path through intermediate null is empty string', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: 'X: ${notification.data.deep.nested}',
      },
    });
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('X: ');
  });

  test('multiple substitutions in one template', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: '${notification.source}: ${notification.type}',
      },
    });
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('community: community:reply');
  });
});

describe('compilePushFormatters — unknown event type', () => {
  test('resolve returns null for unregistered type', () => {
    const table = compilePushFormatters({});
    expect(table.resolve('community:unknown')).toBeNull();
  });

  test('format falls back to "source: type" title when type is unknown', () => {
    const table = compilePushFormatters({});
    const msg = table.format(makeNotification({ type: 'community:unknown' }), {});
    expect(msg.title).toBe('community: community:unknown');
  });

  test('fallback copies notification.data into message.data', () => {
    const table = compilePushFormatters({});
    const msg = table.format(makeNotification(), {});
    expect(msg.data).toEqual({ threadId: 'thread-1', threadTitle: 'Hello world' });
  });
});

describe('compilePushFormatters — compiled formatter output shape', () => {
  const template: PushFormatterTemplate = {
    titleTemplate: 'Reply: ${notification.data.threadTitle}',
    bodyTemplate: 'From ${notification.actorId}',
    iconUrl: 'https://example.com/icon.png',
    dataTemplate: {
      threadId: '${notification.data.threadId}',
      source: '${notification.source}',
    },
  };

  test('returns title, body, icon, and expanded dataTemplate', () => {
    const table = compilePushFormatters({ 'community:reply': template });
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('Reply: Hello world');
    expect(msg.body).toBe('From actor-1');
    expect(msg.icon).toBe('https://example.com/icon.png');
    expect(msg.data).toEqual({ threadId: 'thread-1', source: 'community' });
  });

  test('uses default icon when template has none', () => {
    const table = compilePushFormatters({
      'community:reply': { titleTemplate: 'Hi' },
    });
    const msg = table.format(makeNotification(), { icon: 'https://default/icon.png' });
    expect(msg.icon).toBe('https://default/icon.png');
  });

  test('uses template iconUrl over defaults.icon', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: 'Hi',
        iconUrl: 'https://template/icon.png',
      },
    });
    const msg = table.format(makeNotification(), { icon: 'https://default/icon.png' });
    expect(msg.icon).toBe('https://template/icon.png');
  });

  test('badgeField resolves a path from the notification', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: 'Hi',
        badgeField: 'notification.data.threadId',
      },
    });
    const msg = table.format(makeNotification(), {});
    expect(msg.badge).toBe('thread-1');
  });

  test('badgeField missing path falls back to defaults.badge', () => {
    const table = compilePushFormatters({
      'community:reply': {
        titleTemplate: 'Hi',
        badgeField: 'notification.data.missing',
      },
    });
    const msg = table.format(makeNotification(), { badge: 'default-badge' });
    // badgeField returns undefined for missing path — falls back to defaults
    expect(msg.badge).toBe('default-badge');
  });
});

describe('compilePushFormatters — runtime register() override', () => {
  test('register replaces template-based formatter', () => {
    const table = compilePushFormatters({
      'community:reply': { titleTemplate: 'Original' },
    });
    table.register('community:reply', () => ({ title: 'Overridden' }));
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('Overridden');
  });

  test('register adds formatter for previously unknown type', () => {
    const table = compilePushFormatters({});
    table.register('community:reply', n => ({ title: `custom: ${n.type}` }));
    const msg = table.format(makeNotification(), {});
    expect(msg.title).toBe('custom: community:reply');
  });

  test('resolve returns runtime formatter after registration', () => {
    const table = compilePushFormatters({});
    const fn = () => ({ title: 'hi' });
    table.register('community:reply', fn);
    expect(table.resolve('community:reply')).toBe(fn);
  });

  test('templates object is frozen — immutable after compilation', () => {
    const table = compilePushFormatters({
      'community:reply': { titleTemplate: 'Original' },
    });
    expect(() => {
      (table.templates as Record<string, unknown>)['community:reply'] = {
        titleTemplate: 'Mutated',
      };
    }).toThrow();
  });
});
