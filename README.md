# Slingshot

A config-driven backend framework for TypeScript. Hono under the hood, plugins on top,
typed entities and generated routes everywhere in between.

> **Status: pre-1.0.** Public API surface is mostly stable but still evolving. The
> production-track plugins listed below are hardening for 1.0; experimental plugins are
> labelled as such. No external consumers yet — feedback welcome.

## What you get

A single `app.config.ts` declares your app: which plugins are loaded, which database
adapters back them, where secrets come from, what events are exposed. From that one file
you get:

- A typed Hono app with all your routes mounted, OpenAPI generated, and middleware composed
  in dependency order.
- Entity-backed CRUD with generated handlers, validation, and adapter pluggability across
  Memory, SQLite, Postgres, and Mongo.
- Cross-cutting features — auth, permissions, orchestration, webhooks, mail,
  notifications, search, multi-tenancy — that you opt into per-plugin and configure
  consistently.
- A CLI that handles bootstrapping (`slingshot init`), migrations (`slingshot migrate`),
  local dev (`slingshot dev`), and production starts (`slingshot start`).

You don't build the framework. You declare an app.

## Install

```bash
bun add @lastshotlabs/slingshot @lastshotlabs/slingshot-core
```

Add whichever feature plugins you need — see [Capabilities](#capabilities) below.

## Quickstart

```typescript title="app.config.ts"
import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';

export default defineApp({
  port: 3000,
  security: { signing: { secret: process.env.JWT_SECRET! } },
  plugins: [
    createAuthPlugin({
      auth: { primaryField: 'email', roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
  ],
});
```

```bash
slingshot start
```

That's a real, working app: registration, login, JWT sessions, route protection. Swap
`memory` for `sqlite` / `postgres` to make it durable.

For programmatic composition (tests, dynamic configs), `createServer()` takes the same
shape:

```typescript
import { createServer } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';

await createServer({
  port: 3000,
  security: { signing: { secret: process.env.JWT_SECRET! } },
  plugins: [
    createAuthPlugin({
      /* ... */
    }),
  ],
});
```

## Capabilities

Slingshot ships as ~30 packages across four maturity tiers. Reach for `core` and
`entity` first; layer in production plugins as you need them; stay clear of the
experimental and deferred tiers unless you're actively contributing.

### Core path — start here

| Package            | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `slingshot-core`   | Plugin contract, app context, event bus, persistence resolution |
| `slingshot-entity` | `defineEntity`, generated CRUD, code generation, search hooks   |

### Production path — hardening for 1.0

| Package                                     | Purpose                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `slingshot-permissions`                     | RBAC, grants, evaluators, adapter factories                                      |
| `slingshot-organizations`                   | Multi-tenancy, org membership, scoping                                           |
| `slingshot-orchestration`                   | Task and workflow runtime; in-process and durable engines                        |
| `slingshot-orchestration-bullmq`            | BullMQ-backed orchestration adapter (Redis)                                      |
| `slingshot-orchestration-temporal`          | Temporal-backed orchestration adapter                                            |
| `slingshot-orchestration-plugin`            | Mounts the orchestration runtime as a Slingshot plugin                           |
| `slingshot-bullmq`                          | Durable event-bus adapter (Redis)                                                |
| `slingshot-assets`                          | File uploads, presigned URLs, storage adapters                                   |
| `slingshot-search`                          | Search plugin with Meilisearch / Typesense / Elasticsearch / Algolia / DB-native |
| `slingshot-webhooks`                        | Outbound delivery + inbound providers, governed by event registry                |
| `slingshot-kafka`                           | Kafka adapters and producer integration                                          |
| `slingshot-admin`                           | Admin route surface and ops tooling                                              |
| `slingshot-mail`                            | Transactional mail with Resend / SES / Postmark / SendGrid providers             |
| `slingshot-notifications`                   | Notification storage, preference resolution, dispatcher                          |
| `slingshot-push`                            | Web push & mobile push adapters                                                  |
| `slingshot-ssr` / `slingshot-ssg`           | Server-side rendering and static-site generation                                 |
| `slingshot-runtime-bun` / `-node` / `-edge` | Runtime adapters                                                                 |
| `slingshot-postgres`                        | Postgres connection helper and auth adapter                                      |

### Experimental — API may change

`slingshot-auth`, `slingshot-oauth`, `slingshot-oidc`, `slingshot-scim`, `slingshot-m2m`

### Deferred — not actively maintained

`slingshot-community`, `slingshot-chat`, `slingshot-polls`, `slingshot-image`,
`slingshot-emoji`, `slingshot-embeds`, `slingshot-gifs`, `slingshot-deep-links`,
`slingshot-interactions`, `slingshot-game-engine`, `slingshot-infra`

## CLI

```bash
slingshot init              # scaffold a new app
slingshot dev               # local dev server (--watch)
slingshot start             # production start (uses ./app.config.ts)
slingshot migrate generate  # create a migration from the current schema
slingshot migrate apply     # apply pending migrations
slingshot migrate status    # report applied vs pending
slingshot migrate dev       # generate + apply in one step (development)
slingshot generate          # regenerate entity code
slingshot deploy            # deploy hooks (provider-specific)
```

Run `slingshot <command> --help` for the flags on each.

## Architecture at a glance

When `createServer()` (or `slingshot start`) runs, the bootstrap walks a fixed sequence:

1. Validate the root config.
2. Sort plugins by their declared `dependencies`.
3. Resolve framework secrets from the configured provider.
4. Build infrastructure (DB pools, caches, queues, runtime adapters).
5. Construct the per-instance Slingshot context, frozen at the end of bootstrap.
6. Mount plugin middleware in dependency order (`setupMiddleware`).
7. Register routes (`setupRoutes`), then mount OpenAPI docs.
8. Run post-route hooks (`setupPost`) — typically event-bus subscriptions.
9. Freeze the context and start listening.

Plugins reach across packages through three mechanisms:

- **Events** — typed via `defineEvent`; published from anywhere, subscribed from anywhere.
- **Capabilities** — typed values one plugin exposes (`auth.lifecycle`,
  `mail.sender`, etc.) for others to consume without imports.
- **HookServices** — typed accessor bag on out-of-request callbacks (auth lifecycle hooks,
  workflow hooks, dead-letter callbacks) so background code can read entities, resolve
  capabilities, and publish events without capturing the `app` reference manually.

## Examples

Working apps in [`examples/`](examples/):

| Example                                                        | What it shows                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| [`with-auth`](examples/with-auth/)                             | Minimal auth setup                                         |
| [`organizations`](examples/organizations/)                     | Multi-tenant org scoping                                   |
| [`config-driven-domain`](examples/config-driven-domain/)       | Entity definitions, generated routes, custom operations    |
| [`content-platform`](examples/content-platform/)               | Content + assets + permissions composition                 |
| [`webhooks`](examples/webhooks/)                               | Outbound webhook delivery with the registry-governed model |
| [`orchestration`](examples/orchestration/)                     | In-process tasks and workflows (memory / sqlite adapters)  |
| [`orchestration-bullmq`](examples/orchestration-bullmq/)       | Durable orchestration with BullMQ + Redis                  |
| [`collaboration-workspace`](examples/collaboration-workspace/) | 12-plugin community workspace, end-to-end                  |
| [`game-engine`](examples/game-engine/)                         | Multiplayer game runtime with phases, turns, scoring       |

## Documentation

The full documentation lives at [`packages/docs/`](packages/docs/) and is published at
**https://lastshotlabs.github.io/slingshot/**. Key entry points:

- **Getting started** — `getting-started`, `first-steps`, `quick-start`, `installation`
- **Composing an app** — `composing-an-app`, `app-authoring/app-config`, `authoring/plugin-interface`
- **Authoring routes** — `authoring-routes`, `app-authoring/routes-and-handlers`,
  `app-authoring/validation`, `entity-system/route-policy`
- **Working with data** — `core-features/data-and-entities`, `entity-system/define-entity`,
  `entity-system/operations`, `entity-system/storage-and-adapter-wiring`
- **Security** — `core-features/auth`, `core-features/permissions`, `guides/security`,
  `guides/multi-tenancy`
- **Operations** — `core-features/jobs-and-orchestration`, `app-authoring/health-checks`,
  `app-authoring/metrics`, `app-authoring/distributed-tracing`, `guides/observability`
- **Production** — `guides/production-readiness`, `guides/deployment`, `guides/runtime`,
  `guides/secrets`, `guides/horizontal-scaling`

## Tests

```bash
bun run test              # default non-Docker suite (root + isolated + per-package)
bun run test:docker       # Docker-backed integration suite (Postgres, Mongo, Redis, etc.)
bun run test:e2e          # end-to-end suite
bun run test:all          # composition: test → test:docker → test:e2e
```

`test:all` is a composition of the other entrypoints — not a separate universe.

## Contributing

Internal docs in [`slingshot-docs/`](slingshot-docs/) cover the engineering rules,
documentation policy, specs process, and detailed agent context strategy. The short
version: keep the diff small, prefer editing existing files, don't add abstractions
beyond what the task requires, write no comments unless the _why_ is non-obvious.

## License

MIT.
