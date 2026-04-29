/** Errors thrown by the admin plugin. */

export class AdminConfigError extends Error {
  constructor(message: string) {
    super(`[slingshot-admin] ${message}`);
    this.name = 'AdminConfigError';
  }
}

export class AdminAccessDeniedError extends Error {
  constructor(reason: string) {
    super(`[slingshot-admin] access denied: ${reason}`);
    this.name = 'AdminAccessDeniedError';
  }
}

export class AdminRateLimitExceededError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`[slingshot-admin] rate limit exceeded, retry after ${retryAfterMs}ms`);
    this.name = 'AdminRateLimitExceededError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AdminAuditLogError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`[slingshot-admin] audit log error: ${message}`, cause !== undefined ? { cause } : undefined);
    this.name = 'AdminAuditLogError';
  }
}
