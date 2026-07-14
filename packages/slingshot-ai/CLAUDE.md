# slingshot-ai — agent notes

Provider-neutral AI generation. Read `README.md` first; this file is the stuff
that will bite you.

## Architecture in one line

Providers are **dumb transports**; all policy (validation, cost, retry, spend,
moderation, degradation) lives in the orchestrator (`src/lib/client.ts`).

## Invariants — do not break these

1. **`ProviderResult.structured` is ADVISORY.** The orchestrator re-validates
   with `schema.safeParse()` for _every_ provider, including "native" ones.
   Anthropic can return `parsed_output: null`; an OpenAI-compatible endpoint can
   claim schema enforcement it doesn't have. One validation point is the whole
   reason provider-swapping works. Never trust `structured` and skip the parse.

2. **Every retry and every repair attempt re-enters the spend guard.** A retry
   storm and a repair loop are the two shapes an accidental bill takes. The
   guard is pre-flight (`spend.check()` _before_ the HTTP call), because a
   post-hoc check only tells you about the runaway loop after it has finished
   spending.

3. **Nothing degrades silently.** Anything the provider can't honor becomes an
   `AiDegradation` on the result. `degradations.length === 0` must continue to
   mean "everything you asked for was honored", or apps that assert on it are
   being lied to.

4. **`costUsd: null` ≠ `costUsd: 0`.** Unknown is not free. This distinction has
   to survive aggregation (`AiUsageSummary.unpricedCalls`).

4b. **`ProviderUsage`'s four token counts are DISJOINT.** `computeUsage()` bills
them additively, so `inputTokens` MUST exclude cache reads and writes. The
vendors disagree about this and the disagreement is silent:

    - Anthropic reports disjoint counts natively (`input_tokens` excludes
      `cache_read_input_tokens`) — which is why the additive formula was written.
    - The OpenAI family reports `prompt_tokens` as a TOTAL, with
      `prompt_tokens_details.cached_tokens` as a SUBSET of it. The adapter must
      **subtract**. It didn't, and every cached token was billed twice.
    - DeepSeek reports an already-disjoint `prompt_cache_hit_tokens` /
      `prompt_cache_miss_tokens` split at the top level of `usage` — a different
      shape again, and reading it with the generic mapper reports zero cache hits
      and bills everything at the cache-MISS rate. On DeepSeek that is a **50×**
      overstatement, on the provider you picked *because* it is cheap.

Hence `Preset.mapUsage`. A new adapter's first question is "what exactly does
this vendor mean by its input-token count", and the answer is never assumed.
`tests/unit/usageDisjoint.test.ts` pins it for the whole family.

4c. **`outputTokens` INCLUDES reasoning tokens — and the vendors disagree about
whether `completion_tokens` already does.** Same field name, opposite meanings,
measured live:

    - **xAI**  `completion_tokens` EXCLUDES reasoning. `prompt 215 + completion 5
      + reasoning 41 = total 261`. Billing `completion_tokens` charged 5 of the 46
      output tokens actually produced — an **~89% undercount**, invisible to the
      pre-flight spend guard.
    - **DeepSeek / OpenAI** `completion_tokens` INCLUDES reasoning. Adding it
      would DOUBLE-count.

There is no global rule, only a per-vendor one. There is deliberately **no
separate `reasoningTokens` billing field**: a fifth number already contained in a
fourth is exactly the trap that produced this whole bug class. The raw split stays
on `ProviderResult.raw`. `tests/unit/reasoningTokensAndCost.test.ts` pins all
three vendors' REAL captured payloads.

4d. **`ProviderUsage.reportedCostUsd` beats the price table.** When a vendor tells
you what it charged, believe it. xAI returns `usage.cost_in_usd_ticks`
(**1 tick = 1e-10 USD**, derived exactly — see below). A table we maintain by hand
cannot know about a context tier, an unpublished cache rate, or a price change
shipped this morning. `pricing: 'free'` still wins over it.

**The xAI cached rates are published NOWHERE** — not the pricing page, not the
caching page — yet they are billed. They were derived by solving two
identical-prompt calls (one cold, one cache-hit) for the tick unit and the cached
rate simultaneously: **grok-4.3 → $0.20/MTok, grok-4.5 → $0.50/MTok**, both exact,
and $0.20 matches xAI's own billing console. Before this, the table omitted them
and `computeUsage()` fell back to the full input rate: a **6.25× overcharge** on
every cached token, on a provider that caches aggressively (a _cold_ call still
reported 128 cached tokens).

4e. **Reasoning is billed but not always controllable, and that asymmetry is a
capability.** `thinking` is a real per-call toggle on DeepSeek and OpenAI, and
**DeepSeek defaults it to ENABLED** — so "off" must be sent EXPLICITLY
(`{thinking: {type: 'disabled'}}`), because omitting the flag means paying for a
chain-of-thought on every call (measured: 9× the output tokens on a trivial
prompt). xAI, by contrast, **always reasons and cannot be told not to**:
`thinking: {type:'disabled'}` is accepted and silently ignored,
`reasoning_effort: 'none'` is a hard 400, and "non-reasoning" is a separate MODEL.
That is what `ProviderCapabilities.thinkingAlwaysOn` exists to say — so a caller
asking for thinking off gets a **degradation** instead of a silent 9× bill.

4f. **The token-limit parameter name is per-vendor, and OpenAI disagrees with its
own past self.** Every model OpenAI currently ships **hard-400s on `max_tokens`**
("Use 'max_completion_tokens' instead"), so the `openai` preset was in fact broken
against every current OpenAI model and worked only on the legacy `gpt-4o` line it
happened to default to. `Preset.maxTokensParam` handles it;
`max_completion_tokens` is verified to work on both the `gpt-5.x` family and
legacy `gpt-4o`, so it is a flat per-preset switch, not a per-model branch.
Everyone else still speaks `max_tokens`.

