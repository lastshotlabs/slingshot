# @lastshotlabs/slingshot-ai

Install with Bun:

```sh
bun add @lastshotlabs/slingshot-ai
```

Provider-neutral AI generation for slingshot apps.

One client surface, honest capability negotiation, structured output that works
even on providers that don't support it, and cost accounting that never invents
a number.

```ts
import { defineApp } from '@lastshotlabs/slingshot';
import { AiClientCap, createAiPackage } from '@lastshotlabs/slingshot-ai';

export default defineApp({
  packages: [
    createAiPackage({
      providers: {
        anthropic: { kind: 'anthropic', apiKeySecret: 'ANTHROPIC_API_KEY' },
      },
      defaultProvider: 'anthropic',
      spend: { period: 'day', softLimitUsd: 5, hardLimitUsd: 20 },
    }),
  ],
});
```

```ts
const ai = ctx.capabilities.require(AiClientCap);

const { value, degradations, usage } = await ai.generateStructured({
  schema: DeckSchema,
  system: {
    stable: [{ id: 'rules', text: RULES }], // cached across calls
    volatile: [{ id: 'seed', text: seed }], // never cached
  },
  messages: [{ role: 'user', content: 'Generate a deck.' }],
});
```

## The three ideas

**Providers are dumb transports.** A provider makes an HTTP call and normalizes
the response. It does not validate schemas, compute cost, decide retries, or
moderate. All policy lives in one orchestrator, which is why swapping providers
is a config change and not a code change.

**Nothing degrades silently.** If you ask for structured output on a provider
that can't enforce a schema, or thinking on a model that can't think, you get
the best available behavior _and_ an entry in `result.degradations` saying what
you asked for, what you got, and why. `degradations.length === 0` means
everything you asked for was honored — an app can assert that and mean it. Set
`degradation: 'strict'` to turn any shortfall into a thrown
`AiUnsupportedFeatureError` instead.

**`null` is not `0`.** `usage.costUsd === null` means the price is _unknown_;
`0` means the call was genuinely free (a local model). Summaries keep the
distinction as `unpricedCalls`, so a cost dashboard can't quietly under-report
by summing unknowns as zero.

## Capabilities

| Capability        | Type            | For                                             |
| ----------------- | --------------- | ----------------------------------------------- |
| `AiClientCap`     | `AiClient`      | generation: text/images, structured, streaming  |
| `AiModerationCap` | `AiModerator`   | safety verdicts, with no ability to spend money |
| `AiUsageCap`      | `AiUsageReader` | usage, cost, and spend reads for admin surfaces |

Three rather than one, because moderating player-typed content involves no
generation at all — a package that only needs safety shouldn't take a dependency
on a surface that can spend money making tokens.

## Prompt caching

Prompt caching fails silently in both directions, so this package watches it:

1. **Below the minimum, no breakpoint is emitted.** Anthropic's minimum
   cacheable prefix is 4096 tokens on Opus. Below that the API _accepts_ a
   breakpoint and then simply doesn't cache. We refuse to emit one and record a
   degradation explaining why, instead of letting you believe you're caching.
2. **Stable-prefix drift is named.** Each `stable` segment is hashed per call. If
   one changes, you get a warning naming the segment — because "your cache broke"
   is useless and "the `rules` segment changed" is actionable.
3. **A breakpoint that never hits is reported.** After N calls that emitted a
   breakpoint and read zero cached tokens, you get told.

Put anything per-call (a timestamp, a match id, a roster) in `volatile`. It is
always rendered _after_ the breakpoint.

## Spend

The guard is **pre-flight**: it estimates the worst case a call could cost and
throws `AiSpendLimitError` _before_ the HTTP request. A post-hoc check tells you
about the runaway loop once it has finished spending the money. Every retry and
every structured-repair attempt re-enters the guard, because those are exactly
the shapes an accidental bill takes.

Multi-user apps can add a durable per-user or per-tenant controller without
forking the generation path. Set `spend.controller` and
`spend.requireScope: true`, then pass `spendScope` on every request. The
controller reserves before **every provider attempt** (including retries and
structured repairs), settles with normalized usage, and releases failed calls:

```ts
spend: {
  requireScope: true,
  controller: {
    async reserve({ scope, provider, model, estimatedMaxCostUsd, tags }) {
      const reservation = await ledger.reserve({
        userId: scope,
        provider,
        model,
        estimatedMaxCostUsd,
        attemptId: tags?.attemptId,
      });
      return {
        settle: ({ usage }) => ledger.settle(reservation.id, usage),
        release: () => ledger.release(reservation.id),
      };
    },
  },
}
```

The built-in process-wide guard remains useful as an operator ceiling. The
controller is the transaction/concurrency seam for application-owned budgets.

