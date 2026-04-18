/**
 * The default list of bus event keys that external webhook subscribers can receive.
 *
 * This list is shown in the endpoint management UI as the set of subscribable events.
 * Extend it with `WebhookPluginConfig.extraEventKeys` to add custom or application-specific keys.
 *
 * @remarks
 * - Template-literal keys (`webhook:inbound.*`) are excluded — these are emitted only, never subscribed.
 * - `auth:delivery.*` keys are included but carry one-time tokens; advise subscribers to handle them carefully.
 * - `community:*` keys are present when `slingshot-community` is installed.
 *
 * @example
 * ```ts
 * import { WEBHOOK_DEFAULT_SUBSCRIBABLE_EVENTS } from '@lastshotlabs/slingshot-webhooks';
 *
 * console.log(WEBHOOK_DEFAULT_SUBSCRIBABLE_EVENTS.includes('auth:login')); // true
 * ```
 */
export const WEBHOOK_DEFAULT_SUBSCRIBABLE_EVENTS: ReadonlyArray<string> = [
  'app:ready',
  'app:shutdown',
  'security.auth.login.success',
  'security.auth.login.failure',
  'security.auth.login.blocked',
  'security.auth.register.success',
  'security.auth.register.failure',
  'security.auth.register.concealed',
  'security.auth.logout',
  'security.auth.account.locked',
  'security.auth.account.suspended',
  'security.auth.account.unsuspended',
  'security.auth.account.deleted',
  'security.auth.session.created',
  'security.auth.session.revoked',
  'security.auth.password.reset',
  'security.auth.password.change',
  'security.auth.mfa.setup',
  'security.auth.mfa.verify.success',
  'security.auth.mfa.verify.failure',
  'security.auth.step_up.success',
  'security.auth.step_up.failure',
  'security.auth.oauth.linked',
  'security.auth.oauth.unlinked',
  'security.auth.oauth.reauthed',
  'security.rate_limit.exceeded',
  'security.credential_stuffing.detected',
  'security.csrf.failed',
  'security.breached_password.detected',
  'security.admin.role.changed',
  'security.admin.user.modified',
  'security.admin.user.deleted',
  'auth:user.created',
  'auth:user.deleted',
  'auth:login',
  'auth:logout',
  'auth:email.verified',
  'auth:password.reset.requested',
  'auth:account.deletion.scheduled',
  'auth:mfa.enabled',
  'auth:delivery.email_verification',
  'auth:delivery.password_reset',
  'auth:delivery.magic_link',
  'auth:delivery.email_otp',
  'auth:delivery.account_deletion',
  'auth:delivery.welcome',
  'auth:delivery.org_invitation',
  'community:container.created',
  'community:container.deleted',
  'community:thread.created',
  'community:thread.published',
  'community:thread.deleted',
  'community:thread.locked',
  'community:reply.created',
  'community:reply.deleted',
  'community:reaction.added',
  'community:reaction.removed',
  'community:user.banned',
  'community:user.unbanned',
  'community:content.reported',
  'community:member.joined',
  'community:member.left',
  'community:moderator.assigned',
  'community:moderator.removed',
  'community:thread.updated',
  'community:thread.pinned',
  'community:thread.unpinned',
  'community:thread.unlocked',
  'notifications:notification.created',
  'notifications:notification.updated',
  'notifications:notification.read',
  'notifications:notification.delivered',
] as const;
