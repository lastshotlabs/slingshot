import { describe, expect, it, mock } from 'bun:test';
import { createInProcessAdapter, noopLogger } from '@lastshotlabs/slingshot-core';
import {
  fanOutBounce,
  parseResendWebhook,
  parseSesWebhook,
} from '../../src/lib/webhookHandlers.js';

describe('parseResendWebhook (P-MAIL-10)', () => {
  it('parses an email.bounced event into a normalized record', () => {
    const records = parseResendWebhook({
      type: 'email.bounced',
      data: {
        email: 'bounce@example.com',
        bounce: { type: 'permanent', reason: 'mailbox-full' },
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.email).toBe('bounce@example.com');
    expect(records[0]!.reason).toBe('permanent');
    expect(records[0]!.provider).toBe('resend');
  });

  it('parses an email.complained event into a complaint record', () => {
    const records = parseResendWebhook({
      type: 'email.complained',
      data: { email: 'spam@example.com' },
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.reason).toBe('complaint');
  });

  it('returns empty array for unrelated event types', () => {
    expect(parseResendWebhook({ type: 'email.delivered', data: {} })).toEqual([]);
    expect(parseResendWebhook(null)).toEqual([]);
    expect(parseResendWebhook({})).toEqual([]);
  });
});

describe('parseSesWebhook (P-MAIL-10)', () => {
  it('extracts a permanent bounce from an SNS Notification envelope', () => {
    const inner = {
      notificationType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'a@example.com' }, { emailAddress: 'b@example.com' }],
      },
    };
    const records = parseSesWebhook({
      Type: 'Notification',
      Message: JSON.stringify(inner),
    });
    expect(records).toHaveLength(2);
    expect(records.every(r => r.reason === 'permanent')).toBe(true);
    expect(records.every(r => r.provider === 'ses')).toBe(true);
  });

  it('extracts complaints from an SNS Notification envelope', () => {
    const inner = {
      notificationType: 'Complaint',
      complaint: {
        complainedRecipients: [{ emailAddress: 'spammed@example.com' }],
      },
    };
    const records = parseSesWebhook({
      Type: 'Notification',
      Message: JSON.stringify(inner),
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.reason).toBe('complaint');
  });

  it('ignores SubscriptionConfirmation envelopes (handled by route)', () => {
    expect(
      parseSesWebhook({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://x' }),
    ).toEqual([]);
  });
});

describe('fanOutBounce', () => {
  it('emits mail:bounce on the bus and invokes markEmailUnsubscribed', async () => {
    const bus = createInProcessAdapter();
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on('mail:bounce' as never, (payload: unknown) => {
      events.push({ name: 'mail:bounce', payload });
    });
    const callback = mock((_input: unknown) => {});
    await fanOutBounce(
      { email: 'a@example.com', reason: 'bounce', provider: 'resend' },
      bus,
      callback,
      noopLogger,
    );
    expect(events).toHaveLength(1);
    expect(callback.mock.calls).toHaveLength(1);
    await bus.shutdown?.();
  });

  it('survives a throwing markEmailUnsubscribed callback', async () => {
    const bus = createInProcessAdapter();
    const callback = mock(() => {
      throw new Error('boom');
    });
    await expect(
      fanOutBounce(
        { email: 'a@example.com', reason: 'complaint', provider: 'ses' },
        bus,
        callback,
        noopLogger,
      ),
    ).resolves.toBeUndefined();
    await bus.shutdown?.();
  });
});
