---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-runtime-bun
---

`@lastshotlabs/slingshot-runtime-bun` is the Bun-native runtime implementation for Slingshot.
Pass the return value of `bunRuntime()` to `defineApp({ runtime })` in your `app.config.ts`.

## What It Provides

- **password** — `Bun.password.hash()` / `Bun.password.verify()` (argon2id by default)
- **sqlite** — `bun:sqlite` Database opened in WAL mode with `create: true`
- **server** — `Bun.serve` HTTP server with WebSocket upgrade support
- **fs** — `Bun.write` and `Bun.file` for async binary and text file I/O
- **glob** — `Bun.Glob` for file pattern scanning

## Minimum Setup

```ts title="app.config.ts"
import { defineApp } from '@lastshotlabs/slingshot';
import { bunRuntime } from '@lastshotlabs/slingshot-runtime-bun';

export default defineApp({
  runtime: bunRuntime(),
  port: 3000,
});
```

In practice, Bun is auto-detected — you only pass `bunRuntime()` explicitly if you need
to customize behavior or override the auto-detection.

## Operational Notes

- `readFile()` uses `Bun.file(path).exists()` before reading. Missing files return `null`;
  errors on files that do exist (e.g. permission denied) propagate as exceptions.
- `fs.readFile()` uses the same `exists()` check and returns `null` for missing binary files.
- `password.hash()` defaults to argon2id. The hash output is self-describing and includes the
  algorithm identifier, so it is forward-compatible if the algorithm default changes.
- SQLite databases are opened in WAL mode. Set up your application's migration step before any
  reads or writes. The runtime does not run migrations itself.
- WebSocket upgrade is delegated to `Bun.serve`. Call `server.upgrade(req, { data })` from
  inside a `fetch` handler — Bun returns `undefined` from `fetch` when the upgrade succeeds.

## Gotchas

- `connection.port` must be a number, not a string. Env-var values need explicit coercion:
  `port: Number(process.env.PORT)`.
- `glob.scan()` returns paths relative to `cwd`, not absolute. Join with `cwd` when you need
  absolute paths for subsequent file operations.
- `server.stop(true)` closes open connections immediately. Pass `false` (or no argument) if
  you want graceful drain.

## Capability Reporting

Use `runtimeCapabilities()` to programmatically discover what the Bun runtime platform supports:

```ts
import { runtimeCapabilities } from '@lastshotlabs/slingshot-runtime-bun';

const caps = runtimeCapabilities();
// => {
//   runtime: 'bun',
//   filesystem: { read: true, write: true },
//   sqlite: true,
//   httpServer: true,
//   glob: true,
//   asyncLocalStorage: true,
//   passwordHashing: 'bun-argon2',
//   webSocket: true,
// }
```

All boolean capabilities are `true` because Bun provides every runtime primitive
natively. The returned object is frozen so consumers can rely on the values never
changing during the lifetime of the process.

## Key Files

- `src/index.ts`
