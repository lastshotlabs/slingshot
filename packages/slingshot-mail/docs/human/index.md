---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-mail
---

> Human-owned documentation. This package should stay explicit about provider, renderer, and queue boundaries.

## Purpose

`@lastshotlabs/slingshot-mail` owns outbound mail delivery for Slingshot. It exists so packages can
emit events and let mail delivery happen through a dedicated provider, renderer, and queue layer
instead of embedding provider SDK calls throughout the codebase.

## Design Constraints

- The package should remain route-free. Mail is a side-effect system, so it should activate in
  `setupPost` and listen to the event bus rather than pretending to be an HTTP feature package.
- Provider, renderer, and queue are separate contracts on purpose. They should not collapse into
  one "mail adapter" abstraction because transport, templating, and buffering evolve on different
  timelines.
- The plugin should stay safe to boot in small apps. When no queue is provided, it falls back to
  an in-memory queue instead of forcing infrastructure on every consumer.

## Operational Notes

- `createMailPlugin()` validates provider and renderer shapes immediately and throws before startup
  if required methods are missing.
- Startup warnings about missing templates or failed provider health checks are diagnostics, not
  necessarily fatal errors. They usually mean the renderer inventory or external provider config
  needs attention.
- `setupPost()` should only run once for a given plugin instance. The package defends against
  double activation because queue startup and event subscriptions are stateful.
- The in-memory queue's `drain()` call has a default 30-second timeout. Configure it via
  `drainTimeoutMs` in the queue options (`0` to disable). A timeout warning is logged if jobs
  are still in flight when the deadline is reached — the timeout is soft; jobs are not cancelled.

## Gotchas

- The package does not export a shared `./testing` entrypoint. Tests live in the package itself and
  are organized around provider, queue, and lifecycle behavior.
- `from` is required even when a provider has account-level defaults. Slingshot keeps the outgoing
  message shape explicit.
- Durable subscriptions are a transport decision, not just a boolean preference. If the event bus
  is in-process only, durable mode should not be documented as if it were guaranteed.

## Key Files

- `src/plugin.ts`
- `src/lib/subscriptionWiring.ts`
- `src/types/config.ts`
- `src/providers/*`
- `src/queues/*`

## Provider Setup Examples

**Resend:**
```ts
import { createMailPlugin, createResendProvider } from '@lastshotlabs/slingshot-mail';

const mail = createMailPlugin({
  provider: createResendProvider({ apiKey: process.env.RESEND_API_KEY }),
  renderer: myRenderer,
  from: 'app@example.com',
});
```

**SendGrid:**
```ts
import { createSendGridProvider } from '@lastshotlabs/slingshot-mail';

const provider = createSendGridProvider({ apiKey: process.env.SENDGRID_API_KEY });
```

**AWS SES:**
```ts
import { createSesProvider } from '@lastshotlabs/slingshot-mail';

const provider = createSesProvider({ region: 'us-east-1' });
// Credentials resolved via the AWS SDK credential chain (env, IAM, etc.)
```

**Postmark:**
```ts
import { createPostmarkProvider } from '@lastshotlabs/slingshot-mail';

const provider = createPostmarkProvider({ serverToken: process.env.POSTMARK_SERVER_TOKEN });
```

All providers implement the same `MailProvider` contract — swap them without changing callers.
