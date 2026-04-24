---
title: Core Docs Coverage Audit
description: Audited checklist of core framework surfaces that must be explicitly covered in the docs
---

## Purpose

This note is the coverage gate for the docs restructure.

The rule is simple:

- if a surface is part of the core framework model
- and is exported from the root package or is a top-level app/server concern
- it must have an explicit docs home

This audit is intentionally scoped to core framework and authoring surfaces only.
It does not attempt package-by-package feature coverage.

## Audit scope

Included:

- root exports from `src/index.ts`
- top-level app and server config from `src/app.ts` and `src/server.ts`
- core contracts from `packages/slingshot-core`
- entity authoring and runtime surfaces from `slingshot-core` and `slingshot-entity`
- framework runtime seams such as event bus, WebSockets, SSE, uploads, metrics, and secrets

Excluded:

- feature-package-specific behaviors
- package-specific route catalogs
- package-specific integration details

## Coverage matrix

| Core surface                  | Why it is core                                                       | Primary source anchors                                                                                             | Docs home required                                                                      |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| App assembly                  | Every app starts here                                                | `src/app.ts`, `src/server.ts`                                                                                      | `App Authoring / createServer and createApp`                                            |
| App config                    | Every app uses this, directly or indirectly                          | `CreateAppConfig` in `src/app.ts`                                                                                  | `App Authoring / App Config`                                                            |
| Server config                 | Transport startup, WS, SSE, workers, shutdown                        | `CreateServerConfig` in `src/server.ts`                                                                            | `App Authoring / createServer and createApp` plus `WebSockets` and `Server-Sent Events` |
| Context model                 | Shared runtime state and request accessors                           | `packages/slingshot-core/src/context/slingshotContext.ts`, root accessors in `src/index.ts`                        | `App Authoring / Context and Request Model`                                             |
| Packages vs plugins           | Canonical composition model depends on this                          | `CreateAppConfig.packages`, `packages/slingshot-core/src/packageAuthoring.ts`, `src/framework/packageAuthoring.ts` | `App Authoring / Packages and Plugins` plus `Package-First Authoring`                   |
| Plugin lifecycle              | Lower-level integration contract and ordering model                  | `packages/slingshot-core/src/plugin.ts`, `src/framework/runPluginLifecycle.ts`                                     | `Package-First Authoring / Escape Hatches` plus `Internals / Plugin Lifecycle`          |
| Event bus                     | Cross-package communication is default framework behavior            | `packages/slingshot-core/src/eventBus.ts`, `eventDefinition.ts`, `eventPublisher.ts`                               | `App Authoring / Events and the Event Bus`                                              |
| SSE                           | Core realtime path built on event definitions and event envelopes    | `src/config/types/sse.ts`, `src/server.ts`, SSE docs/runtime files                                                 | `App Authoring / Server-Sent Events`                                                    |
| WebSockets                    | Core runtime seam with its own config, transport, and presence model | `src/config/types/ws.ts`, `src/server.ts`, WS runtime files                                                        | `App Authoring / WebSockets`                                                            |
| Security pipeline             | Core request-processing model                                        | `src/config/types/security.ts`, middleware re-exports in `src/index.ts`                                            | `App Authoring / Middleware` and `Guides / Security`                                    |
| Validation and OpenAPI        | Generated and handwritten routes depend on this                      | `createRoute`, `registerSchema`, `validation.ts`, route mounting in `src/app.ts`                                   | `App Authoring / OpenAPI and Validation`                                                |
| Uploads                       | Top-level app concern with config and runtime APIs                   | `src/config/types/upload.ts`, upload exports in `src/index.ts`                                                     | `Guides / Uploads` and `App Config`                                                     |
| Versioning                    | Top-level routing and docs behavior                                  | `src/config/types/versioning.ts`                                                                                   | `App Authoring / Routes` or dedicated `API Versioning` page                             |
| Logging                       | Top-level operational concern                                        | `src/config/types/logging.ts`                                                                                      | `Guides / Monitoring` or `Runtime and Infrastructure`                                   |
| Metrics                       | Top-level operational concern with endpoint and auth model           | `src/config/types/metrics.ts`                                                                                      | `Guides / Monitoring` or `Runtime and Infrastructure`                                   |
| Observability/tracing         | Top-level operational concern                                        | `src/config/types/observability.ts`                                                                                | `Guides / Observability`                                                                |
| Permissions bootstrap         | Top-level shared runtime concern                                     | `src/config/types/permissions.ts`                                                                                  | `Guides / Permissions` plus `App Config`                                                |
| Tenancy                       | Top-level request and routing concern                                | `src/config/types/tenancy.ts`                                                                                      | `Guides / Multi-Tenancy` plus `App Config`                                              |
| Secrets                       | Top-level runtime bootstrap concern                                  | `src/config/types/secrets.ts`, framework secret resolution                                                         | `Guides / Secrets` plus `App Config`                                                    |
| Jobs endpoint                 | Core operational HTTP surface                                        | `src/config/types/jobs.ts`                                                                                         | `Guides / Runtime and Infrastructure` or dedicated `Jobs` page                          |
| Runtime abstraction           | Important for Bun/Node/edge story                                    | `SlingshotRuntime` exports and runtime docs                                                                        | `Guides / Runtime`                                                                      |
| Entity authoring              | Canonical way to author entity-shaped domains                        | `packages/slingshot-core/src/entityConfig.ts`, `packages/slingshot-entity/src/packageAuthoring.ts`                 | `Entity System`                                                                         |
| Entity route policy           | Core part of generated route semantics                               | `packages/slingshot-core/src/entityRouteConfig.ts`                                                                 | `Entity System / Route Policy`                                                          |
| Entity operations             | Named behaviors beyond CRUD                                          | `defineOperations`, `op.*`                                                                                         | `Entity System / Operations`                                                            |
| Entity runtime factories      | Swappable storage and runtime adapter generation                     | `packages/slingshot-entity/src/configDriven/createEntityFactories.ts`                                              | `Entity System / Storage and Adapter Wiring`                                            |
| Generated route customization | High-value DX surface for entity system                              | `entityRoutePlanning.ts`, `buildBareEntityRoutes.ts`                                                               | `Entity System / Generated Routes, Overrides, and Extra Routes`                         |
| Package-first typed routes    | Core code-first non-entity route story                               | `packages/slingshot-core/src/packageAuthoring.ts`                                                                  | `Package-First Authoring / domain and route`                                            |
| Manifest bootstrap            | Alternate but still supported entrypoint                             | `createServerFromManifest`, manifest registry files                                                                | `Alternate Paths / Manifest Authoring`                                                  |

