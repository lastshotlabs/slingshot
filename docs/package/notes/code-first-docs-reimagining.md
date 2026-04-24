---
title: Code-First Docs Reimagining
description: Proposal for restructuring Slingshot docs around canonical code-first authoring
---

## Why this needs to change

The current public docs still tell a manifest-first story in the places that matter most:

- the homepage hero
- the introduction page
- the quick start
- the "manifest vs code" framing
- the top-level sidebar grouping

That no longer matches the strongest authoring surface in the codebase.

The source now says the canonical code-first path is:

- `createServer()` / `createApp()` at the app root
- `definePackage(...)` for package ownership and composition
- `entity(...)` for entity-owned runtime behavior
- `domain(...)` and `route.*(...)` for package-owned non-entity routes
- `defineCapability(...)` / `provideCapability(...)` / `entityRef(...)` for typed cross-package seams

The docs do not reflect that clearly enough. In particular:

- the flagship entity example still centers `createEntityPlugin()`
- the package-first authoring surface is mostly discoverable only from source or package notes
- "what every app does" and "what only some apps do" are mixed together
- manifest content is treated like the default path instead of an alternate bootstrap path

## Desired outcome

The docs should make three things obvious within a few minutes:

1. The default way to build with Slingshot is code-first.
2. The default way to author your own domain is package-first, usually with entities.
3. The manifest is an alternate entrypoint, not the main mental model.

The docs should also give readers a reliable progression:

1. Build a minimal app.
2. Understand how a Slingshot app is assembled.
3. Learn the canonical authoring APIs in the order they are normally used.
4. Learn the built-in behavior before the escape hatches.
5. Move from "every app" concerns to specialized package/runtime concerns.

## Content principles

### 1. Code first, not JSON first

Every top-level onboarding page should lead with TypeScript.

If the manifest remains documented, it should appear as:

- an alternate workflow page
- a migration/interoperability page
- a deployment-oriented page

It should not be the default tab on the homepage or quick start.

### 2. Canonical over exhaustive, then exhaustive behind it

Each major topic needs:

- a canonical way
- what Slingshot gives you by default
- how to customize it
- the escape hatch when the default is not enough

This prevents readers from seeing low-level flexibility before they understand the standard path.

### 3. Organize by authoring job, not by implementation history

The current split between "config-driven", "build a plugin", "guides", "packages", and "internals"
forces readers to already know where concepts live.

The new structure should follow the actual authoring jobs:

- start an app
- compose packages
- define a domain
- define entities and operations
- add routes and middleware
- adopt advanced features
- inspect internals when necessary

### 4. Make the spectrum explicit

Readers need to understand which surfaces are:

- used by every app
- used by most apps
- used by some apps
- used only for specialized products

That is the cleanest way to separate core docs from package-specific depth.

### 5. Match the actual source hierarchy

The docs should mirror the authoring API that exists today:

- app assembly in `src/app.ts` and `src/server.ts`
- package-first contracts in `packages/slingshot-core/src/packageAuthoring.ts`
- entity runtime authoring in `packages/slingshot-entity/src/packageAuthoring.ts`
- plugin lifecycle as a lower-level contract, not the first story

## Proposed top-level information architecture

### 1. Start Here

Purpose: get a reader to first value fast.

Pages:

- `Overview`
- `Quickstart`
- `Your First Real App`
- `How Slingshot Fits Together`
- `Concepts at a Glance`

Notes:

- `Overview` replaces the current manifest-heavy introduction.
- `Quickstart` is code-first only.
- `Your First Real App` expands the minimal app into a practical baseline: auth, routes, docs, one domain.

### 2. App Authoring

Purpose: document what every Slingshot app does.

Pages:

- `createServer and createApp`
- `App Config`
- `Routes`
- `Middleware`
- `Events and the Event Bus`
- `WebSockets`
- `Server-Sent Events`
- `Packages and Plugins`
- `OpenAPI and Validation`
- `Runtime and Infrastructure`
- `Testing an App`

This section answers:

- how an app boots
- where routes come from
- how middleware ordering works
- how events are defined, published, subscribed to, and transported
- how WebSocket endpoints, rooms, presence, transports, and SSE fit into the app model
- when to use `packages` vs `plugins`
- what is built in before customization

### 3. Package-First Authoring

Purpose: document the canonical way to build your own product/domain package.

Pages:

