---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-auth
---

> Human-owned documentation. This page records the package boundaries and the security assumptions we want to preserve.

## Purpose

`@lastshotlabs/slingshot-auth` owns Slingshot's identity, session, and account-security layer. It is responsible for authenticating users, persisting auth state, and exposing safe integration points to the rest of the framework.

The package is not just "routes for login." It is also the runtime that wires auth adapters, token verification, session storage, security policies, and cross-package auth hooks.

## What Auth Owns

- account creation, login, logout, and account management flows
- sessions, refresh token rotation, and session policy enforcement
- JWT signing and verification behavior
- password reset, email verification, magic link, MFA, passkeys, step-up auth
- SAML support and optional OAuth route integration
- auth-specific rate limiting, fingerprinting, and security-event wiring
- publication of auth boundary contracts into the core registrar

## What Auth Should Not Own

- admin UI behavior
- generic mail transport
- unrelated package business rules
- direct plugin-to-plugin coupling when a core boundary contract is enough

## Lifecycle Expectations

`createAuthPlugin()` follows the core plugin phases deliberately:

- `setupMiddleware()` is where bootstrap happens because auth must run early and publish core contracts before downstream packages ask for them.
- `setupRoutes()` mounts route families after bootstrap is ready and only for enabled features.
- `setupPost()` publishes user resolution and email template state for other packages.

If these responsibilities move between phases, treat that as an architectural change, not a refactor detail.

## Important Invariants

- Auth owns startup validation of signing configuration and should fail loudly when secrets or required runtime dependencies are missing.
- Production boot must fail if `auth.jwt.issuer` or `auth.jwt.audience` is missing. Token-boundary hardening is not optional in production.
- Production boot must also require an explicit `signing.sessionBinding` choice. Leave it undefined and startup should fail instead of silently accepting replayable session tokens.
- Production boot must require an explicit `security.trustProxy` choice whenever auth is enabled. Leaving it undefined should not silently weaken IP-based abuse controls behind a reverse proxy.
- Security middleware that protects auth behavior belongs early in the chain.
- Optional features should fail clearly when configured but not installed, as the OAuth path already does.
- Session-backed user resolution must stay consistent with token verification and stored session state, especially for WebSocket and SSE flows.
- Standalone mode must remain explicit about runtime dependencies instead of silently depending on global Bun behavior.
- Suspension checks must run on authenticated requests by default, and refresh token rotation must not mint fresh credentials for suspended or newly-unverified accounts.
- Auth session cookies must use the hardened `__Host-` name whenever the configured cookie scope qualifies for it, and login, refresh, OAuth exchange, and logout flows must all use the same effective cookie names.
- Step-up and reauth-challenge endpoints must also fail closed for suspended or newly-unverified accounts instead of strengthening a stale session.
- Destructive MFA management routes must also fail closed for suspended or newly-unverified accounts instead of weakening a stale session.
- Session-bound account and session mutation routes such as `PATCH /auth/me`, `DELETE /auth/me`, `POST /auth/set-password`, and `DELETE /auth/sessions/:sessionId` must also fail closed for suspended or newly-unverified accounts instead of trusting a stale authenticated session.
- SAML login creates a normal authenticated session, but it must not automatically mark the session as locally MFA-fresh unless Slingshot has explicit proof of the required authentication context.
- Magic-link delivery throttling must protect both the requester IP and the submitted identifier so the route cannot be used for distributed inbox flooding.

## Integration Model

Auth should prefer publishing capabilities through core instead of exposing deep internal modules to sibling packages.

Today that includes:

- route auth helpers
- rate limit tracking
- fingerprint building
- user resolution
- built-in email templates

This pattern is important because it keeps packages like admin, community, and mail loosely coupled.

## Risk Areas To Watch

- Adapter parity across memory, sqlite, mongo, redis, and newer backends.
- Security-feature drift where a new route bypasses existing middleware or event wiring.
- Optional dependency paths such as OAuth and WebAuthn, where configuration and install state can diverge.
- Runtime abstraction work that touches password hashing, storage, or token verification.

## Related Reading

- [Auth Setup example](/examples/with-auth/) - runnable baseline in `examples/with-auth/`
- [Collaboration Workspace example](/examples/collaboration-workspace/) - auth composed with chat, community, polls, and media in `examples/collaboration-workspace/`
- [Content Platform example](/examples/content-platform/) - auth composed with SSR, search, and assets in `examples/content-platform/`
- `docs/specs/completed/config-driven-packages.md`
- `packages/slingshot-core/docs/human/index.md`
- `packages/slingshot-community/docs/human/index.md`
