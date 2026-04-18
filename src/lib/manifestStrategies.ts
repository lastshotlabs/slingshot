/**
 * Built-in strategy resolution functions for manifest handler-ref fields.
 *
 * Each function resolves a string enum strategy to a runtime function. These
 * are used by manifestToAppConfig.ts when a manifest field contains a built-in
 * strategy string instead of a handler reference object.
 *
 * All strategies follow the swappable provider pattern (Rule 8): adding a new
 * strategy is a new case in the switch, never a refactor.
 */
import type { Context } from 'hono';
import { getClientIp } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Rate limit key generation
// ---------------------------------------------------------------------------

/**
 * Resolve a built-in rate-limit key strategy to a key generator function.
 *
 * All strategies auto-scope by tenant when `tenantId` is set on the context
 * (consistent with the framework's built-in rate limiter behavior — the rate
 * limit middleware adds its own `t:${tenantId}:` prefix).
 *
 * @param strategy - One of 'ip', 'user', 'ip+user'.
 * @returns A function compatible with the rate-limit middleware's keyGenerator option.
 */
export function resolveRateLimitKeyStrategy(
  strategy: 'ip' | 'user' | 'ip+user',
): (c: Context<AppEnv>) => string {
  switch (strategy) {
    case 'ip':
      return c => getClientIp(c);
    case 'user':
      return c => {
        const userId = c.get('authUserId');
        return typeof userId === 'string' && userId.length > 0 ? userId : getClientIp(c);
      };
    case 'ip+user':
      return c => {
        const userId = c.get('authUserId');
        return typeof userId === 'string' && userId.length > 0
          ? `u:${userId}`
          : `ip:${getClientIp(c)}`;
      };
  }
}

// ---------------------------------------------------------------------------
// Rate limit skip
// ---------------------------------------------------------------------------

/**
 * Resolve a built-in rate-limit skip strategy.
 *
 * @param strategy - Currently only 'authenticated'.
 * @returns A function that returns true when the request should bypass rate limiting.
 */
export function resolveRateLimitSkipStrategy(
  strategy: 'authenticated',
): (c: Context<AppEnv>) => boolean {
  void strategy;
  return c => c.get('authUserId') != null;
}

// ---------------------------------------------------------------------------
// Upload authorization
// ---------------------------------------------------------------------------

/**
 * Resolve a built-in upload authorization strategy.
 *
 * The framework's upload route checks `record.ownerUserId === userId` BEFORE
 * calling the custom authorize callback. The 'owner' strategy returns false for
 * non-owners (the owner check already handled the owner case). 'authenticated'
 * allows any logged-in user. 'public' allows everyone.
 *
 * @param strategy - One of 'owner', 'authenticated', 'public'.
 */
export function resolveUploadAuthStrategy(
  strategy: 'owner' | 'authenticated' | 'public',
): (input: { action: string; key: string; userId?: string; tenantId?: string }) => boolean {
  switch (strategy) {
    case 'owner':
      return () => false;
    case 'authenticated':
      return ({ userId }) => userId != null;
    case 'public':
      return () => true;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Resolve a built-in request log format strategy.
 *
 * @param strategy - One of 'json', 'pretty'.
 * @returns An onLog callback compatible with the framework's request logger.
 */
export function resolveLoggingStrategy(
  strategy: 'json' | 'pretty',
): (entry: Record<string, unknown>) => void {
  switch (strategy) {
    case 'json':
      return entry => console.log(JSON.stringify(entry));
    case 'pretty':
      return entry => {
        const status = entry.statusCode as number;
        const method = entry.method as string;
        const path = entry.path as string;
        const duration = entry.responseTime as number;
        console.log(`${method} ${path} ${status} ${duration}ms`);
      };
  }
}

// ---------------------------------------------------------------------------
// Metrics path normalization
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_PATTERN = /^\d+$/;

/**
 * Resolve a built-in metrics path normalization strategy.
 *
 * @param strategy - Currently only 'strip-ids'.
 * @returns A function that normalizes request paths for metric label cardinality.
 */
export function resolveNormalizePathStrategy(strategy: 'strip-ids'): (path: string) => string {
  void strategy;
  return path =>
    path
      .split('/')
      .map(segment =>
        UUID_PATTERN.test(segment) || NUMERIC_PATTERN.test(segment) ? ':id' : segment,
      )
      .join('/');
}

// ---------------------------------------------------------------------------
// Validation error formatting
// ---------------------------------------------------------------------------

interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Resolve a built-in validation error format strategy.
 *
 * @param strategy - One of 'flat', 'grouped'.
 * @returns A formatError callback compatible with the framework's validation middleware.
 */
export function resolveValidationFormatStrategy(
  strategy: 'flat' | 'grouped',
): (issues: ValidationIssue[], requestId: string) => unknown {
  switch (strategy) {
    case 'flat':
      return (issues, requestId) => ({
        error: 'Validation failed',
        details: issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
        requestId,
      });
    case 'grouped':
      return (issues, requestId) => {
        const grouped: Record<string, string[]> = {};
        for (const issue of issues) {
          const key = issue.path.length > 0 ? String(issue.path[0]) : '_root';
          if (!(key in grouped)) grouped[key] = [];
          grouped[key].push(issue.message);
        }
        return { error: 'Validation failed', fields: grouped, requestId };
      };
  }
}
