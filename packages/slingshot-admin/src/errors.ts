/** Errors thrown by the admin plugin. */

export class AdminConfigError extends Error {
  constructor(message: string) {
    super(`[slingshot-admin] ${message}`);
    this.name = 'AdminConfigError';
  }
}

/** Raised when an admin request is authenticated but not authorized for the requested action. */
export class AdminAccessDeniedError extends Error {
  constructor(reason: string) {
    super(`[slingshot-admin] access denied: ${reason}`);
    this.name = 'AdminAccessDeniedError';
  }
}

/** Raised when an admin request exceeds the configured destructive-action rate limit. */
export class AdminRateLimitExceededError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`[slingshot-admin] rate limit exceeded, retry after ${retryAfterMs}ms`);
    this.name = 'AdminRateLimitExceededError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Raised when an admin audit-log operation fails. */
export class AdminAuditLogError extends Error {
  constructor(message: string, cause?: unknown) {
    super(
      `[slingshot-admin] audit log error: ${message}`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'AdminAuditLogError';
  }
}