## Top-level app config checklist

Every top-level `CreateAppConfig` key must either:

- appear in the main app authoring docs, or
- be intentionally delegated to a specialized guide

| Config key        | Meaning                                              | Docs home                                                       |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `routesDir`       | file-based route discovery                           | `App Authoring / Routes`                                        |
| `modelSchemas`    | schema preloading before route mounting              | `App Authoring / OpenAPI and Validation`                        |
| `meta`            | app name/version and docs metadata                   | `App Authoring / createServer and createApp`                    |
| `security`        | CORS, headers, rate limiting, signing, CAPTCHA, CSRF | `App Authoring / Middleware` plus `Guides / Security`           |
| `middleware`      | global user middleware                               | `App Authoring / Middleware`                                    |
| `db`              | persistence selection and connection strategy        | `App Authoring / Runtime and Infrastructure`                    |
| `jobs`            | jobs endpoint                                        | `Runtime and Infrastructure`                                    |
| `tenancy`         | tenant resolution                                    | `Guides / Multi-Tenancy`                                        |
| `logging`         | request logging and diagnostics                      | `Guides / Monitoring`                                           |
| `metrics`         | `/metrics` endpoint and gauges                       | `Guides / Monitoring`                                           |
| `observability`   | tracing                                              | `Guides / Observability`                                        |
| `validation`      | validation error formatting                          | `App Authoring / OpenAPI and Validation`                        |
| `upload`          | upload storage and auth                              | `Guides / Uploads`                                              |
| `versioning`      | versioned route trees and docs                       | `App Authoring / Routes`                                        |
| `plugins`         | lower-level lifecycle composition                    | `App Authoring / Packages and Plugins`                          |
| `packages`        | canonical code-first composition                     | `App Authoring / Packages and Plugins`                          |
| `eventBus`        | cross-package event transport                        | `App Authoring / Events and the Event Bus`                      |
| `kafkaConnectors` | bridge to Kafka                                      | `Advanced / Event Bus at Scale` or dedicated `Kafka Connectors` |
| `ws`              | WebSocket endpoints and transport                    | `App Authoring / WebSockets`                                    |
| `secrets`         | secret-provider strategy                             | `Guides / Secrets`                                              |
| `runtime`         | runtime abstraction                                  | `Guides / Runtime`                                              |
| `permissions`     | server-level permissions bootstrap                   | `Guides / Permissions`                                          |

