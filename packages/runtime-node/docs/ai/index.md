---
title: slingshot-runtime-node
description: Node.js runtime adapter for Slingshot — password, SQLite, fs, glob, HTTP server, WebSocket
---

## Capabilities

| Capability | API |
|---|---|
| Password | `bcryptjs` (bundled) — hash + verify |
| SQLite | `better-sqlite3` (peer dep, lazy loaded) — CRUD, WAL, transactions |
| Filesystem | `node:fs` — sync read/write/exists |
| Glob | `tinyglobby` (peer dep) — async scan |
| Server | `@hono/node-server` — HTTP + WebSocket via `ws` |
| Process safety | `uncaughtException` + controlled exit |

## Runtime Contract

`nodeRuntime(opts?)` returns `SlingshotRuntime`. All peer dependencies are lazy-loaded via
dynamic `import()` or `createRequire` — missing deps surface at use-time, not at import time.

## Operational Notes

- WebSocket upgrade has configurable timeout (default 30s) with socket destruction on timeout
- Per-upgrade promise chain prevents timer/socket double-free
- Idle-timeout uses `terminate()` (not `close()`) for unresponsive peers
- `stop()` supports three modes: graceful, forced, and timeout-bounded drain
- Fetch error callback is doubly guarded — throw falls back to `uncaughtException`
- Request body size enforcement at two levels: Content-Length header and streaming accumulation
- Channel cleanup removes stale sockets on both `close` and `error` events

## Key Files

- `src/index.ts` — `nodeRuntime()` factory, all capability implementations
- `src/errors.ts` — `NodeRuntimeError`, `NodeServerError`, `NodeWebSocketError`, `NodeContentLengthError`, `NodeRequestBodyTooLargeError`, `NodeShutdownError`
- `src/testing.ts` — `createTestServer()`, `runtimeNodeInternals`
