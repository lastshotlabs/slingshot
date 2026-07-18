# @lastshotlabs/slingshot-ai

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
