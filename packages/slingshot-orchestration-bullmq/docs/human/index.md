---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-orchestration-bullmq
---

This package provides a BullMQ-backed adapter for `@lastshotlabs/slingshot-orchestration`.

Use it when you want:

- durable task and workflow execution
- Redis-backed queues and retries
- progress updates through BullMQ `QueueEvents`
- repeatable schedules without a separate scheduler service

## What it adds

- `createBullMQOrchestrationAdapter()` as the Redis-backed orchestration provider
- queue-per-task support through `TaskDefinition.queue`
- BullMQ worker processors for tasks and workflows
- scheduling support through BullMQ repeatable jobs

## Current capability profile

- Core execution: yes
- Scheduling: yes
- Observability: yes
- Progress subscriptions: yes
- Signals: no

## Provider boundary

This package depends on the portable orchestration core but not on Slingshot plugin helpers.

Typical composition:

1. Define tasks and workflows in `@lastshotlabs/slingshot-orchestration`
2. Create the BullMQ adapter in this package
3. Pass that adapter into `createOrchestrationRuntime()` or `createOrchestrationPlugin()`

Lifecycle notes:

- `createOrchestrationPlugin()` starts and stops the adapter for you
- direct `createOrchestrationRuntime()` usage now lazy-starts the adapter on first use
- step-level retry and timeout overrides are carried into BullMQ child jobs so workflow behavior
  stays aligned with the portable runtime contract
- workflow hook failures emit the portable `orchestration.workflow.hookError` event when an
  event sink is configured, and otherwise fall back to `console.error`
- progress subscriptions are safe to register and unregister even while the adapter is still
  lazily starting
