import type { Context } from 'hono';
import type { AdminAccessProvider, AdminPrincipal, AppEnv } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import { getAuthRuntimeFromRequest } from '../runtime';

/**
 * Creates the slingshot-auth access provider for the built-in admin API.
 *
 * Implements `AdminAccessProvider` by resolving the authenticated user's roles from
 * the auth adapter and building an `AdminPrincipal` from their profile. Returns `null`
 * when the request has no authenticated user, causing the admin API to return 401.
 *
 * Passed to `createServer({ admin: { accessProvider: createSlingshotAuthAccessProvider() } })`
 * to gate the built-in admin panel with standard session-based auth + role checks.
 *
 * @returns An `AdminAccessProvider` that delegates to the slingshot-auth adapter.
 *
 * @example
 * import { createServer } from '@lastshotlabs/slingshot-core';
 * import { createAuthPlugin, createSlingshotAuthAccessProvider } from '@lastshotlabs/slingshot-auth';
 *
 * const server = await createServer({
 *   plugins: [createAuthPlugin({ auth: { roles: ['admin'] } })],
 *   admin: { accessProvider: createSlingshotAuthAccessProvider() },
 * });
 *
 * @remarks
 * `getUser` and `getRoles` on the adapter are called via optional chaining — adapters
 * that omit these methods will return `null` (access denied) rather than throwing.
 */
export function createSlingshotAuthAccessProvider(): AdminAccessProvider {
  return {
    name: 'slingshot-auth',

    async verifyRequest(c: Context<AppEnv>): Promise<AdminPrincipal | null> {
      const userId = getActorId(c);
      if (!userId) return null;

      const adapter = getAuthRuntimeFromRequest(c).adapter;
      const user = await adapter.getUser?.(userId);
      if (!user) return null;

      const roles = (await adapter.getRoles?.(userId)) ?? [];

      return {
        subject: userId,
        email: user.email,
        displayName: user.displayName ?? undefined,
        roles,
        provider: 'slingshot-auth',
      };
    },
  };
}