- `Why Package-First`
- `definePackage`
- `domain and route`
- `Capabilities and entityRef`
- `Package Middleware`
- `Composition Patterns`
- `Escape Hatches`

This becomes the main authoring section for custom domain work.

### 4. Entity System

Purpose: document the canonical way to build entity-shaped domains.

Pages:

- `Entity System Overview`
- `defineEntity`
- `Fields, Indexes, Relations, and Conventions`
- `Route Policy`
- `Operations`
- `Generated Behavior`
- `Entity Middleware`
- `Permissions and Events`
- `Channels and Realtime`
- `Overrides and Extra Routes`
- `Adapter Wiring`
- `When to Drop Lower`

This is the most important deep section after app authoring.

It should explicitly present the model:

- entity config defines the contract
- operations define transitions and named behaviors
- `entity(...)` publishes the runtime module
- `definePackage(...)` owns composition
- `createEntityPlugin()` is the lower-level fallback and compatibility surface

### 5. Built-In Product Packages

Purpose: explain what some apps do after the core authoring story is clear.

Groups:

- `Auth and Access`
- `Community and Realtime`
- `Search and Discovery`
- `Rendering and Delivery`
- `Assets and Media`
- `Integrations and Ops`

Each package page should follow the same contract:

1. What this package adds
2. Minimal composition example
3. Canonical use cases
4. What you get by default
5. Key customization seams
6. Related packages

### 6. Advanced Topics

Purpose: cover common but non-baseline concerns.

Pages:

- `Multi-tenancy`
- `Permissions`
- `Uploads`
- `WebSockets`
- `SSE`
- `Event Bus at Scale`
- `Observability`
- `Secrets`
- `Security`
- `Scaling`
- `Deployment`
- `Background Work and Orchestration`

These are not the first story, but they are likely second-wave needs.

### 7. Alternate and Legacy Paths

Purpose: keep manifest docs available without letting them dominate the docs.

Pages:

- `Manifest Authoring`
- `Handlers File`
- `Manifest and Code Interop`
- `Migrating from Manifest to Code`

This is where `manifest-vs-code` should move or be replaced.

### 8. Internals and Reference

Purpose: contributor and deep-debug material.

Pages:

- `Plugin Lifecycle`
- `Context and Registrar`
- `Persistence Resolution`
- `Event Bus Internals`
- `Manifest Internals`
- `API Reference`

This content should stay available, but not compete with app-builder onboarding.

## The key narrative order

The public docs should teach Slingshot in this order:

1. Minimal app
2. App assembly model
3. Package composition
4. Package-first domain authoring
5. Entity system
6. Product packages
7. Advanced features
8. Internals
9. Manifest

That is much closer to how a reader actually succeeds.

## Proposed sidebar rewrite

This is the high-level public sidebar shape, not final labels:

```text
Get Started
  Overview
  Quickstart
  Your First Real App
  How Slingshot Fits Together
  Concepts at a Glance

App Authoring
  createServer and createApp
  App Config
  Routes
  Middleware
  Events and the Event Bus
  WebSockets
  Server-Sent Events
  Packages and Plugins
  OpenAPI and Validation
  Runtime and Infrastructure
  Testing an App

Package-First Authoring
  Why Package-First
  definePackage
  domain and route
  Capabilities and entityRef
  Package Middleware
  Composition Patterns
  Escape Hatches

Entity System
  Overview
  defineEntity
  Fields, Indexes, Relations, and Conventions
  Route Policy
  Operations
  Generated Behavior
  Entity Middleware
  Permissions and Events
  Channels and Realtime
  Overrides and Extra Routes
  Adapter Wiring
  When to Drop Lower

Packages
  Auth and Access
  Community and Realtime
  Search and Discovery
  Rendering and Delivery
  Assets and Media
  Integrations and Ops

Advanced
  Multi-tenancy
  Permissions
  Uploads
  WebSockets
  SSE
  Event Bus at Scale
  Observability
  Secrets
  Security
  Scaling
  Deployment
  Orchestration

Alternate Paths
  Manifest Authoring
  Handlers File
  Manifest and Code Interop
  Migrating to Code

Examples
  Minimal App
  Auth Setup
  Package-First Domain
  Collaboration Workspace
  Content Platform
  Orchestration
  ...

Internals
  Plugin Lifecycle
  Context and Registrar
  Persistence Resolution
  Event Bus
  Manifest Internals

API Reference
```

