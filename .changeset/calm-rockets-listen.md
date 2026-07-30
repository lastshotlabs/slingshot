---
'@lastshotlabs/slingshot': patch
'@lastshotlabs/slingshot-core': patch
'@lastshotlabs/slingshot-entity': patch
'@lastshotlabs/slingshot-ai': patch
'@lastshotlabs/slingshot-auth': patch
'@lastshotlabs/slingshot-bullmq': patch
'@lastshotlabs/slingshot-mail': patch
'@lastshotlabs/slingshot-orchestration-bullmq': patch
'@lastshotlabs/slingshot-webhooks': patch
---

Add trusted soft-delete list visibility, deterministic AI result fixtures, and BullMQ 6 support.

Entity adapters now accept `includeDeleted` consistently across all five stores without exposing
the option through generated public list routes. AI consumer tests can build complete results with
`makeAiResult`. BullMQ-backed event and orchestration adapters now support BullMQ 6 connection
lifecycle, scheduler, job-id, and Redis-client APIs.
