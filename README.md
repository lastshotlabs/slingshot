# Slingshot

Config-driven backend framework built on Hono. Plugin-driven, TypeScript-first.

## What it is

Slingshot is a backend framework built on Hono with runtime adapters for Bun and Node. Declare plugins, databases, and security in a typed `app.config.ts`, then run `slingshot start`.

## Quickstart

```bash
bun add @lastshotlabs/slingshot
```

### App Config

Create `app.config.ts`:

```typescript
import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';

export default defineApp({
  port: 3000,
  security: { signing: { secret: process.env.JWT_SECRET! } },
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
  ],
});
```

```bash
slingshot start
```

### Lower-Level API

```typescript
import { createServer } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
import { createCommunityPlugin } from '@lastshotlabs/slingshot-community';

await createServer({
  port: 3000,
  security: { signing: { secret: process.env.SECRET! } },
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
    createCommunityPlugin({ containerCreation: 'user' }),
  ],
});
```

`defineApp()` and `createServer()` use the same runtime config shape; `defineApp()` is the CLI-friendly authoring path.

## Features

- **Identity & Access** — auth, permissions, organizations, OAuth, OIDC, SCIM, M2M
- **Community & Realtime** — community (forums), chat, notifications, push, polls
- **Content & Media** — assets, image optimization, emoji, embeds, GIFs, deep links
- **Infrastructure** — search, webhooks, interactions, mail, admin, infra
- **Rendering** — SSR, SSG with runtime adapters (Bun, Node)
- **Data** — config-driven entities, code generation, Postgres adapter, BullMQ adapter
- **Game Engine** — multiplayer game runtime with phases, turns, scoring, channels

## Examples

See [`examples/`](examples/) for complete working apps:

- **collaboration-workspace** — 12-plugin community workspace
- **with-auth** — Minimal auth setup
- **config-driven-domain** — Entity definitions with operations (code mode)
- **content-platform** — Content management with assets (code mode)
- **game-engine** — Multiplayer game runtime (code mode)

## Documentation

Full documentation lives in [`packages/docs/`](packages/docs/).

## Project status

Pre-production. API may change. No external consumers yet.