## Canonical docs stories that need to exist

These are the core stories the docs should tell with first-class pages.

### Story 1: Minimal app

Show the smallest useful app:

- `createServer(...)`
- one auth plugin or one minimal package
- one route directory
- docs at `/docs`

Goal: "I can run this in five minutes."

### Story 2: How apps are assembled

Explain:

- framework middleware
- plugin/package middleware
- route registration
- event definition registry and event publisher setup
- OpenAPI mounting
- post-bootstrap wiring
- context finalization

This should reference the real bootstrap flow in `src/app.ts`, but be written for app authors.

### Story 3: Packages are the default composition unit

Show:

- package owns entities, domains, middleware, capabilities
- app root composes packages
- packages compile to plugins internally

This is critical because the source already treats `packages` as canonical in `CreateAppConfig`.

### Story 4: Entity-first domain authoring

Show the full path:

- `defineEntity(...)`
- `defineOperations(...)`
- `entity(...)`
- `definePackage(...)`
- `createServer({ packages: [...] })`

This should replace the older "entity -> createEntityPlugin" story as the canonical path.

### Story 5: What Slingshot gives you by default

For routes, entities, middleware, permissions, and events, readers need a consistent breakdown:

- defaults
- extension points
- lower-level escape hatches

Examples:

- route auth defaults
- generated CRUD behavior
- list filtering constraints
- middleware ordering
- default in-process event bus
- canonical event envelope and client-safe event model
- automatic docs generation
- adapter resolution

### Story 6: When to use the lower-level surfaces

Document when to use:

- raw `plugins`
- `createEntityPlugin()`
- manual route files
- manual adapter wiring
- manifest bootstrap

This page should prevent overusing escape hatches without hiding them.

## What "every app" should cover

This should be a first-class classification in the docs.

Every app eventually needs to understand:

- app entrypoint: `createServer()` / `createApp()`
- route mounting
- middleware ordering
- event bus basics: event definitions, `ctx.events.publish(...)`, subscriptions, and transport choice
- OpenAPI docs and validation
- auth shape on requests
- context access
- package and plugin composition
- environment and secrets model

Those docs should be written before package-specific depth.

## What "most apps" should cover

Most apps will likely need:

- auth
- permissions
- entities
- package composition
- event-driven side effects
- uploads
- multitenancy
- events
- observability

These should be the second major layer after the baseline.

## What "some apps" should cover

Only some apps need:

- orchestration
- SSR / SSG
- chat
- community moderation
- webhooks
- deep links
- custom emoji
- edge runtime specifics

These belong after the canonical app/package/entity story.

## Concrete page rewrites to prioritize

### Highest priority

- homepage
- `getting-started.mdx`
- `quick-start.mdx`
- sidebar in `astro.config.mjs`
- `config-driven` landing page
- `examples/config-driven-domain.mdx`

### Why these first

These pages currently establish the wrong center of gravity.

If these stay manifest-first or `createEntityPlugin()`-first, deeper page improvements will still
leave readers with the wrong mental model.

## Concrete content changes by page

### Homepage

Current issue:

- hero copy leads with plugins configured in a manifest

Change:

- lead with code-first composition
- show package-first and entity-first authoring in the value proposition
- push manifest to a secondary "alternate path" mention

### Introduction

Current issue:

- teaches manifest first
- still frames code as the alternative

Change:

- define Slingshot as a code-first application and package authoring platform
- show manifest as an optional bootstrap path for teams that want pure data config

### Quick Start

Current issue:

- split tabs give the manifest equal or stronger narrative weight

Change:

- code-only quickstart
- "manifest quickstart" becomes a separate page linked later

### Config-Driven Domain example

Current issue:

- canonical example still uses `createEntityPlugin()`

Change:

- canonical example should use `entity(...)` + `definePackage(...)`
- `createEntityPlugin()` remains in a "lower-level path" section

## Documentation templates that should repeat everywhere

For major authoring pages, use this structure:

1. `What this is for`
2. `The canonical way`
3. `What you get automatically`
4. `How to customize it`
5. `Escape hatches`
6. `Common mistakes`
7. `Related pages`

For package pages, use:

1. `What this package adds`
2. `Minimal setup`
3. `Canonical setup`
4. `Key concepts`
5. `Common composition patterns`
6. `Extension points`
7. `Related packages`

For advanced guides, use:

