---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-permissions
---

> Human-owned documentation. This package owns permission semantics, not route mounting.

## Purpose

`@lastshotlabs/slingshot-permissions` centralizes grant-based authorization for the workspace. It
exists so feature packages can share one model for subjects, grants, roles, tenant scope, and
resource-type definitions instead of each package inventing its own policy engine.

## Design Constraints

- This package is a library, not a `SlingshotPlugin`. It should stay composable so packages like
  admin, community, or organizations can consume permissions state without inheriting a route
  surface they did not ask for.
- The registry is intentionally immutable per resource type. Extending a domain should mean adding
  new resource types, not re-registering existing ones with extra actions.
- Deny must always win over allow in evaluation. That rule is an important security invariant and
  should not drift between adapters or helper wrappers.

## Operational Notes

- If permission checks look wrong, inspect the registry definitions first, then the stored grants,
  then group expansion through `groupResolver`. The evaluator is intentionally small.
- The evaluator now re-checks scope matching even after adapter reads. Treat adapter-side cascade
  filtering as the primary optimization, not the sole authorization boundary.
- When slingshot-auth is present, the built-in permissions wiring resolves group grants through the
  auth runtime's `getUserGroups()` surface. Group grants should therefore work in the default app
  bootstrap path, not only in custom evaluator setups.
- `seedSuperAdmin()` is the bootstrap helper for the all-powerful role; treat it as a provisioning
  concern and audit where it is called.
- Use the memory adapter for tests, not as an accidental production default.
- Redis is not a supported permissions store. Fail closed at startup instead of silently
  downgrading permissions state to process memory.
- Set `queryTimeoutMs` in `EvaluatorConfig` to bound adapter queries. Without a timeout a
  hung DB call blocks every permission check on that request indefinitely.
- `warnSampleRate` defaults to `0.01` (1%) so high-QPS production workloads do not flood logs
  with the large-group-batch and unscoped-resourceType warnings. Override to `1` in development
  or tests when you want to see every warning. Group-expansion failure warnings are sampled
  separately through `onGroupExpansionErrorSampleRate` (default `0.05`).
- `onGroupExpansionErrorSampleRate` controls how often the `onGroupExpansionError` callback fires
  and the corresponding `group_expansion_error` warn log emits. Health counters returned by
  `getHealth()` are updated on every failure regardless of sampling, so observability never lies.

## Gotchas

- Consumers often expect this package to "mount permissions". It does not. Another package has to
  expose admin routes or API surfaces that use the evaluator.
- Adapter query filtering already handles revoked and expired grants, but the evaluator also guards
  against stale grants passed from outside. That duplication is deliberate defense in depth.
- Resource ownership matters. If two packages want to act on the same resource namespace, that is
  an architecture discussion, not something the registry should silently allow.

## Key Files

- `src/lib/registry.ts`
- `src/lib/evaluator.ts`
- `src/lib/bootstrap.ts`
- `src/adapters/*`
- `src/testing.ts`
