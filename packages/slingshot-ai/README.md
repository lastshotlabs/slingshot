# @lastshotlabs/slingshot-ai

Provider-neutral AI generation for slingshot apps.

One client surface, honest capability negotiation, structured output that works
even on providers that don't support it, and cost accounting that never invents
a number.

```ts
import { createAiPackage, AiClientCap } from '@lastshotlabs/slingshot-ai';

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
the best available behavior *and* an entry in `result.degradations` saying what
you asked for, what you got, and why. `degradations.length === 0` means
everything you asked for was honored — an app can assert that and mean it. Set
`degradation: 'strict'` to turn any shortfall into a thrown
`AiUnsupportedFeatureError` instead.

**`null` is not `0`.** `usage.costUsd === null` means the price is *unknown*;
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
   cacheable prefix is 4096 tokens on Opus. Below that the API *accepts* a
   breakpoint and then simply doesn't cache. We refuse to emit one and record a
   degradation explaining why, instead of letting you believe you're caching.
2. **Stable-prefix drift is named.** Each `stable` segment is hashed per call. If
   one changes, you get a warning naming the segment — because "your cache broke"
   is useless and "the `rules` segment changed" is actionable.
3. **A breakpoint that never hits is reported.** After N calls that emitted a
   breakpoint and read zero cached tokens, you get told.

Put anything per-call (a timestamp, a match id, a roster) in `volatile`. It is
always rendered *after* the breakpoint.

## Spend

The guard is **pre-flight**: it estimates the worst case a call could cost and
throws `AiSpendLimitError` *before* the HTTP request. A post-hoc check tells you
about the runaway loop once it has finished spending the money. Every retry and
every structured-repair attempt re-enters the guard, because those are exactly
the shapes an accidental bill takes.

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

Landed: package scaffold, provider seam, conformance suite, orchestrator,
structured output with the repair loop, prompt-cache detectors, pre-flight spend
guard, in-memory usage.

Not yet landed: the Anthropic and openai-compatible adapters (F3); persisted
usage, the LLM-backed moderator, redis/postgres response caches, and
`slingshot-orchestration` integration for background generation (F4). Moderation
currently **fails closed** — requesting a policy with no configured moderator
throws, rather than quietly allowing everything.
