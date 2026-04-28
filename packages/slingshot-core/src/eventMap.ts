/**
 * Central event map for all built-in Slingshot events.
 *
 * Typed key to payload pairs consumed by `SlingshotEventBus`. Plugin packages
 * extend this map via TypeScript module augmentation in their own `events.ts`
 * file, never by modifying this interface directly.
 */
export interface SlingshotEventMap {
  // Framework lifecycle
  'app:ready': { plugins: string[] };
  'app:shutdown': { signal: 'SIGTERM' | 'SIGINT' };

  // Security events - auth lifecycle
  'security.auth.login.success': {
    userId: string;
    sessionId?: string;
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.login.failure': {
    identifier?: string;
    reason?: string;
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.login.blocked': {
    identifier?: string;
    userId?: string;
    reason?: 'lockout' | 'stuffing' | 'suspended';
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.register.success': {
    userId: string;
    email?: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.register.failure': { meta?: Record<string, unknown> };
  'security.auth.register.concealed': { meta?: Record<string, unknown> };
  'security.auth.logout': { sessionId?: string; userId?: string };
  'security.auth.account.locked': { userId: string; meta?: Record<string, unknown> };
  'security.auth.account.suspended': { userId: string; meta?: Record<string, unknown> };
  'security.auth.account.unsuspended': { userId: string; meta?: Record<string, unknown> };
  'security.auth.account.deleted': { userId: string; meta?: Record<string, unknown> };
  'security.auth.session.created': { userId: string; sessionId: string };
  'security.auth.session.fingerprint_mismatch': {
    userId: string;
    sessionId: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.session.revoked': {
    userId: string;
    sessionId: string;
    meta?: Record<string, unknown>;
  };
  'security.auth.password.reset': { userId?: string; meta?: Record<string, unknown> };
  'security.auth.password.change': { userId: string };
  'security.auth.mfa.setup': { userId?: string };
  'security.auth.mfa.verify.success': { userId?: string };
  'security.auth.mfa.verify.failure': { userId?: string; method?: string; ip?: string };
  'security.auth.step_up.success': { userId: string };
  'security.auth.step_up.failure': { userId: string };
  'security.auth.oauth.linked': { userId?: string; meta?: Record<string, unknown> };
  'security.auth.oauth.unlinked': { userId?: string; meta?: Record<string, unknown> };
  'security.auth.oauth.reauthed': {
    userId?: string;
    sessionId?: string;
    meta?: Record<string, unknown>;
  };

  // Security events - infrastructure
  'security.rate_limit.exceeded': { key?: string; ip?: string; meta?: Record<string, unknown> };
  'security.credential_stuffing.detected': {
    type?: 'ip' | 'account';
    key?: string;
    count?: number;
    ip?: string;
    meta?: Record<string, unknown>;
  };
  'security.csrf.failed': { ip?: string; path?: string; meta?: Record<string, unknown> };
  'security.breached_password.detected': { meta?: Record<string, unknown> };
  'security.breached_password.api_failure': { meta?: Record<string, unknown> };

  // Security events - admin actions
  'security.admin.role.changed': { userId?: string; meta?: Record<string, unknown> };
  'security.admin.user.modified': { userId?: string; meta?: Record<string, unknown> };
  'security.admin.user.deleted': { userId?: string; meta?: Record<string, unknown> };

  // Auth domain events
  'auth:user.created': { userId: string; email?: string; tenantId?: string | null };
  'auth:user.deleted': { userId: string; tenantId?: string };
  'auth:login': { userId: string; sessionId: string; tenantId?: string };
  'auth:logout': { userId: string; sessionId: string };
  'auth:email.verified': { userId: string; email: string };
  'auth:password.reset.requested': { userId: string; email: string };
  'auth:account.deletion.scheduled': {
    userId: string;
    cancelToken: string;
    gracePeriodSeconds: number;
  };
  'auth:mfa.enabled': { userId: string; method: 'totp' | 'email-otp' | 'webauthn' };
  'auth:mfa.disabled': { userId: string; method?: 'totp' | 'email-otp' | 'webauthn' };

  // Delivery events - mail-plugin-only payloads, token-bearing
  'auth:delivery.email_verification': { email: string; token: string; userId: string };
  'auth:delivery.password_reset': { email: string; token: string };
  'auth:delivery.magic_link': { identifier: string; token: string; link: string };
  'auth:delivery.email_otp': { email: string; code: string };
  'auth:delivery.account_deletion': {
    userId: string;
    email: string;
    cancelToken: string;
    gracePeriodSeconds: number;
  };
  'auth:delivery.welcome': { email: string; identifier: string };
  'auth:delivery.org_invitation': {
    email: string;
    orgName: string;
    invitationLink: string;
    expiryDays: number;
  };
}

/**
 * Extracts the subset of `SlingshotEventMap` keys that belong to the
 * `security.*` namespace.
 */
export type SecurityEventKey = Extract<keyof SlingshotEventMap, `security.${string}`>;