## Multimodal messages

`AiMessage.content` accepts either a string or provider-neutral content parts.
Inline images are base64 payloads without a data-URL prefix:

```ts
await ai.generateStructured({
  provider: 'vision',
  schema: ScreenshotRecords,
  spendScope: user.id,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Extract the visible fitness records.' },
        { type: 'image', mediaType: 'image/webp', data: webpBase64 },
      ],
    },
  ],
});
```

Inspect `client.capabilitiesOf(provider).imageInput` before exposing an upload
flow. Sending an image to a text-only provider throws
`AiUnsupportedFeatureError`; images are never silently dropped.

## Providers

| kind                | Backs                                             | Default model       | Structured output      | Prompt caching              | Reasoning          | Cost         |
| ------------------- | ------------------------------------------------- | ------------------- | ---------------------- | --------------------------- | ------------------ | ------------ |
| `anthropic`         | the Claude API                                    | `claude-opus-4-8`   | native                 | **explicit** (min 4096 tok) | opt-in             | table        |
| `openai`            | the OpenAI API                                    | `gpt-5.4-mini`      | native                 | automatic                   | opt-out¹           | table        |
| `grok`              | xAI (`api.x.ai`)                                  | `grok-4.3`          | native                 | automatic (routing key)     | **always on**²     | **vendor**³  |
| `deepseek`          | DeepSeek (`api.deepseek.com`)                     | `deepseek-v4-flash` | **json-mode**          | automatic                   | **on by default**⁴ | table        |
| `gemini`            | Google Gemini GenerateContent                     | `gemini-3.5-flash`  | native                 | none                        | none               | config table |
| `openai-compatible` | Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, … | _(required)_        | json-mode (declarable) | none (declarable)           | none               | off / `free` |

`openai`, `grok`, and `deepseek` are presets over the same zero-dependency
compatible transport. `gemini` is a separate zero-dependency GenerateContent
transport. Only `anthropic` has an SDK, and it is an **optional peer** imported
lazily: an app that never selects it does not load it.

