# Event reliability operator runbook

Slingshot event delivery is at least once. Never manually mark an outbox row
delivered and never edit `envelope_json`.

## Triage

1. Check `/health/ready` and the event-reliability dashboard.
2. Inspect `/admin/events/outbox/status`, then list a bounded set of `dead` or
   `pending` rows.
3. Inspect one event by stable event ID. Operator output is redacted; use
   request/correlation IDs to join against application logs.
4. Restore the broker or repair the consumer before replay.

## Replay

Use `POST /admin/events/outbox/:eventId/retry` with a JSON body containing a
bounded `reason`. Slingshot rechecks the row's optimistic version and validates
the immutable stored envelope against the current governed event definition.
Incompatible rows return `409` and are not changed.

Use `POST /admin/events/outbox/retry-dead` only after sampling individual rows.
The endpoint bounds the batch, validates every row independently, and reports
incompatible event IDs separately.

The CLI is break-glass tooling and requires the exact configured application
name through `--confirm`. Prefer the HTTP surface because it additionally
enforces permissions and writes the framework audit log.

## Retention

Delete only delivered outbox rows and processed inbox receipts older than the
approved retention threshold. Both delete endpoints require an ISO `before`
timestamp, a bounded batch size, actor identity, and a reason. Repeat bounded
batches while observing database load.

## Escalation

Stop replay when failures increase, the broker receipt reports no durable
destination, schema compatibility fails, or tenant/request scope looks wrong.
Preserve the event ID, operator audit rows, framework audit entries, and
correlated application logs for incident review.
