---
'@lastshotlabs/slingshot-core': patch
'@lastshotlabs/slingshot-notifications': minor
---

Add an opt-in production adoption path that commits immediate notification
creation with an outbox event, consumes delivery through a stable transactional
inbox name, and forwards the event ID as the delivery-provider idempotency key.
