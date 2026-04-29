---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-runtime-edge
---

`@lastshotlabs/slingshot-runtime-edge` provides a `SlingshotRuntime` implementation for edge and worker
deployments. It swaps Bun or Node assumptions for Web Crypto, bundled file access, and explicit
runtime stubs where edge platforms do not support filesystem, SQLite, or `listen()`.

## When To Use It

Use this package when your app needs:

- deployment on Cloudflare Workers, Deno Deploy, or a comparable edge host
- a Slingshot runtime that does not assume local filesystem or native modules
- ISR cache storage backed by a KV namespace instead of process-local state

Do not use it when you need Bun or Node-only features such as local SQLite, filesystem writes, or a
process-managed HTTP listener.

## Minimum Setup

`edgeRuntime()` is valid with no arguments, but the most common option is `fileStore` so packages
such as SSR can read bundled assets or manifests.

You can also provide custom `hashPassword` and `verifyPassword`, but they must be supplied
together. If you omit them, the runtime uses PBKDF2-SHA256 via Web Crypto.

## What You Get

The runtime provides:

- password hashing and verification suitable for edge environments
- `readFile()` backed by your optional `fileStore`
- explicit stubs for unsupported features such as filesystem writes, glob scanning, SQLite, and
  `server.listen()`
- `supportsAsyncLocalStorage: false`, which downstream packages can use to disable ALS-dependent
  features safely
- `runtimeCapabilities()` for programmatic feature detection
- AbortController-based timeout support for `fileStore` and KV operations

The package also exports `createKvIsrCache()` for ISR storage on Cloudflare KV-compatible bindings.

## Common Customization

The key choices are:

- whether to supply `fileStore` for bundled asset access
- whether the default PBKDF2 implementation is acceptable for your auth posture
- whether your SSR deployment should use the KV ISR adapter

If you need to inspect behavior, start in:

- `src/index.ts` for the runtime contract and unsupported capability stubs
- `src/kv-isr.ts` for the Cloudflare KV ISR adapter

## Gotchas

- `supportsAsyncLocalStorage` is always `false`. Packages that rely on ALS features must degrade
  intentionally in edge deployments.
- `readFile()` returns `null` unless you provide `fileStore`.
- Password hashing defaults to PBKDF2-SHA256, not bcrypt or argon2. If your deployment requires a
  different algorithm, provide both custom password functions.
- The KV ISR adapter is eventually consistent because Cloudflare KV is eventually consistent. That
  is fine for many ISR workloads, but it is not strict transactional invalidation.

## Platform Limitations (vs Bun/Node)

The following limitations are inherent to edge runtimes (Cloudflare Workers, Deno Deploy, etc.)
and are **not implementation gaps**:

| Feature | Status | Workaround |
|---------|--------|------------|
| **Local filesystem** | Not available | Use `fileStore` backed by KV, R2, or `env.ASSETS.fetch()`. |
| **Filesystem writes** | Not available | Use an external storage service (KV, R2, S3, etc.). |
| **SQLite** | Not available | Use a cloud database (D1, PlanetScale, Neon) via its HTTP API. |
| **HTTP server (`listen()`)** | Not available | Export a `fetch` handler — the platform manages the HTTP lifecycle. |
| **Glob scanning** | Not available | Resolve routes at build time (e.g., via Vite/Rollup import.meta.glob). |
| **AsyncLocalStorage** | Not available | Pass context explicitly through function parameters. |
| **Process lifecycle (SIGTERM)** | Not available | Use platform hooks (`ctx.waitUntil` on Cloudflare Workers). |
| **Native modules (bcrypt, etc.)** | Not available | Use Web Crypto (PBKDF2-SHA256) or delegate to an external service. |
| **Socket/TCP** | Not available | Use HTTP-based APIs or WebSocket via platform primitives. |

## Programmatic Feature Detection

Use `runtimeCapabilities()` to detect what the edge platform supports at runtime:

```typescript
import { runtimeCapabilities } from '@lastshotlabs/slingshot-runtime-edge';

const caps = runtimeCapabilities();
if (!caps.filesystem.write) {
  // Use external storage
}
if (!caps.asyncLocalStorage) {
  // Use explicit context passing
}
```

The returned object is frozen and its boolean fields are typed as literal `false` or `true` so
TypeScript can narrow them correctly.

## Key Files

- `src/index.ts`
- `src/kv-isr.ts`