1. `When you need this`
2. `Baseline setup`
3. `Production concerns`
4. `Failure modes`
5. `Related packages and examples`

## Example strategy

Examples should map directly to the docs progression:

- `minimal-app` or equivalent for the first run
- `with-auth` for baseline real apps
- `package-first-domain` replacing or rewriting `config-driven-domain`
- `collaboration-workspace` for dense composition
- `content-platform` for SSR/SSG/search/assets
- `orchestration` for specialized workflows

The docs should stop treating examples as a grab bag and instead use them as canonical anchors.

## Recommended migration sequence

### Phase 1: change the public narrative

- rewrite homepage
- rewrite introduction
- rewrite quickstart
- rewrite sidebar labels and order

### Phase 2: establish canonical app authoring docs

- create `App Authoring`
- create `Package-First Authoring`
- rewrite `Config-Driven` into `Entity System`

### Phase 3: rewrite the flagship example

- replace the current entity/plugin example with a package-first entity example
- add a lower-level `createEntityPlugin()` page for compatibility and escape hatches

### Phase 4: normalize package docs

- apply one repeated structure to built-in package pages
- explicitly classify each package as "common", "specialized", or "adjacent"

### Phase 5: demote manifest docs without deleting them

- move manifest docs into `Alternate Paths`
- add a short migration page for manifest users

## Proposed standard for language

Use these phrases consistently:

- "code-first" for the default app-builder story
- "package-first" for canonical domain composition
- "entity system" for entity and operations authoring
- "lower-level escape hatch" for raw plugins and manual assembly
- "alternate bootstrap path" for manifest

Avoid these phrases unless narrowly scoped:

- "manifest-first"
- "config-driven" as the umbrella for the whole product

"Config-driven" still fits the entity system, but it should not be the top-level brand for how to
build any Slingshot app.

## Final recommendation

The docs should teach Slingshot as:

- a code-first app framework
- with package-first domain composition
- with an entity system as the canonical way to author entity-shaped domains
- with lower-level plugin and manifest escape hatches when needed

That is the most accurate story the current source supports, and it is the clearest path for new
users to succeed quickly without learning the wrong abstraction first.

## Second-pass entity-system findings

After a deeper pass through the runtime and flagship packages, a few things are now clear enough to
shape the docs structure more concretely.

### 1. The storage story should be a first-class docs pillar

This is not just "entities work with multiple databases." The actual runtime shape is:

- one `ResolvedEntityConfig`
- one operation map
- one `createEntityFactories(...)` call
- many backend adapters: memory, redis, sqlite, mongo, postgres

That is the clearest proof point for the entity system.

The docs should explain that the entity model is stable while the runtime adapter changes underneath
it through factory resolution.

Important source anchors:

- `packages/slingshot-entity/src/configDriven/createEntityFactories.ts`
- `packages/slingshot-entity/src/configDriven/redisAdapter.ts`
- `packages/slingshot-entity/src/configDriven/postgresAdapter.ts`

### 2. "Swappable storage" actually has multiple layers

The docs should not flatten this into one bullet. There are distinct stories:

- backend swapping: memory / redis / sqlite / mongo / postgres
- backend-specific generated behavior: TTL, indexes, native queries, search fallback
- consumer shape hardening: `systemFields`, `storageFields`, `conventions`
- package-level adapter wiring modes: `standard`, `factories`, `manual`

That deserves one dedicated page, not scattered mentions.

### 3. Generated routes are more sophisticated than the current docs imply

The route planner supports:

- generated CRUD routes
- named operation routes
- extra custom routes
- executor overrides for generated routes
- collision detection
- specificity ordering
- typed request and response metadata

That means the docs need to distinguish:

- "change the behavior of a generated route" via overrides
- "add a new route inside the entity shell" via extra routes
- "drop to manual routing" only when neither of those fit

This is a major docs story because it is one of the system's strongest DX surfaces.

### 4. Search is part of the entity story, not a separate afterthought

The entity system itself already owns a lot of search semantics:

- entity-level `search` config
- `op.search(...)`
- search-provider delegation through `createEntityFactories(...)`
- search sync modes such as write-through
- per-entity search settings such as searchable/filterable/sortable fields

Then `slingshot-search` turns that entity-owned metadata into a live runtime:

- provider lifecycle
- index creation
- entity discovery from the registry
- reindex and event-sync behavior

The docs should explain this boundary clearly:

