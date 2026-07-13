---
title: AI Draft
description: AI-assisted starting point for @lastshotlabs/slingshot-ai
---

> AI-assisted draft. Use this page for fast orientation, then harden important details in the human guide.

## Summary

Provider-neutral AI generation. `createAiPackage({ providers, defaultProvider })`
publishes `AiClientCap` (generate / generateStructured / stream), `AiModerationCap`
(safety verdicts), and `AiUsageCap` (usage, cost, spend).

## Orientation

- `src/provider/types.ts` — the seam. Read this first to add an adapter.
- `src/lib/client.ts` — the orchestrator. All policy lives here.
- `src/lib/structured.ts` — zod → JSON Schema, extraction, the repair loop.
- `src/testing.ts` — the fake provider and the conformance suite.
