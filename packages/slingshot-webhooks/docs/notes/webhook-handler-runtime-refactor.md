---
title: Webhook Handler Runtime Refactor Scaffold
description: Staged webhook decoupling plan aligned to the handler runtime branch
---

> Working scaffold, not a committed architecture decision. This note assumes the `handler-functions-runtime` worktree lands before webhook management is fully reworked.

## Status

- State: draft scaffold
- Owner lane: `slingshot-webhooks`
- Depends on: handler runtime changes in `C:\Users\email\projects\slingshot-functions-runtime`
- Goal: prepare the real webhook refactor spec before implementation starts

## Why This Exists

The current webhook package is only partially hexagonal.

We verified three concrete coupling problems in the current package:

- Management auth is coupled to `slingshot-auth` via `dependencies: ['slingshot-auth']` in `src/plugin.ts`.
- Entity-backed management routes hardcode `auth: 'userAuth'` in `src/entities/webhookEndpoint.ts` and `src/entities/webhookDelivery.ts`.
- Framework and transport concerns are mixed into webhook orchestration:
  - `fetch` is called directly in `src/lib/dispatcher.ts`
  - inbound providers depend on Hono `Context` in `src/types/inbound.ts`
  - delivery orchestration sits inside `src/plugin.ts`

The queue itself is already abstract enough to support multiple backends through `WebhookQueue`, but the package boundary is still too coupled to framework and auth decisions.

## What Changed In The Handler Runtime Worktree

The handler-runtime branch adds a proper transport-agnostic handler layer in core and teaches `slingshot-entity` to mount those handlers as route overrides.

Verified new primitives:

- `defineHandler`, `Guard`, `AfterHook`, `HandlerError` in `packages/slingshot-core/src/handler.ts`
- route mounting from handlers in `packages/slingshot-core/src/mount.ts`
- guard-based auth in `packages/slingshot-core/src/guards.ts`
- manifest route handler overrides in `packages/slingshot-entity/src/manifest/entityManifestRuntime.ts`
- generated entity handler build + mount flow in:
  - `packages/slingshot-entity/src/routing/buildEntityHandlers.ts`
  - `packages/slingshot-entity/src/routing/mountEntityHandlers.ts`

This changes the right first step for webhook refactoring.

Before this branch, the clean answer was "split packages first."

After this branch, the better first step is:

- move webhook management behavior onto transport-agnostic handlers
- make auth a handler/guard choice instead of a package-level dependency
- use entity route overrides for management routes where that still fits

## Refactor Intent

The target architecture is still the same in principle:

- core webhook use cases depend only on webhook-owned ports
- Slingshot plugin integration is an outer adapter
- queue, HTTP client, inbound verification transport, and persistence are outer adapters

The sequence changes.

## Proposed Staged Plan

### Phase 1: Decouple Management Auth Using Handler Runtime

Do this first after the handler-runtime branch lands.

Goals:

- remove the hard package dependency on `slingshot-auth`
- stop encoding webhook management auth in generated entity route defaults
- express management authorization through guards attached to handlers

Approach:

- Define transport-agnostic handlers for webhook management operations:
  - create endpoint
  - list endpoints
  - get endpoint
  - update endpoint
  - delete endpoint
  - list deliveries
  - get delivery
  - enqueue test delivery
- Register them through `manifestRuntime.routeHandlers` so `slingshot-entity` uses them for route mounting.
- Replace hardcoded `defaults: { auth: 'userAuth' }` with handler guards where needed.
- Introduce explicit management auth configuration rather than implicit auth plugin dependency.

Expected result:

- webhook runtime, inbound processing, and queue delivery can exist without auth
- management routes can be:
  - disabled
  - public
  - guarded by user auth
  - guarded by bearer auth
  - guarded by custom middleware/handler policy

### Phase 2: Extract Webhook Application Services

Do this after management routing is on the new handler path.

Move business logic out of plugin/runtime glue into explicit application services:

- `WebhookSubscriptionService`
- `WebhookDeliveryService`
- `WebhookTestDeliveryService`
- `InboundWebhookService`

Move these rules into services:

- endpoint validation
- event-to-endpoint matching
- delivery transition rules
- retryability decisions
- test-delivery orchestration

This phase should shrink `src/plugin.ts` substantially.

### Phase 3: Own The Ports

Replace remaining framework-leaking contracts with webhook-owned ports.

Candidates:

