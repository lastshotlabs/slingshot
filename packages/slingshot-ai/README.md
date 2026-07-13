# @lastshotlabs/slingshot-ai

Provider-neutral AI generation for slingshot apps.

One client surface, honest capability negotiation, structured output that works
even on providers that don't support it, and cost accounting that never invents
a number.

```ts
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
| `AiClientCap`     | `AiClient`      | generation: text, structured, streaming         |
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

## Providers

| kind                | Backs                                                             | Notes                                                                      |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `anthropic`         | the Claude API                                                    | native schemas, explicit prompt caching, adaptive thinking, refusal signal |
| `openai-compatible` | Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq, Together, … | plain `fetch`, **zero dependencies**; capabilities are config-declarable   |
| `openai`            | the OpenAI API                                                    | same adapter, preset endpoint + capabilities + prices                      |

`@anthropic-ai/sdk` is an **optional peer**, imported lazily. An app that only
talks to a local model never installs it — which is the point of
`openai-compatible`: free local inference on your own box is a config change,
not a code change.

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
import { createAiGenerationTask } from '@lastshotlabs/slingshot-ai/orchestration';

const aiTask = createAiGenerationTask({ schemas: { deck: DeckSchema } });

packages: [
  createAiPackage({ ..., orchestration: { enabled: true } }),
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
`anthropic`, `openai-compatible`, and `openai` adapters; the orchestrator with
structured output and a bounded repair loop; the three prompt-cache detectors;
the pre-flight spend guard with ledger-backed hydration and an
`ai:spend.soft_limit` event; LLM-backed moderation (independent / self / both,
batched, cross-provider, fail-closed); persisted usage with no HTTP surface;
the cache-adapter-backed response cache plus in-flight coalescing; and durable
background generation via `slingshot-orchestration`.

Live tests against the real Anthropic API are gated behind
`SLINGSHOT_AI_LIVE=1`; everything else is hermetic — no key, no network, no cost.
