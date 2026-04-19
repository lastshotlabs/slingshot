---
title: Postgres Operations
description: Operational runbook notes for production Postgres deployments
---

This note captures the production contract for the Postgres path after the runtime hardening work.
The codebase now supports explicit pool sizing, dependency-aware readiness, Postgres metrics, and
externally managed migrations. The remaining enterprise work is operational execution.

## Startup Policy

- Use `db.postgresMigrations: 'apply'` only when this service owns schema bootstrap for the target
  environment.
- Use `db.postgresMigrations: 'assume-ready'` in shared, staged, or tightly controlled production
  environments where migrations are applied before rollout.
- When `assume-ready` is enabled, framework/auth/permissions startup DDL is skipped. A rollout that
  forgets the migration step should fail in readiness and application behavior rather than silently
  mutating schema at boot.

## Pool Policy

- Size the pool with `db.postgresPool` instead of relying on implicit pg defaults.
- Set `max` from measured concurrency and database connection limits, not from CPU count alone.
- Set both `queryTimeoutMs` and `statementTimeoutMs` so stuck queries fail fast enough to surface in
  readiness and metrics before the service saturates.
- Revisit pool sizing after load tests, failover drills, and traffic shifts. The correct value is an
  operational measurement, not a framework constant.

## Observability Contract

- `/health` remains liveness-only and dependency-free.
- `/health/ready` now includes Postgres readiness when Postgres is configured.
- `/metrics` now exposes:
  - `slingshot_postgres_pool_clients`
  - `slingshot_postgres_query_count`
  - `slingshot_postgres_query_latency_ms`
  - `slingshot_postgres_migration_mode`
- Production should alert on repeated readiness failures, sustained waiting clients, elevated failed
  query counts, and latency growth.

## Backup And Restore

- Run logical backups on a schedule that matches RPO requirements.
- Periodically restore those backups into an isolated environment and verify:
  - application startup with `db.postgresMigrations: 'assume-ready'`
  - `/health/ready` returns `200`
  - auth/session reads succeed
  - `/metrics` shows Postgres gauges after traffic
- Treat an untested backup as missing backup coverage.

## Failover

- Run a planned failover drill before declaring the environment production-ready.
- During the drill verify:
  - readiness turns unhealthy during the fault window
  - the service recovers without manual schema bootstrap
  - connection pools recover cleanly after the primary changes
  - query failure counts and latency spikes are visible in metrics/logs

## Capacity Smoke

- Use `scripts/postgres-capacity-smoke.ts` for a quick direct-DB smoke test before heavier load
  testing.
- Example:

```bash
POSTGRES_URL=postgresql://user:pass@host:5432/db \
PG_SMOKE_CONCURRENCY=32 \
PG_SMOKE_ITERATIONS=250 \
bun scripts/postgres-capacity-smoke.ts
```

- Treat the script as a guardrail, not a substitute for full production-like traffic tests.
