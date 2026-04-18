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

## Key Files

- `src/index.ts`
- `src/kv-isr.ts`