- entity config defines search intent
- `slingshot-search` owns provider runtime and indexing behavior

### 5. Flagship packages use the advanced entity runtime heavily

`slingshot-community` is particularly important here.

It demonstrates that the entity system can support:

- dense route policy
- event scopes and exposure rules
- cascades
- permission-scoped operations
- per-backend custom operation handlers
- search-rich entities
- lazy middleware refs that resolve after adapter availability
- WebSocket channel wiring layered onto entity/plugin runtime

So even if the public docs shift to package-first authoring as the canonical path, community should
still be treated as the production-grade proof that the entity runtime can carry serious product
domains.

### 6. The docs need two distinct but connected stories

The second pass makes the split clearer:

- **Story A: app-builder canonical path**
  `createServer(...)` + `packages` + `definePackage(...)` + `entity(...)` + `domain(...)`

- **Story B: mature runtime capabilities**
  what the entity/plugin runtime can actually do in flagship packages today

If the docs only tell Story A, they undersell the system.
If the docs only tell Story B, they bury the cleaner modern entrypoint.

Both need to exist, and they should be connected intentionally.

## Additional pages now justified by the second pass

These should be explicit pages or strong subsections.

### Entity storage and adapter wiring

Must cover:

- `createEntityFactories(...)`
- backend adapter generation
- wiring modes: standard / factories / manual
- how package/entity runtime chooses the active backend
- when to use composite factories

### Search through the entity system

Must cover:

- entity `search` config
- `op.search(...)`
- provider delegation
- write-through sync vs event-bus/manual sync
- relationship to `slingshot-search`

### Generated routes, overrides, and extra routes

Must cover:

- CRUD route generation
- named operation route generation
- route overrides
- extra routes
- collision rules
- typed request/response metadata

### Middleware and permission timing

Must cover:

- framework middleware
- plugin/package middleware
- entity route middleware
- why some middleware refs are late-bound in real packages
- how permission state becomes available during setup

### Events and the event bus

Must cover:

- `SlingshotEventBus`
- `defineEvent(...)`
- `createEventPublisher(...)`
- event envelopes and scope/exposure metadata
- client-safe events and SSE/webhook implications
- why subscriptions normally belong in `setupPost`
- default in-process adapter vs shared buses for multi-instance deployments

### Realtime and channels

Must cover:

- entity channel config
- subscribe guards
- incoming handler maps
- how packages self-wire onto WS endpoints during bootstrap

## Documentation risk to avoid

The second pass exposed one important risk:

Do not let the docs imply that package-first means "simple only" while plugin/entity runtime means
"advanced only."

That would be wrong.

The better framing is:

- package-first is the canonical app-authoring surface
- the entity/plugin runtime is the machinery underneath
- flagship packages demonstrate the full ceiling of that machinery

The same rule applies to events:

- the event bus is part of the default application model
- not just an internal plugin mechanism
- and not just a scaling add-on

## Core-only docs coverage checklist

This is the minimum OSS-grade core coverage bar before the docs restructure should be considered
ready. It is intentionally limited to framework and core authoring surfaces, not feature packages.

### 1. App and server assembly

Must document:

- `createApp(...)`
- `createServer(...)`
- the difference between app assembly and transport startup
- the bootstrap order at a level app builders can understand
- where framework middleware, package/plugin middleware, routes, OpenAPI, and finalization fit

Primary source anchors:

- `src/app.ts`
- `src/server.ts`

### 2. Root app configuration

Must document the practical meaning of:

- `routesDir`
- `modelSchemas`
- `security`
- `middleware`
- `db`
- `jobs`
- `tenancy`
- `logging`
- `metrics`
- `observability`
- `validation`
- `upload`
- `versioning`
- `plugins`
- `packages`
- `eventBus`
- `kafkaConnectors`
- `ws`
- `secrets`
- `runtime`
- `permissions`

This is not just a reference page. It needs a "what every app uses first" ordering.

### 3. Context and request model

Must document:

- `SlingshotContext`
- `getContext(...)`
- `getActor(...)`
- tenant/request accessors
- where shared runtime state lives
- when to use context directly vs package/entity abstractions

Primary source anchors:

- `packages/slingshot-core/src/context/slingshotContext.ts`
- root re-exports in `src/index.ts`

### 4. Event bus and event model

Must document:

