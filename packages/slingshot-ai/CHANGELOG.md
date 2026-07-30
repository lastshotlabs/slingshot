# @lastshotlabs/slingshot-ai

## 0.4.8

### Patch Changes

- Updated dependencies [0c13b2b]
  - @lastshotlabs/slingshot-core@0.6.2
  - @lastshotlabs/slingshot-entity@0.5.2
  - @lastshotlabs/slingshot-orchestration@0.2.10
  - @lastshotlabs/slingshot-orchestration-engine@0.2.10

## 0.4.7

### Patch Changes

- Updated dependencies [2e32296]
- Updated dependencies [0696379]
  - @lastshotlabs/slingshot-entity@0.5.1
  - @lastshotlabs/slingshot-core@0.6.1
  - @lastshotlabs/slingshot-orchestration-engine@0.2.9
  - @lastshotlabs/slingshot-orchestration@0.2.9

## 0.4.6

### Patch Changes

- Updated dependencies [d46d7aa]
- Updated dependencies [4487f74]
- Updated dependencies [0cd383b]
- Updated dependencies [2178930]
  - @lastshotlabs/slingshot-core@0.6.0
  - @lastshotlabs/slingshot-entity@0.5.0
  - @lastshotlabs/slingshot-orchestration@0.2.8
  - @lastshotlabs/slingshot-orchestration-engine@0.2.8

## 0.4.5

### Patch Changes

- Updated dependencies [e758f4e]
- Updated dependencies [9bb9c77]
- Updated dependencies [60a6f36]
- Updated dependencies [935b839]
  - @lastshotlabs/slingshot-core@0.5.0
  - @lastshotlabs/slingshot-entity@0.4.1
  - @lastshotlabs/slingshot-orchestration@0.2.7
  - @lastshotlabs/slingshot-orchestration-engine@0.2.7

## 0.4.4

### Patch Changes

- Updated dependencies [fd0069d]
- Updated dependencies [d3effc1]
  - @lastshotlabs/slingshot-core@0.4.0
  - @lastshotlabs/slingshot-entity@0.4.0
  - @lastshotlabs/slingshot-orchestration@0.2.6
  - @lastshotlabs/slingshot-orchestration-engine@0.2.6

## 0.4.3

### Patch Changes

- 50456ec: Fail closed when AI moderation policies are configured but a generation request accidentally
  omits moderation, with an optional default policy for configure-once enforcement.

  Reconcile changed SQLite and PostgreSQL entity indexes during runtime bootstrap, quote PostgreSQL
  CRUD column identifiers, and correct the `routes.disable` authoring contract documentation.

- Updated dependencies [50456ec]
  - @lastshotlabs/slingshot-core@0.3.1
  - @lastshotlabs/slingshot-entity@0.3.1
  - @lastshotlabs/slingshot-orchestration@0.2.5
  - @lastshotlabs/slingshot-orchestration-engine@0.2.5

## 0.4.2

### Patch Changes

- Updated dependencies [0f42569]
- Updated dependencies [ec8a199]
- Updated dependencies [79dae42]
  - @lastshotlabs/slingshot-core@0.3.0
  - @lastshotlabs/slingshot-entity@0.3.0
  - @lastshotlabs/slingshot-orchestration@0.2.4
  - @lastshotlabs/slingshot-orchestration-engine@0.2.4

## 0.4.1

### Patch Changes

- 7f2fefe: Verify every published tarball in a clean consumer and preserve package imports during build.
- Updated dependencies [7f2fefe]
  - @lastshotlabs/slingshot-core@0.2.4
  - @lastshotlabs/slingshot-entity@0.2.8
  - @lastshotlabs/slingshot-orchestration@0.2.3
  - @lastshotlabs/slingshot-orchestration-engine@0.2.3

## 0.4.0

### Minor Changes

- Tool calling. `AiRequestBase` gains `tools`, `toolChoice` and
  `maxToolIterations`; `AiResult` gains `toolCalls` and `iterations`. `execute`
  lives on the tool, so the orchestrator owns the loop — argument validation,
  the iteration cap, and spend re-entry on every iteration.
- `AiContentPart` gains `tool_call` and `tool_result` variants rather than new
  message roles, so `messageContentUnits` and the image rules are unchanged. A
  `tool_result` part rides a `user` turn, which is where OpenAI's `role: 'tool'`
  and Anthropic's `tool_result` block both normalize to.
- `AiStreamEvent` gains `tool_call_delta` (raw, live, advisory) and `tool_call`
  (validated, the one an app may act on), plus `tool_result`.
  `ProviderStreamEvent` gains `tool_call`.
- Tool support across `openaiCompatible` (DeepSeek, OpenAI, Grok, Ollama, vLLM,
  LM Studio, OpenRouter, Groq, Together), Anthropic and Gemini. A provider
  declaring `toolUse: false` that is handed tools throws rather than silently
  dropping them.
- Exhaustive `switch` statements with a `never` check over `AiContentPart`,
  `AiStreamEvent` or `ProviderStreamEvent` will stop compiling. Anything that
  only reads results is unaffected.

## 0.3.4

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.6

## 0.3.3

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-entity@0.2.5

## 0.3.2

### Patch Changes

- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.3
  - @lastshotlabs/slingshot-entity@0.2.3
  - @lastshotlabs/slingshot-orchestration@0.2.2
  - @lastshotlabs/slingshot-orchestration-engine@0.2.2

## 0.3.1

### Patch Changes

- Republish the framework from current HEAD so consumers install current source
  (e.g. game-engine applyStagedRules/sessionRoom) rather than stale dist. Registry-sync release, no intended API changes.
- Updated dependencies
  - @lastshotlabs/slingshot-core@0.2.1
  - @lastshotlabs/slingshot-entity@0.2.1
  - @lastshotlabs/slingshot-orchestration@0.2.1
  - @lastshotlabs/slingshot-orchestration-engine@0.2.1

## 0.3.0

### Minor Changes

- Add provider-neutral inline image messages, a built-in Gemini transport, durable
  request-scoped spend reservations, and truly incremental OpenAI-compatible
  streaming.

## 0.2.0 (unreleased)

Initial implementation.

- Package scaffold, `createAiPackage()`, and the three capabilities
  (`AiClientCap`, `AiModerationCap`, `AiUsageCap`).
- Provider seam (`AiProvider`, `ProviderCapabilities`, `NormalizedRequest`,
  `ProviderResult`) plus the built-in provider registry and escape hatches.
- `runProviderConformanceSuite()` — the contract every adapter must pass — and
  `createFakeAiProvider()` / `scriptedModerator()` for hermetic app tests.
- Orchestrator: capability negotiation with explicit degradation accounting,
  pre-flight spend guard, response cache, refusal detection, usage + metrics.
- Structured output on any provider: native, json-mode, and prompt-instructed,
  with a single validation point and a bounded parse-and-repair loop.
- Prompt-cache detectors: minimum-prefix guard, stable-prefix drift warnings,
  and zero-hit reporting.

Not yet implemented: the Anthropic and openai-compatible adapters; persisted
usage; the LLM-backed moderator (moderation currently fails closed); redis and
postgres response caches; `slingshot-orchestration` integration for background
generation.