4g. **`config.extraBody` is the escape hatch, and it merges LAST.** This transport
fronts Ollama, vLLM, LM Studio, OpenRouter, Groq and Together — backends whose
knobs we cannot enumerate. Without it, the next vendor-specific parameter forces
either a framework release or an app-level fork of the adapter, and the second is
what this platform forbids. It can override what the adapter chose: an escape
hatch you must ask permission from is not one.

5. **Moderation fails closed.** An undefined policy throws; a judge that errors
   BLOCKS; an item the judge silently dropped is BLOCKED, not waved through. A
   safety control that quietly allows everything is worse than none, because the
   app believes it has one. `onError: 'allow'` exists, and is an explicit,
   named choice — never a default.

6. **Never read `process.env`.** API keys come from
   `getContext(app).secrets.get(apiKeySecret)` in `setupMiddleware`, and a
   provider that declares a key it can't get fails the _boot_.

7. **The usage entity has NO `routes` key, and that is load-bearing.** Omitting
   it is what makes the framework mount no router (`createEntityPlugin.ts:682`).
   Adding one would publish a per-tag, per-model breakdown of what the app spends
   and what it prompts with, to anyone who asks. Reads go through `AiUsageCap`.
   The boot test asserts `GET /ai-usage → 404` so this can never regress quietly.

8. **The response cache and in-flight coalescing are independent.** The cache is
   OFF by default (a party game wants variety, not an identical deck every time);
   coalescing is ON by default (five guests tapping the same button at once is
   one intent, and should be one call). Do NOT gate coalescing behind
   `responseCache.enabled` — that silently disables it in the default
   configuration, which is the one everybody runs. This was a real bug.

## Background generation

A zod schema **cannot ride a queue** — `JSON.stringify` turns it into `{}`. So
the queued job carries the schema NAME, and the worker looks the real schema up
in the registry the app passed to `createAiGenerationTask({ schemas })`
(`src/orchestration.ts`, a separate entry point so the main entry never pulls in
the orchestration engine).

`generateStructuredInBackground` therefore returns a **discriminated union**:
`{ mode: 'queued', runId }` when a queue exists AND the schema is registered,
`{ mode: 'sync', result }` otherwise. A caller physically cannot mistake an
inline run for a durable one — which `{ runId?: string }` would have allowed,
and which you would discover when a restart lost someone's deck.

## The framework trap this package already stepped in

Capability publication must be **declarative** — `definePackage({ capabilities:
{ provides: [...] } })`. Two things make this non-obvious:

- The framework resolves those values **eagerly**, during
  `publishPackageRuntimeState`, which runs _before_ this package's
  `setupMiddleware` — so the real client does not exist yet.
- Publishing imperatively instead does not work: the framework re-runs its
  declarative pass at the top of `setupPost` and **wipes** the slot.

The way through (precedent: `slingshot-notifications`) is to publish stable
**facades** whose methods defer to a ref that `setupMiddleware` fills in. See
`src/plugin.ts`. If you switch to imperative registration, the boot test will
catch you.

## Config

No top-level `.superRefine()` on `aiPackageConfigSchema` — `validatePluginConfig`
is typed `<S extends z.ZodObject>` and `warnUnknownPluginKeys` introspects the
object shape. Cross-field checks go in `assertConfigCoherent()` in
`src/plugin.ts`, imperatively.

## Tests

`bun test packages/slingshot-ai/tests` — hermetic, no network, no keys.
Typecheck: `bunx tsc -p packages/slingshot-ai/tsconfig.json --noEmit` (clean).

Note the package `tsconfig.json` **extends the root** so workspace path aliases
resolve; without that, the integration test (which boots a real app through
`tests/setup`) buries the gate in unresolved-module noise.

## Adding a provider adapter

**First ask whether you need one at all.** `grok`, `openai` and `deepseek` are
not adapters — they are `Preset`s over the one `openaiCompatible` transport
(baseUrl + capabilities + prices + optionally a `mapUsage`). Anything speaking
`/chat/completions` should be a preset. Writing a second transport for it is the
mistake.

For a genuinely different wire protocol: implement `AiProvider`
(`src/provider/types.ts`), register it with `registerBuiltinProvider(kind,
factory)`, and add `runProviderConformanceSuite('your-kind', factory)` to
`tests/conformance/`. The suite asserts only what the orchestrator depends on —
notably that a provider declaring `promptCaching: 'explicit'` also declares
`promptCacheMinTokens`, and that streaming deltas concatenate to exactly
`finalResult().text`.

Two traps a reasoning model sets, both live in `openaiCompatible`:

- **`reasoning_content` must never reach `text`.** DeepSeek emits it alongside
  `content`, in the response AND in stream deltas. Concatenating it puts the
  model's chain-of-thought where the answer should be — it fails to parse as
  JSON, and worse, hands an app the model's private deliberation. It is surfaced
  as a `{type: 'thinking'}` stream event instead, which also keeps the streaming
  invariant true: the TEXT deltas still concatenate to exactly `finalResult().text`,
  because the reasoning never entered either side of that equation.
- **`promptCacheKey` is a wire param, not just a bookkeeping key.** It rides as
  `x-grok-conv-id` on xAI so the request routes to the server that already holds
  the prefix. Without it an "automatic" cache is a coin flip.

Take the SDK as an **optional peer**: lazy `await import()` in a try/catch with a
typed error naming the install command (precedent:
`slingshot-webhooks/src/queues/bullmq.ts`). Importing this package must never
pull `@anthropic-ai/sdk` into an app that doesn't use it.
