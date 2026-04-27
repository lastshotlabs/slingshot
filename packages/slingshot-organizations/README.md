---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-organizations
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

## Purpose

@lastshotlabs/slingshot-organizations is the feature package in the Slingshot workspace.

Organizations and groups management plugin for Slingshot
Organization and group entities follow the shared package-first/entity model; `createOrganizationsPlugin()`
is the runtime shell that composes auth, invites, and membership flows.

## Package Boundaries

- Document which responsibilities this package owns.
- Call out which contracts come from `slingshot-core` or neighboring packages.
- Keep package-specific examples here instead of hiding them in the root docs.

## Operational Notes

- Org-management mutations and invitation acceptance should fail closed for suspended or newly-unverified accounts. Do not rely on global identify middleware alone for that boundary.
- Group-management mutations should fail closed for suspended or newly-unverified accounts. Apply the account-state check in the route handler before mutating groups or memberships.
- Group management configuration must also fail closed. Reject `managementRoutes.middleware: []` at startup instead of mounting unprotected routes.
- Generic organization list/get surfaces are administrative by default. Member-facing reads should come from explicitly scoped routes such as `/orgs/mine`, not from broad authenticated CRUD access.

## Gotchas

- Invitation acceptance is a continuation flow. Validate both the invitation target email and the current auth-account state before consuming the one-time token.
- Email-targeted invites require a verified matching email address, not only a matching email
  string on the current account.
- Invite-token lookup should not put the raw token in the URL path or leak invite identity metadata to unauthenticated callers. Treat invite tokens like bearer secrets.
- Membership records are scoped to their parent organization or group. Do not key them by bare
  `userId`; the same user must be able to exist in multiple org and group scopes safely.

## Key Files

- `packages/slingshot-organizations/src/index.ts`