**Which to pick.** `deepseek` is by a wide margin the cheapest (`v4-flash`:
$0.14/MTok in, $0.28 out, and a cache-hit rate of $0.0028 — 50× cheaper than a
miss). `grok` refuses far less than the others, which matters if your content is
meant to have teeth; `grok-4.3` is the default rather than `grok-4.5` (the
coding-grade model, at ~3× the output price). `openai-compatible` against a local
Ollama is _free_ and never leaves your machine. `anthropic` is the only one with
explicit cache breakpoints and a real refusal signal. A common shape is to
**generate on the cheap or permissive one and moderate on the trusted one** — see
[Moderation](#moderation); the judge may run on a different provider than the
generator.

**Watch the reasoning tokens.** They are billed at the OUTPUT rate everywhere, and
they are not free: leaving DeepSeek's thinking on costs **9× the output tokens** on
a short prompt. Set `thinking: false` for generation (where chain-of-thought buys
little) and consider leaving it on for moderation (a judgement call, and one batched
call per deck). The vendors report reasoning tokens with the **same field name and
opposite meanings** — xAI's `completion_tokens` excludes them, DeepSeek's and
OpenAI's include them — so `usage.outputTokens` is normalised for you. Do not
re-derive it from `raw`.

¹ OpenAI's GPT-5 family reasons, but `reasoning_effort: 'none'` genuinely turns it
off. Note it **rejects `max_tokens`** entirely (`max_completion_tokens` only) —
handled by the preset.
² xAI **always reasons and cannot be told not to** (`thinking: {type:'disabled'}` is
accepted and ignored; `reasoning_effort: 'none'` is a 400). Ask for thinking off and
you get an `AiDegradation`, not silence.
³ xAI reports its own authoritative cost (`cost_in_usd_ticks`), which is preferred
over the price table. Its cached-input rates are published nowhere, so they were
derived from that figure: **$0.20/MTok on grok-4.3, $0.50 on grok-4.5.**
⁴ DeepSeek's thinking mode defaults to **enabled** — the preset sends `disabled`
explicitly when you ask for it, because omitting the flag is not the same as
turning it off.

**Vendor-specific knobs: `extraBody`.** This adapter fronts backends whose
parameters we cannot enumerate. `providers.<name>.extraBody` is merged into every
request **last**, so it can override anything the adapter chose:

```ts
providers: {
  local: { kind: 'openai-compatible', baseUrl: '…', extraBody: { top_k: 40, mirostat: 2 } },
}
```

**`deepseek` is `json-mode`, and that is not a footnote.** It supports
`response_format: {type: 'json_object'}` only — valid JSON, unenforced shape. The
orchestrator handles it by injecting the schema into the prompt _and_ setting
`json_object`, then validating and repairing locally. It is therefore the
provider that actually exercises the structured-output fallback (a `native`
provider never does), which makes it the best test of whether provider-swapping
really works in your app. It also, for free, satisfies DeepSeek's documented
requirement that the word "json" appear in the prompt.

Its defaults are deliberately pessimistic (`structuredOutput: 'json-mode'`, no
prompt caching, no cost accounting), because that one adapter fronts backends
ranging from vLLM-with-a-grammar (which genuinely enforces a JSON Schema) to a
small Ollama model (which cannot reliably close a brace). Declare what your
backend really does:

```ts
providers: {
  local: {
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    pricing: 'free',                                  // costUsd: 0, not null
    capabilities: { structuredOutput: 'native' },     // only if it's true
  },
}
```

Under-declaring costs you a JSON repair loop. Over-declaring costs you a card
that never validates. Only one of those is silent.

## Moderation

The judge may run on a **different provider than the generator** — generate a
deck on a free local model, judge it on Haiku for a fraction of a cent:

```ts
moderation: {
  provider: 'haiku',                 // ≠ defaultProvider
  policies: {
    house: { rules: 'No explicit sexual content.', categories: ['nsfw'], blockAtOrAbove: 'medium' },
  },
},
```

It **fails closed**. An undefined policy throws. A judge that errors blocks. An
item the judge silently dropped is blocked, not waved through. `onError: 'allow'`
exists and is an explicit, named choice.

## Background generation

A zod schema cannot ride a queue, so the job carries the schema **name** and the
worker looks the real schema up:

```ts
// @skip-typecheck — abbreviated app wiring; see the orchestration package guide.
import { createAiGenerationTask } from '@lastshotlabs/slingshot-ai/orchestration';

const aiTask = createAiGenerationTask({ schemas: { deck: DeckSchema } });

const packages = [
  createAiPackage({ orchestration: { enabled: true } }),
  createOrchestrationPackage({ adapter, tasks: [aiTask] }),
];
```

`generateStructuredInBackground()` returns a discriminated union — `{ mode:
'queued', runId }` when a queue exists and the schema is registered, `{ mode:
'sync', result }` otherwise. You cannot mistake an inline run for a durable one.

## Caching

Two different things, with opposite defaults, because conflating them is the
expensive mistake:

- **Prompt cache** (on): the provider stores your prefix. You still make the
  call, you still get fresh output. Saves money.
- **Response cache** (**off**): we don't call at all; you get last time's answer.
  A party game that returns an identical deck is broken, not fast.
- **In-flight coalescing** (**on**): five guests tapping "generate" at the same
  instant is one intent, and becomes one upstream call. Saves the money without
  costing the variety.

## Usage & cost

Usage is persisted to an entity with **no HTTP surface at all** — a framework
package that quietly published `GET /ai-usage` would be handing out a per-tag,
per-model breakdown of what you spend and what you prompt with. Reads go through
`AiUsageCap`, so the app decides who may see them.

The ledger also rebuilds the spend window at boot, so a crash-loop can't hand the
app a fresh budget on every restart.

## Testing

```ts
import { expect } from 'bun:test';
import { createAiPackage } from '@lastshotlabs/slingshot-ai';
import { createFakeAiProvider } from '@lastshotlabs/slingshot-ai/testing';

const provider = createFakeAiProvider({
  responses: [{ text: '{"cards":["a","b"]}' }],
  capabilities: { structuredOutput: 'none' }, // exercise the fallback path
});

createAiPackage({ providers: { test: { provider } }, defaultProvider: 'test' });

expect(provider.calls).toHaveLength(1); // every request is captured
```

The fake defaults to **conservative** capabilities (no structured output, no
caching, no cost accounting). A fake that claimed everything worked would hide
exactly the degradation paths worth testing.

`runProviderConformanceSuite(name, factory)` is the contract every adapter —
including the fake — must pass. It is what makes "swap the provider in config" a
claim rather than a hope.

## Status

Feature-complete. Landed: the provider seam and conformance suite; the
`anthropic`, `gemini`, `openai-compatible`, and provider presets; multimodal
image input; the orchestrator with
structured output and a bounded repair loop; the three prompt-cache detectors;
the pre-flight spend guard with ledger-backed hydration plus durable
request-scoped reservation controllers and an
`ai:spend.soft_limit` event; LLM-backed moderation (independent / self / both,
batched, cross-provider, fail-closed); persisted usage with no HTTP surface;
the cache-adapter-backed response cache plus in-flight coalescing; and durable
background generation via `slingshot-orchestration`.

Live tests against the real Anthropic API are gated behind
`SLINGSHOT_AI_LIVE=1`; everything else is hermetic — no key, no network, no cost.
