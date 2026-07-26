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

## Tool calling — breadcrumbs

- **Gemini has no tool-call id.** `functionCall` carries `{name, args}` only, and
  `functionResponse` is matched by function NAME. The adapter synthesizes
  `call_<part index>` so the neutral seam has an id to carry, and
  `AiToolResultPart.name` exists so the adapter has something to match on. Two
  concurrent calls to the SAME tool in one turn are indistinguishable on that
  wire — Gemini's limitation, documented rather than papered over.
- **Gemini's `parameters` rejects `additionalProperties`**, while
  `sanitizeJsonSchema` adds `additionalProperties: false` to every object node
  because the strict providers require it. Directly opposed requirements, so the
  strip lives in `gemini.ts` rather than weakening the shared sanitizer.
- **`finish_reason: 'stop'` with populated `tool_calls`** is real, and common on
  local servers. Every adapter normalizes to `stopReason: 'tool_use'` when tool
  calls are present. Without it the loop silently stops one iteration early —
  green tests, no error, an answer that just isn't grounded.
- **`AiTool.execute` is declared as a METHOD, not a `readonly` property.** Under
  `strictFunctionTypes` a property-style function is contravariant in its
  argument, so `AiTool<{lift: string}>` would not be assignable to
  `AiTool<unknown>` and `readonly AiTool[]` could not be built without an `any`
  (engineering rule #4 forbids one). Method-shorthand declarations are checked
  bivariantly. If someone "tidies" this into a property, every consumer's tool
  array stops compiling.
- **Not yet supported:** tools on `generateStructured` (throws, deliberately —
  see `CLAUDE.md`), and a tool result carrying an image part. The latter is a
  real vendor feature (Anthropic accepts image blocks in `tool_result`) and would
  slot in as a change to `toolResultBody` plus a per-adapter render.