- `SlingshotEventBus`
- default `createInProcessAdapter()`
- `SlingshotEventMap`
- `defineEvent(...)`
- `createEventPublisher(...)`
- event envelopes
- scope and exposure metadata
- `SECURITY_EVENT_TYPES`
- `on` vs `onEnvelope`
- `drain()` and shutdown behavior
- when to switch to a shared bus

Primary source anchors:

- `packages/slingshot-core/src/eventBus.ts`
- `packages/slingshot-core/src/eventDefinition.ts`
- `packages/slingshot-core/src/eventPublisher.ts`

### 5. Plugin lifecycle and lower-level integration

Must document:

- `SlingshotPlugin`
- `PluginSetupContext`
- `setupMiddleware`
- `setupRoutes`
- `setupPost`
- `teardown`
- plugin ordering and dependencies
- when plugins are still the right abstraction

Primary source anchors:

- `packages/slingshot-core/src/plugin.ts`
- `src/framework/runPluginLifecycle.ts`

### 6. Package-first authoring

Must document:

- `definePackage(...)`
- `domain(...)`
- `route.*(...)`
- `defineCapability(...)`
- `provideCapability(...)`
- `entityRef(...)`
- `inspectPackage(...)`
- the fact that app roots should prefer `packages`
- how packages compile into framework plugins

Primary source anchors:

- `packages/slingshot-core/src/packageAuthoring.ts`
- `src/framework/packageAuthoring.ts`

### 7. Entity system

Must document:

- `defineEntity(...)`
- `field`, `index`, `relation`
- `ResolvedEntityConfig`
- `defineOperations(...)`
- `op.*(...)`
- `entity(...)`
- generated CRUD behavior
- named operations
- route policy and permissions
- data scopes
- middleware declarations
- cascades
- search config on entities

Primary source anchors:

- `packages/slingshot-core/src/entityConfig.ts`
- `packages/slingshot-core/src/entityRouteConfig.ts`
- `packages/slingshot-entity/src/packageAuthoring.ts`

### 8. Entity runtime and adapter wiring

Must document:

- `createEntityFactories(...)`
- backend adapters: memory, redis, sqlite, mongo, postgres
- `createCompositeFactories(...)`
- wiring modes: standard / factories / manual
- consumer shape hardening:
  `systemFields`, `storageFields`, `conventions`
- search-provider delegation and sync behavior at the entity runtime layer

Primary source anchors:

- `packages/slingshot-entity/src/configDriven/createEntityFactories.ts`
- backend adapter files under `packages/slingshot-entity/src/configDriven/`
- resolved field/convention types in `packages/slingshot-core/src/entityConfig.ts`

### 9. Generated route customization

Must document:

- generated CRUD routes
- generated named operation routes
- extra routes
- route executor overrides
- collision rules
- specificity ordering
- typed request/response metadata for generated and extra routes

Primary source anchors:

- `packages/slingshot-entity/src/routing/entityRoutePlanning.ts`
- `packages/slingshot-entity/src/routing/buildBareEntityRoutes.ts`

### 10. Middleware, security, and request pipeline

Must document the core request-pipeline story:

- framework middleware
- user middleware
- package/entity middleware
- rate limiting
- signing
- CAPTCHA
- idempotency
- uploads
- request logging
- metrics

This should be organized as "what is built in" before listing each helper independently.

### 11. WebSockets

Must document:

- root `ws` config
- endpoint declarations
- endpoint bootstrap timing
- upgrade handlers
- incoming events
- subscribe guards
- rooms and publish
- presence
- heartbeat
- recovery
- rate limiting
- transport adapters
- how plugin/package code mutates WS endpoint drafts during bootstrap

Important nuance:

- WebSocket transport scaling is separate from the app event bus
- app events may feed WS behavior, but WS room fan-out is its own runtime seam

### 12. Server-Sent Events

Must document the core runtime seams for:

- SSE endpoint config
- SSE registry and filters
- relationship between SSE delivery and event definitions / client-safe exposure
- how SSE consumes canonical event envelopes from the event bus

Important nuance:

- SSE is directly tied to the event model in a way WebSocket room transport is not

### 13. Manifest as alternate path

Must still document:

- `createServerFromManifest(...)`
- manifest handler registry
- manifest-to-app-config conversion
- custom event buses / plugins / secret providers in manifest mode

But this should be positioned as an alternate bootstrap path, not the main core story.

That framing keeps the docs accurate without making the public story feel split-brain.
