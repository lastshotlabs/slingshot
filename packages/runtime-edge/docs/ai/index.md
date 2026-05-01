---
title: slingshot-runtime-edge
description: Edge runtime adapter for Slingshot — Web Crypto password, KV ISR, file reads via fetch
---

## Capabilities

| Capability | API |
|---|---|
| Password | Web Crypto PBKDF2 — two-format parser supporting legacy hashes |
| SQLite | Stub — throws `EdgeUnsupportedError` |
| Server | Stub — throws `EdgeUnsupportedError` |
| Filesystem | Read-only via `fileStore` (fetch-based) — three-layer cap enforcement |
| Glob | Stub — throws `EdgeUnsupportedError` |
| KV ISR | `kv-isr.ts` — Cloudflare Workers KV-backed ISR adapter |

## Runtime Contract

`edgeRuntime(opts?)` returns `SlingshotRuntime` (frozen). Unsupported capabilities throw
descriptive `EdgeUnsupportedError` rather than failing silently. `runtimeCapabilities()`
provides programmatic introspection.

## Edge-specific Details

- `readFile()` enforces size caps at three layers: declared size, streaming accumulation, post-buffer
- File store timeout uses `AbortController` for proper cancellation
- Password verification uses constant-time comparison
- `EdgePasswordConfigError` thrown eagerly when only one of `hashPassword`/`verifyPassword` is provided
- `KvNamespace` is structurally typed — `@cloudflare/workers-types` is not a dependency
- KV ISR: concurrency-limited fan-out, per-tag serialization locks, bounded memory

## Key Files

- `src/index.ts` — `edgeRuntime()` factory, all capability implementations
- `src/kv-isr.ts` — KV-backed ISR cache adapter
- `src/errors.ts` — `EdgeRuntimeError`, `EdgeUnsupportedError`, `EdgeFileReadError`, `EdgeFileSizeExceededError`, `EdgePasswordConfigError`
- `src/lib/withAbortTimeout.ts` — AbortController-based timeout utility
- `src/testing.ts` — `TEST_EDGE_TIMEOUT_MS`, `TEST_MAX_FILE_BYTES`
