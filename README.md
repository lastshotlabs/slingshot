# Slingshot

Build a typed backend by declaring packages, entities, routes, and infrastructure—not by
assembling the same plumbing for every service.

Slingshot is a TypeScript backend framework built on
[Hono](https://hono.dev/). One `app.config.ts` can produce:

- typed routes and generated OpenAPI documentation;
- entity CRUD, validation, operations, and migrations;
- swappable Memory, SQLite, PostgreSQL, MongoDB, and Redis-backed infrastructure;
- events, permissions, realtime, jobs, workflows, webhooks, and observability;
- production startup checks, health/readiness endpoints, and operational tooling.

The root framework, core contracts, and entity system are stable and published on npm's
`latest` channel. Package maturity is declared and checked per package—see
[Package maturity](#package-maturity).

[Documentation](https://lastshotlabs.github.io/slingshot/) ·
[Quick start](https://lastshotlabs.github.io/slingshot/quick-start/) ·
[Examples](https://github.com/lastshotlabs/slingshot/tree/main/examples) ·
[npm packages](https://www.npmjs.com/org/lastshotlabs)

## Start in one minute

Slingshot supports Bun and Node.js 20 or newer. The examples use Bun.

```bash
mkdir my-api && cd my-api
bun init -y
bun add @lastshotlabs/slingshot hono zod
```

Create `app.config.ts`:

```ts
import { defineApp, definePackage, domain, route } from '@lastshotlabs/slingshot';

const api = definePackage({
  name: 'api',
  domains: [
    domain({
      name: 'health',
      basePath: '/health',
      routes: [
        route.get({
          path: '/',
          summary: 'Health check',
          handler: ({ respond }) => respond.json({ ok: true }),
        }),
      ],
    }),
  ],
});

export default defineApp({
  port: 3000,
  packages: [api],
});
```

Start it:

```bash
bunx slingshot start
curl http://localhost:3000/health
# {"ok":true}
```

The OpenAPI UI is available at `http://localhost:3000/docs`.

From here:

- [define an entity](https://lastshotlabs.github.io/slingshot/quick-start/#step-2-add-a-data-model)
  to generate CRUD routes;
- [compose an app](https://lastshotlabs.github.io/slingshot/composing-an-app/) from
  packages, contracts, capabilities, and events;
- [prepare for production](https://lastshotlabs.github.io/slingshot/guides/production-readiness/)
  with durable stores, explicit tenancy, secrets, migrations, and readiness checks.

You can also run `slingshot init my-api` for the interactive application scaffold.

## The authoring model

```text
app.config.ts
└── defineApp(...)
    ├── runtime, databases, security, tenancy, observability
    └── definePackage(...)
        ├── entities      → CRUD, operations, validation, storage
        ├── routes        → typed domain endpoints
        ├── events        → governed, versioned messages
        └── contracts     → typed capabilities shared between packages
```

The framework validates and orders the graph at startup, builds a per-app context, mounts
middleware and routes, connects infrastructure, and freezes registries before serving
traffic. Package boundaries remain explicit:

- **Contracts and capabilities** expose typed services without reaching into another
  package's internals.
- **Governed events** carry versioned envelopes and support transactional outbox/inbox
  delivery.
- **Entities** provide a backend-neutral authoring model with conformance-tested adapters.
- **Request and execution context** carries actor, tenant, correlation, causation, and
  idempotency identity across supported boundaries.

## Define data once

```ts
import { defineEntity, field } from '@lastshotlabs/slingshot';

export const Task = defineEntity('Task', {
  namespace: 'app',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    title: field.string(),
    done: field.boolean({ default: false }),
  },
});
```

Mounting this entity in a package generates create, list, read, update, and delete routes
with request validation and OpenAPI schemas. Add domain operations when CRUD is not the
right abstraction.

[Entity guide](https://lastshotlabs.github.io/slingshot/core-features/data-and-entities/) ·
[Operations](https://lastshotlabs.github.io/slingshot/entity-system/operations/) ·
[Backend support](https://lastshotlabs.github.io/slingshot/reference/entity-backend-support/)

## Production capabilities

Slingshot includes production-oriented contracts beyond route generation:

- **Migration engine v2** — deterministic risk plans, explicit rename intent, approval
  digests, deployment locks, checksums, resumable execution, and verification.
- **Transactional events** — PostgreSQL and SQLite outbox/inbox persistence,
  acknowledged BullMQ/Kafka delivery, bounded retries, retention, replay validation, and
  authenticated operator routes.
- **Tenant boundaries** — explicit single- or multi-tenant modes, immutable execution
  snapshots, boundary conformance evidence, and optional PostgreSQL row-level security.
- **Operational safety** — startup validation, liveness/readiness, metrics, tracing,
  audit logging, rate limiting, secrets providers, graceful shutdown, and packed-artifact
  checks.
- **Runtime choice** — Bun, Node.js, and edge runtime packages with explicit capability
  boundaries.

These features have configuration and deployment requirements. Do not treat a memory
adapter or an omitted production setting as a durable default. Follow the
[production-readiness guide](https://lastshotlabs.github.io/slingshot/guides/production-readiness/)
before deploying.

## Package maturity

Slingshot publishes 44 public packages. Their category, stability, required npm channel,
and evidence gates come from the repository's versioned `package-maturity.json`; CI and
the publish workflow reject drift.

### Core

| Package                          | Purpose                                              |
| -------------------------------- | ---------------------------------------------------- |
| `@lastshotlabs/slingshot`        | App assembly, configuration, server lifecycle, CLI   |
| `@lastshotlabs/slingshot-core`   | Neutral contracts, context, events, transactions     |
| `@lastshotlabs/slingshot-entity` | Entity authoring, adapters, CRUD, migration planning |

### Production path

| Area                      | Packages                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Access and administration | `slingshot-admin`, `slingshot-organizations`, `slingshot-permissions`                                |
| Data and delivery         | `slingshot-assets`, `slingshot-postgres`, `slingshot-search`, `slingshot-webhooks`                   |
| Messaging                 | `slingshot-bullmq`, `slingshot-kafka`, `slingshot-mail`, `slingshot-notifications`, `slingshot-push` |
| Orchestration             | `slingshot-orchestration`, `-engine`, `-bullmq`, `-temporal`                                         |
| Rendering and runtimes    | `slingshot-ssg`, `slingshot-ssr`, `slingshot-runtime-bun`, `-node`, `-edge`                          |

Core and production-path packages are stable and use the `latest` dist-tag.

### Experimental

Authentication and identity packages currently use the `next` channel:

```bash
bun add \
  @lastshotlabs/slingshot-auth@next \
  @lastshotlabs/slingshot-oauth@next
```

`slingshot-auth`, `slingshot-m2m`, `slingshot-oauth`, `slingshot-oidc`, and
`slingshot-scim` emit a warning when their factory is used. Their APIs may change while
the identity surface is hardened.

### Deferred

Deferred packages remain published and independently pack-verified, but are not the
default production recommendation. They include AI, billing, community/chat features,
media and interaction helpers, the game engine, infrastructure helpers,
`slingshot-events`, and `slingshot-ssr-tanstack`.

Read the
[generated maturity table](https://lastshotlabs.github.io/slingshot/core-features/generated-maturity/)
before choosing a package. A package's version number alone is not its maturity claim.

## CLI

The package installs the `slingshot` executable.

```bash
slingshot init my-api          # scaffold an application
slingshot dev                  # run the development server
slingshot start                # boot app.config.ts
slingshot generate             # regenerate entity artifacts

slingshot migrate generate     # generate migrations
slingshot migrate plan         # inspect deterministic risk and approval plan
slingshot migrate apply        # apply pending migrations
slingshot migrate verify       # verify history, checksums, and plan invariants
slingshot migrate status       # report applied and pending migrations

slingshot events outbox status # inspect event delivery health
slingshot events outbox list   # list bounded operational projections
slingshot events outbox retry  # audited break-glass replay
slingshot infra check          # audit deployment infrastructure
slingshot secrets check        # validate required secrets
```

Run `slingshot <command> --help` for command-specific flags.

## Install only what you use

The root package provides the application framework and CLI. Feature packages and
provider SDKs are installed separately so an app controls its runtime surface.

```bash
# Durable PostgreSQL support
bun add @lastshotlabs/slingshot-postgres pg

# Permissions and organizations
bun add @lastshotlabs/slingshot-permissions @lastshotlabs/slingshot-organizations

# Durable jobs and workflows
bun add @lastshotlabs/slingshot-orchestration \
  @lastshotlabs/slingshot-orchestration-bullmq bullmq

# Node runtime
bun add @lastshotlabs/slingshot-runtime-node
```

See the complete
[installation matrix](https://lastshotlabs.github.io/slingshot/installation/) for optional
peers and provider packages.

## Published package surface

`@lastshotlabs/slingshot` publishes:

- the compiled framework and TypeScript declarations;
- the `slingshot` CLI and its command manifest;
- entry points for the default framework, `mongo`, `redis`, `queue`, and `testing`;
- this README, the license, and package metadata.

Repository examples and documentation sources are intentionally not part of the npm
tarball. Use the absolute links in this README when viewing it on npm.

## Documentation and support

- [Documentation](https://lastshotlabs.github.io/slingshot/)
- [Quick start](https://lastshotlabs.github.io/slingshot/quick-start/)
- [Examples](https://github.com/lastshotlabs/slingshot/tree/main/examples)
- [Release notes](https://github.com/lastshotlabs/slingshot/releases)
- [Issues](https://github.com/lastshotlabs/slingshot/issues)

## Contributing

Contributions should include focused tests, public API documentation, and any generated
evidence affected by the change. Run the relevant package tests during development and
`bun run hardening:core` before submitting broad framework changes.

## License

MIT
