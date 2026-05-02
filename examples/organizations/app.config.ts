import { createAuthPlugin } from '../../packages/slingshot-auth/src/index.ts';
import { createOrganizationsPlugin } from '../../packages/slingshot-organizations/src/index.ts';
import { defineApp } from '../../src/index.ts';

/**
 * Source-backed organizations example.
 *
 * Demonstrates `slingshot-organizations` layered on `slingshot-auth`:
 * - custom roles via `knownRoles` and `defaultMemberRole`
 * - reserved-slug enforcement (typed `SlugConflictError` on collision)
 * - the standard /orgs CRUD, invitation, and membership routes
 */
export default defineApp({
  port: 3000,
  db: { mongo: false, redis: false },
  security: {
    signing: {
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
    },
  },
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
    createOrganizationsPlugin({
      organizations: {
        enabled: true,
        // Custom membership-role vocabulary — every member, invite, and
        // group-membership 'role' value is checked against this list.
        knownRoles: ['owner', 'admin', 'maintainer', 'member', 'guest'],
        defaultMemberRole: 'member',
        // App-specific reserved slugs in addition to the framework defaults.
        // Attempts to create an org with one of these surface as
        // `SlugConflictError` (HTTP 409) from `createOrgsPlugin`'s slug guard.
        reservedSlugs: ['admin', 'api', 'billing', 'support', 'www'],
        invitationTtlSeconds: 7 * 24 * 60 * 60,
      },
      groups: {
        managementRoutes: { adminRole: 'admin' },
      },
    }),
  ],
});
