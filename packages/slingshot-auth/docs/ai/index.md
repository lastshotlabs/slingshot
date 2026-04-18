---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-auth
---

> AI-assisted draft. Use this page as a quick map of the package, then harden anything important in the human guide.

## Summary

`@lastshotlabs/slingshot-auth` is Slingshot's authentication and identity plugin. It owns the auth runtime, session and token flows, adapter bootstrap, route families for account and login behavior, and the security middleware that has to run early in the request pipeline.

This package is intentionally more than a route bundle. It is also the package that publishes auth-related boundary contracts back into core so the rest of the system can ask for `userAuth`, session-backed user resolution, rate limiting, fingerprinting, and built-in email templates without importing auth internals.

## Main Responsibilities

- Boot the auth runtime from config, infrastructure, and security inputs.
- Mount register, login, account, session, refresh, MFA, magic-link, step-up, SAML, and optional OAuth routes.
- Provide built-in auth middleware such as `userAuth`, `requireRole`, identify, bearer auth, CSRF, and MFA setup enforcement.
- Register boundary adapters and templates into the core registrar during plugin setup.
- Expose lower-level helpers for custom flows, testing, and standalone use.

## Package Shape

The package has four main layers:

- `src/plugin.ts` coordinates lifecycle phases and registrar publishing.
- `src/bootstrap.ts` assembles the runtime and adapter graph.
- `src/lib/` contains the reusable auth mechanics such as JWTs, sessions, OAuth helpers, fingerprinting, and email templating.
- `src/routes/` mounts the public route families only when the relevant features are enabled.

## Typical Integration Story

In the full framework:

1. `createAuthPlugin()` validates config.
2. `setupMiddleware()` bootstraps the runtime and registers auth capabilities with core.
3. `setupRoutes()` mounts only the enabled route groups.
4. `setupPost()` publishes user resolution and template state for other packages.

In standalone mode:

- `setup()` runs middleware and route setup directly for plain Hono apps.
- The caller must provide runtime pieces such as password and sqlite support through config.

## Common Cross-Package Touch Points

- `slingshot-core` for contracts and registries.
- `slingshot-mail` for delivery of auth templates.
- `slingshot-oauth` for optional OAuth route mounting when providers are configured.
- `slingshot-admin`, `slingshot-m2m`, `slingshot-scim`, and other packages that consume auth state or auth-owned contracts.

## Reading Order

1. `src/plugin.ts`
2. `src/bootstrap.ts`
3. `src/types/config.ts`
4. `src/lib/session.ts` and `src/lib/jwt.ts`
5. `src/routes/`

## Good Follow-Ups

- Use the human guide for the security and boundary invariants.
- Use the generated docs for the export inventory.
- Read `/api/slingshot-auth/` when you need a specific helper or type name.
