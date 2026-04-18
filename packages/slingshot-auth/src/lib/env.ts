/**
 * Returns `true` when `process.env.NODE_ENV === 'production'`.
 *
 * Used throughout the auth package to gate development-only warnings and to set
 * production-safe defaults for cookie attributes.
 *
 * @returns `true` in production, `false` in all other environments.
 *
 * @example
 * import { isProd } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const secure = isProd(); // true in production, false in dev/test
 */
export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}
