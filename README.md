# Slingshot

Config-driven backend framework built on Hono. Plugin-driven, manifest-first.

## What it is

Slingshot is a backend framework built on Hono with runtime adapters for Bun, Node, and Edge. Declare plugins, databases, and security in a JSON manifest — run `slingshot start`. Zero code for built-in plugins; export functions from `slingshot.handlers.ts` for custom logic.

## Quickstart

```bash
bun add @lastshotlabs/slingshot
```

Create `app.manifest.json`:

```json
{
  "manifestVersion": 1,
  "port": 3000,
  "security": {
    "signing": { "secret": "${secret:JWT_SECRET}" }
  },
  "plugins": [
    {
      "plugin": "slingshot-auth",
      "config": {
        "auth": { "roles": ["user", "admin"], "defaultRole": "user" },
        "db": { "auth": "memory", "sessions": "memory", "oauthState": "memory" }
      }
    }
  ]
}
```

```bash
slingshot start
```

For custom behavior (middleware, event handlers, tenant resolvers), export named functions from `slingshot.handlers.ts`. The manifest references them by name.

## Features

- **Identity & Access** — auth, permissions, organizations, OAuth, OIDC, SCIM, M2M
- **Community & Realtime** — community (forums), chat, notifications, push, polls
- **Content & Media** — assets, image optimization, emoji, embeds, GIFs, deep links
- **Infrastructure** — search, webhooks, interactions, mail, admin, infra
- **Rendering** — SSR, SSG with runtime adapters (Bun, Node, Edge)
- **Data** — config-driven entities, code generation, Postgres adapter, BullMQ adapter
- **Game Engine** — multiplayer game runtime with phases, turns, scoring, channels

## Examples

See [`examples/`](examples/) for complete working apps:

- **collaboration-workspace** — 12-plugin community workspace (manifest + code modes)
- **with-auth** — Minimal auth setup (manifest mode)
- **config-driven-domain** — Entity definitions with operations (code mode)
- **content-platform** — Content management with assets (code mode)
- **game-engine** — Multiplayer game runtime (code mode)

## Documentation

Full documentation lives in [`packages/docs/`](packages/docs/).

## Project status

Pre-production. API may change. No external consumers yet.