- replace `PaginatedResult` dependency in `src/types/adapter.ts` with a local page type
- replace `QueueLifecycle` inheritance in `src/types/queue.ts` with a local lifecycle contract
- replace direct `SlingshotEventBus` dependency inside core orchestration with webhook-specific publisher/subscriber ports
- replace direct Hono `Context` in inbound provider contracts with a webhook-owned request DTO
- replace direct `fetch` usage with an HTTP delivery port

At the end of this phase, the webhook domain/application layer should import nothing from:

- `hono`
- `@lastshotlabs/slingshot-core`
- `@lastshotlabs/slingshot-entity`

### Phase 4: Package Split If It Still Pays For Itself

Only do this after the boundaries are already real in code.

Likely package shape:

- `slingshot-webhooks-core`
  - domain models
  - use cases
  - retry policy
  - ports
- `slingshot-webhooks`
  - Slingshot plugin adapter
  - entity manifest integration
  - Hono inbound routes
  - route/auth integration
- optional adapter packages if justified:
  - queue adapters
  - HTTP transport adapter

If Phase 1-3 produce sufficiently clean boundaries inside one package, splitting may become optional rather than mandatory.

## Proposed Management Auth Model

This is the most urgent design correction.

Current state:

- package-level dependency on `slingshot-auth`
- route-level default `auth: 'userAuth'`
- custom `webhooksAdminGuard` layered on top

Desired state:

- no package-level auth dependency by default
- management auth is an explicit strategy
- strategy is applied through guards or route middleware selection

Candidate config shape:

```ts
management: {
  enabled?: boolean; // default true when endpoints routes are enabled
  auth?:
    | { mode: 'none' }
    | { mode: 'userAuth'; role?: string }
    | { mode: 'bearer' }
    | { mode: 'custom'; guard: string };
}
```

Open question:

- whether the final `custom` path should reference a named handler/guard from manifest runtime, a middleware registry entry, or both

## How The Handler Runtime Should Be Used

When the branch lands, webhook management should prefer the new core handler flow:

- use `defineHandler(...)` for management use cases
- use `Guard`s for auth, permissions, tenancy, and idempotency where needed
- mount through:
  - route overrides in `manifestRuntime.routeHandlers`
  - direct `mount(...)` only for routes that do not fit entity CRUD well

This aligns webhook management with the direction the framework is already taking instead of keeping a bespoke auth wrapper in `src/plugin.ts`.

## Areas That Should Stay Adapter-Specific

These should remain outer adapters, not be pulled into the core:

- BullMQ webhook queue
- memory webhook queue
- Hono inbound router
- manifest/entity adapter wiring
- Slingshot plugin lifecycle
- concrete HTTP transport implementation

## Open Questions For The Full Spec

- Should endpoint and delivery management remain entity-generated routes with handler overrides, or move to fully custom handlers/routes?
- Should webhook management auth use the same declarative route auth model as entity routes, or should webhooks own a separate management auth config?
- Is `enqueue test delivery` best modelled as:
  - an entity named operation handler
  - a custom mounted handler
  - a direct plugin route
- How much of `createWebhooksManifestRuntime()` should survive versus being replaced by repository adapters around entity runtime?
- Is package split still worth the churn once handler-based decoupling is complete?
- Should inbound providers remain sync-to-bus adapters, or should inbound processing also move behind a dedicated application service before route emission?

## Expected Success Criteria

The refactor is successful when all of the following are true:

- webhook delivery runtime can boot without `slingshot-auth`
- disabling management routes removes all auth requirements
- management auth is configured explicitly, not implied by package dependency
- queue backend changes do not require business logic changes
- handler/business logic can be tested without Hono or route mounting
- outbound delivery transport can be swapped without touching orchestration logic
- inbound verification contract no longer leaks Hono types into core use cases

## Suggested Deliverables For The Real Spec

- final architecture diagram: core vs adapters
- exact config changes and migration path
- route/auth matrix for management endpoints
- port inventory with proposed TypeScript interfaces
- handler inventory for management operations
- transition plan for tests:
  - handler tests
  - queue contract tests
  - repository contract tests
  - HTTP transport contract tests
  - integration coverage retained at plugin level

## Immediate Follow-Up Once Handler Branch Lands

1. Re-read the merged versions of:
   - `packages/slingshot-core/src/handler.ts`
   - `packages/slingshot-core/src/guards.ts`
   - `packages/slingshot-core/src/mount.ts`
   - `packages/slingshot-entity/src/routing/buildEntityHandlers.ts`
   - `packages/slingshot-entity/src/manifest/entityManifestRuntime.ts`
2. Decide whether webhook management uses handler overrides for all CRUD routes or only for auth-sensitive ones.
3. Write the real implementation spec from this scaffold before changing runtime code.
