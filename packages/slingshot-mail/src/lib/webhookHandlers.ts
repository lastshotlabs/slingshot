import type { DynamicEventBus, Logger } from '@lastshotlabs/slingshot-core';

/**
 * Result of normalising a provider webhook into Slingshot bounce/complaint
 * events. Used by the plugin route handler to fan out to `markEmailUnsubscribed`
 * and emit `mail:bounce` / `mail:complaint` on the bus.
 */
export interface NormalizedBounce {
  /** The email address that bounced or generated a complaint. */
  email: string;
  /** Reason class. `'bounce'` for hard delivery failures, `'complaint'` for spam reports. */
  reason: 'bounce' | 'complaint' | 'permanent';
  /** Original provider name (`resend`, `ses`, etc.). */
  provider: string;
  /** Subset of the raw payload kept for diagnostics. */
  raw?: unknown;
}

/**
 * Parse a Resend bounce/complaint webhook body into zero or more normalised
 * bounce records. Resend sends a JSON object with a `type` discriminator —
 * we honour `email.bounced`, `email.complained`, and the bounce-via-resend
 * `email.delivery_delayed` (treated as transient and ignored).
 *
 * Returns an empty array for unrelated event types so callers can apply the
 * same handler to a single endpoint that receives all webhook traffic.
 */
export function parseResendWebhook(body: unknown): NormalizedBounce[] {
  if (!isObject(body)) return [];
  const type = typeof body.type === 'string' ? body.type : undefined;
  if (!type) return [];
  const data = isObject(body.data) ? body.data : undefined;
  const email = pickEmail(data);
  if (!email) return [];
  if (type === 'email.bounced' || type === 'email.bounce') {
    const bounceType = isObject(data?.bounce)
      ? (data?.bounce as Record<string, unknown>).type
      : undefined;
    return [
      {
        email,
        reason: bounceType === 'permanent' || bounceType === 'hard' ? 'permanent' : 'bounce',
        provider: 'resend',
        raw: body,
      },
    ];
  }
  if (type === 'email.complained' || type === 'email.complaint') {
    return [{ email, reason: 'complaint', provider: 'resend', raw: body }];
  }
  return [];
}

/**
 * Parse an SES SNS-wrapped notification body. SES delivers via SNS, so the
 * outer envelope has `Type: 'Notification' | 'SubscriptionConfirmation'` and a
 * `Message` field carrying the JSON-encoded SES payload.
 *
 * - `SubscriptionConfirmation` returns an empty array; the route handler
 *   surfaces the `SubscribeURL` to the operator out-of-band.
 * - `Notification` with `Bounce` populates one record per recipient.
 * - `Notification` with `Complaint` populates one record per complaining recipient.
 */
export function parseSesWebhook(body: unknown): NormalizedBounce[] {
  if (!isObject(body)) return [];
  const outerType = typeof body.Type === 'string' ? body.Type : undefined;
  if (!outerType) return [];
  if (outerType !== 'Notification') return [];
  let inner: unknown;
  try {
    inner = typeof body.Message === 'string' ? JSON.parse(body.Message) : body.Message;
  } catch {
    return [];
  }
  if (!isObject(inner)) return [];
  const notificationType =
    typeof inner.notificationType === 'string' ? inner.notificationType : undefined;
  if (!notificationType) return [];
  const out: NormalizedBounce[] = [];
  if (notificationType === 'Bounce' && isObject(inner.bounce)) {
    const bounce = inner.bounce as { bounceType?: string; bouncedRecipients?: unknown };
    const recipients = Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : [];
    const isPermanent = bounce.bounceType === 'Permanent';
    for (const r of recipients) {
      const email = isObject(r) && typeof r.emailAddress === 'string' ? r.emailAddress : undefined;
      if (!email) continue;
      out.push({
        email,
        reason: isPermanent ? 'permanent' : 'bounce',
        provider: 'ses',
        raw: inner,
      });
    }
  } else if (notificationType === 'Complaint' && isObject(inner.complaint)) {
    const complaint = inner.complaint as { complainedRecipients?: unknown };
    const recipients = Array.isArray(complaint.complainedRecipients)
      ? complaint.complainedRecipients
      : [];
    for (const r of recipients) {
      const email = isObject(r) && typeof r.emailAddress === 'string' ? r.emailAddress : undefined;
      if (!email) continue;
      out.push({ email, reason: 'complaint', provider: 'ses', raw: inner });
    }
  }
  return out;
}

/**
 * Dispatch a bounce/complaint record onto the bus and the optional unsubscribe
 * adapter. Errors raised by the adapter are caught and logged so a single bad
 * record cannot poison the rest of the batch.
 */
export async function fanOutBounce(
  record: NormalizedBounce,
  bus: DynamicEventBus,
  markEmailUnsubscribed: ((input: NormalizedBounce) => void | Promise<void>) | undefined,
  logger: Logger,
): Promise<void> {
  try {
    bus.emit(record.reason === 'complaint' ? 'mail:complaint' : 'mail:bounce', {
      email: record.email,
      reason: record.reason,
      provider: record.provider,
    });
  } catch (err) {
    logger.warn('mail bus emit failed', {
      provider: record.provider,
      reason: record.reason,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  if (!markEmailUnsubscribed) return;
  try {
    await markEmailUnsubscribed(record);
  } catch (err) {
    logger.error('markEmailUnsubscribed callback failed', {
      provider: record.provider,
      email: record.email,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickEmail(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  if (typeof data.email === 'string') return data.email;
  if (typeof data.to === 'string') return data.to;
  if (Array.isArray(data.to) && typeof data.to[0] === 'string') return data.to[0];
  return undefined;
}
