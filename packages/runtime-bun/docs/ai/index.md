---
title: slingshot-runtime-bun
description: Bun runtime adapter for Slingshot — password, SQLite, fs, glob, HTTP server, WebSocket
---

## Capabilities

All implemented via Bun-native APIs (no external deps at runtime):

| Capability     | API                                                |
| -------------- | -------------------------------------------------- |
| Password       | `Bun.password.hash()` / `.verify()` — bcrypt       |
| SQLite         | `bun:sqlite` — CRUD, prepared statements, WAL mode |
| Filesystem     | `Bun.file()`, `Bun.write()` — streaming I/O        |
| Glob           | `new Bun.Glob().scan()`                            |
| Server         | `Bun.serve()` — HTTP + WebSocket                   |
| Process safety | SIGTERM/SIGINT handler with controlled fatal exit  |

## Runtime Contract

`bunRuntime(opts?)` returns `SlingshotRuntime`. The factory validates and freezes the returned
object. All capabilities are backed by Bun-native implementations — no polyfills or fallbacks.

## Operational Notes

- WebSocket lifecycle callbacks are individually try-caught — no single handler crash takes down the server
- `publish()` failures are caught and logged, never thrown
- Process safety net is idempotent and detects test environments
- Known Bun 1.3.11 bug: `stop(true)` never resolves after server-side `ws.close()` — handled via `BUN_STOP_GRACE_MS` race
- `password.verify()` returns false for malformed hashes instead of throwing

## Key Files

- `src/index.ts` — `bunRuntime()` factory, all capability implementations
- `src/errors.ts` — `BunRuntimeError`, `BunServerError`, `BunWebSocketError`, `BunSqliteError`, `BunPasswordError`
- `src/testing.ts` — `createTestServer()`, `resetProcessSafetyNetForTest()`