## Root export checklist

These are the root-level surfaces that should be treated as documentation entrypoints, not just API
reference symbols.

### App and lifecycle

- `createApp`
- `createServer`
- `SlingshotContext`
- `getContext`
- `getActor`

### Event system

- `SlingshotEventBus`
- `SlingshotEventMap`
- `createInProcessAdapter`
- `defineEvent`
- `createEventPublisher`
- `EventEnvelope`
- `SECURITY_EVENT_TYPES`

### Package-first authoring

- `definePackage`
- `domain`
- `route`
- `defineCapability`
- `provideCapability`
- `entityRef`
- `inspectPackage`

### Entity authoring

- `defineEntity`
- `field`
- `index`
- `relation`
- `defineOperations`
- `op`
- `entity`
- `createEntityFactories`
- backend adapter creators
- `createCompositeFactories`

### Core request helpers and middleware

- `createRoute`
- `registerSchema`
- `withSecurity`
- `idempotent`
- `rateLimit`
- `cacheResponse`
- `webhookAuth`
- `requireSignedRequest`
- `auditLog`
- `requestId`
- `requestLogger`
- `metricsCollector`
- `requireCaptcha`
- `handleUpload`

### Realtime

- `createWsUpgradeHandler`
- room/publish helpers
- presence helpers
- `createSseUpgradeHandler`

## Current likely doc gaps

These are the areas most likely to be under-documented or under-positioned in the current docs.

### Gap 1: packages vs plugins

The source is clear that `packages` are the canonical code-first app-builder path.
The docs still do not center that strongly enough.

### Gap 2: event bus as part of the default app model

The docs have event bus pages, but it is still easy to treat the bus as a plugin-authoring detail
instead of a core app concern.

### Gap 3: WebSockets as first-class core functionality

WebSockets should not be buried under generic realtime content.
They have enough surface area to require their own core page.

### Gap 4: entity runtime customization

The docs need a clearer distinction between:

- generated defaults
- executor overrides
- extra routes
- manual adapter wiring

### Gap 5: operational top-level config

Logging, metrics, observability, secrets, runtime, jobs, and permissions bootstrap all matter to
real apps, but they are easy to under-emphasize if the docs stay too focused on the happy-path app
composition story.

## Required docs homes before restructure sign-off

These pages or sections must exist in some form before the restructure is considered complete.

- `createServer and createApp`
- `App Config`
- `Context and Request Model`
- `Middleware`
- `Events and the Event Bus`
- `WebSockets`
- `Server-Sent Events`
- `Packages and Plugins`
- `OpenAPI and Validation`
- `Runtime and Infrastructure`
- `Package-First Authoring / definePackage`
- `Package-First Authoring / domain and route`
- `Package-First Authoring / capabilities and entityRef`
- `Entity System / defineEntity`
- `Entity System / Route Policy`
- `Entity System / Operations`
- `Entity System / Storage and Adapter Wiring`
- `Entity System / Generated Routes, Overrides, and Extra Routes`
- `Guides / Security`
- `Guides / Multi-Tenancy`
- `Guides / Permissions`
- `Guides / Uploads`
- `Guides / Runtime`
- `Guides / Secrets`
- `Guides / Observability`
- `Guides / Monitoring`
- `Alternate Paths / Manifest Authoring`

## Practical rule for the next docs pass

Before rewriting a page, check:

1. Which core surface does this page own?
2. Is that surface exported or top-level config?
3. Is the page the canonical docs home for it, or just a mention?
4. If this page were deleted, would that surface still have a clear primary docs home?

If the answer to 4 is no, the docs structure is still not OSS-grade ready.
