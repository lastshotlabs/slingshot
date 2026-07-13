---
title: Notes
description: Working notes for @lastshotlabs/slingshot-ai
---

> Notes lane for rough ideas, investigation breadcrumbs, and hand-written reminders.

## Open questions

- **Prompt-cache minimum is a per-model fact, not a per-provider one.** It lives
  on `ProviderCapabilities.promptCacheMinTokens` today, which is right for
  Anthropic (4096 on Opus) but will need a per-model table if a provider ever
  varies it across its own models.
- **`estimateTokens` is chars/4.** Good enough for the pre-flight spend estimate
  and the cache-minimum guard, but it is an estimate. An adapter that implements
  `countTokens()` should be preferred where precision matters.
- **Response-cache coalescing is per-process.** Fine for a single home server;
  a multi-process deployment would want the shared store F4 adds.
