---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-runtime-lambda
---

> Human-owned documentation. This page covers the package boundary, trigger behavior, and the manifest-driven Lambda path.

## Purpose

`@lastshotlabs/slingshot-runtime-lambda` is the AWS Lambda host adapter for `SlingshotHandler`.
It lets the same handler contract power API Gateway routes, queues, streams, and scheduled jobs
without forking application logic by transport.

## Package Boundaries

This package owns:

- cold-start bootstrap through the shared manifest pipeline
- warm invocation reuse
- trigger-specific request extraction and response assembly
- record-level idempotency for natural-key-based event sources
- manifest-driven Lambda export wiring via `createFunctionsFromManifest()`

It should not own framework assembly rules that belong in `@lastshotlabs/slingshot`, and it should
not widen core contracts for AWS-only behavior unless that behavior is required by more than one host.

## Two Usage Modes

### Direct runtime wrapping

Use `createLambdaRuntime()` when your Lambda entry module wires handlers explicitly:

```ts
import type { SlingshotHandler } from '@lastshotlabs/slingshot-core';
import { createLambdaRuntime } from '@lastshotlabs/slingshot-runtime-lambda';

declare const processOrder: SlingshotHandler;

const lambda = createLambdaRuntime({
  manifest: './app.manifest.json',
});

export const queue = lambda.wrap(processOrder, 'sqs');
export const api = lambda.wrap(processOrder, 'apigw-v2');
```

### Manifest-driven exports

Use `createFunctionsFromManifest()` when the manifest is the single source of truth for function
bindings. The `lambdas` section is validated by the root manifest schema, ignored by
`createServerFromManifest()`, and consumed here instead.

## Trigger Matrix

- HTTP: `apigw`, `apigw-v2`, `function-url`, `alb`
- Queues and streams: `sqs`, `msk`, `kinesis`, `dynamodb-streams`
- Events: `s3`, `sns`, `eventbridge`, `schedule`

Each adapter is responsible for:

- extracting one or more records
- deriving request and correlation metadata
- exposing natural idempotency keys where the source provides them
- assembling the provider-native response shape after all records are processed

## Operational Notes

- Cold start uses `resolveManifestConfig()` and `createApp()` without binding a port.
- Warm invocations reuse the cached app context until `shutdown()` or process termination.
- `onShutdown` is best-effort only. On Lambda it races a short timeout after `SIGTERM`.
- SQS supports partial batch failure responses. Whole-batch retry sources rethrow unless hooks suppress or drop the failure.

## Review Heuristics

- If a change affects more than one trigger kind, first check whether it belongs in `invocationLoop.ts` instead of an adapter.
- If an adapter needs host-specific parsing or metadata extraction, keep that logic local to the trigger file.
- If a new cloud provider can reuse the contract but not the implementation, move only the shared shape into `slingshot-core`.
