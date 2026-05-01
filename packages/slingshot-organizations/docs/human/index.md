---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-organizations
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

## Purpose

@lastshotlabs/slingshot-organizations is the feature package in the Slingshot workspace.

Organizations and groups management plugin for Slingshot
The organization and group entities themselves follow the shared package-first/entity authoring model;
`createOrganizationsPlugin()` is the runtime shell that composes auth, invites, and membership flows.

## Minimum Setup

The plugin is configured through the app manifest under the `organizations` key:

```json
{
  "organizations": {
    "mountPath": "/orgs",
    "auth": {
      "requireAuth": true,
      "requireVerifiedEmail": true
    },
    "invite": {
      "rateLimit": { "maxPerWindow": 20, "windowMs": 3600000 }
    }
  }
}
```

For code-first setups, pass the config to `createOrganizationsPlugin()`:

```ts
import { createOrganizationsPlugin } from '@lastshotlabs/slingshot-organizations';

const plugin = createOrganizationsPlugin({
  mountPath: '/orgs',
});
```

The plugin depends on `slingshot-auth` being registered first.

## Package Boundaries

- Owns organization and group entity definitions, membership records, and invitation flows.
- Owns the org service published to plugin state, accessible via `getOrganizationsOrgServiceOrNull`.
- Depends on `slingshot-auth` for user auth middleware, route auth, and actor identity resolution.
- Depends on `slingshot-entity` for entity-backed CRUD routes and manifest-driven runtime.
- Does not own auth session management, user identity, or the permissions grant system.

## Operational Notes

- Org-management mutations and invitation acceptance should fail closed for suspended or newly-unverified accounts. Do not rely on global identify middleware alone for that boundary.
- Group-management mutations should fail closed for suspended or newly-unverified accounts. Apply the account-state check in the route handler before mutating groups or memberships.
- Group management configuration must also fail closed. Reject `managementRoutes.middleware: []` at startup instead of mounting unprotected routes.
- Generic organization list/get surfaces are administrative by default. Member-facing reads should come from explicitly scoped routes such as `/orgs/mine`, not from broad authenticated CRUD access.
- **Rate limiting:** invite-sending and membership mutation endpoints apply the framework's rate-limit middleware. Configure per-endpoint limits under the `rateLimit` key in the manifest. The default is 100 requests per minute per user for invite endpoints.
- **Reconciliation:** the plugin does not automatically reconcile org/group membership when a user account is suspended or deleted. Downstream consumers should subscribe to `auth:user.suspended` and `auth:user.deleted` events and call the organization service to remove affected memberships.

## Gotchas

- `mountPath` must start with `/`; trailing slashes are trimmed before routes are mounted.
- Invitation acceptance is a continuation flow. Validate both the invitation target email and the current auth-account state before consuming the one-time token.
- Email-targeted invites require a verified matching email address, not only a matching email
  string on the current account.
- Invite-token lookup should not put the raw token in the URL path or leak invite identity metadata to unauthenticated callers. Treat invite tokens like bearer secrets.
- Membership records are scoped to their parent organization or group. Do not key them by bare
  `userId`; the same user must be able to exist in multiple org and group scopes safely.
- The `membershipManagement.sync` operation is not idempotent. Re-calling it for the same set of users may produce duplicate group-member records. Use `membershipManagement.replace` instead, which performs a diff-and-patch.
- Invite rate limits are keyed by the inviting user, not the target email address. A single user sending invites to many addresses shares the same rate-limit window.
- Offboarding: there is no built-in cascade from user deletion to org/group membership cleanup. Subscribe to auth lifecycle events or schedule a reconciliation job.
- Group management configuration must also fail closed. Reject `managementRoutes.middleware: []` at startup instead of mounting unprotected routes.

## Key Files

- `packages/slingshot-organizations/src/index.ts`
