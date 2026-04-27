---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-runtime-node
---

`@lastshotlabs/slingshot-runtime-node` is the Node.js runtime implementation for Slingshot.
Pass the return value of `nodeRuntime()` to `createServer()` as the `runtime` option.

## What It Provides

- **password** — `argon2` (peer dep) for argon2id hashing and constant-time verification
- **sqlite** — `better-sqlite3` (peer dep) opened in WAL mode with synchronous API
- **server** — `@hono/node-server` (peer dep) wrapping Node `http.Server`; TLS via `opts.tls`; WebSocket via `ws` peer dep
- **fs** — `node:fs/promises` with ENOENT-safe `readFile` and `access`-based `exists`
- **glob** — `fast-glob` (peer dep) with `dot: false` by default

## Minimum Setup

```ts
import { createServer } from '@lastshotlabs/slingshot-core';
import { nodeRuntime } from '@lastshotlabs/slingshot-runtime-node';

const server = await createServer({ runtime: nodeRuntime(), ...config });
```

## Peer Dependencies

All peer deps are loaded lazily via dynamic `import()` at first use, not at module import time.
Missing deps surface at the first call to the affected capability.

| Capability | Peer dep            |
| ---------- | ------------------- |
| password   | `argon2`            |
| sqlite     | `better-sqlite3`    |
| server     | `@hono/node-server` |
| websocket  | `ws`                |
| glob       | `fast-glob`         |

## Operational Notes

- `readFile()` returns `null` on `ENOENT`. All other errors (`EACCES`, `EISDIR`, etc.) are
  re-thrown — they are not silently swallowed. `fs.exists()` uses `fs.access` and returns
  `false` for any error, including permission errors, so it does not distinguish ENOENT from
  EACCES.
- SQLite databases are opened in WAL mode (`PRAGMA journal_mode = WAL`). Run your application's
  migration step before any reads or writes. The runtime does not run migrations itself.
- `better-sqlite3` is a native CJS addon and is loaded via `createRequire` (not dynamic
  `import()`) so it works correctly in Node ESM where bare `require` is unavailable.
- `password.hash()` defaults to argon2id. The hash output includes the algorithm identifier so
  it is forward-compatible if the algorithm default changes.
- WebSocket upgrade uses a pending-upgrade map keyed by `sec-websocket-key`. Upgrades that are
  not completed within 30 s have their socket destroyed automatically.
- `server.publish(channel, message)` broadcasts only to open (`readyState === 1`) sockets; closed
  sockets in a channel are silently skipped.
- TLS is supported via `opts.tls.key` and `opts.tls.cert`. Pass PEM strings or `Buffer` values.

## Gotchas

- `connection.port` must be a number, not a string. Env-var values need explicit coercion:
  `port: Number(process.env.PORT)`.
- `glob.scan()` returns paths relative to `cwd`, not absolute. Join with `cwd` when you need
  absolute paths for subsequent file operations.
- `stop(true)` calls `server.closeAllConnections()` (Node 18.2+ API) to force-close active
  connections. Pass `false` (or no argument) if you want graceful drain.
- `argon2.verify()` returns `false` rather than throwing for malformed hash strings.

## Key Files

- `src/index.ts`
