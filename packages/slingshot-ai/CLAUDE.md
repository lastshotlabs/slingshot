# slingshot-ai — agent notes

Provider-neutral AI generation. Read `README.md` first; this file is the stuff
that will bite you.

## Architecture in one line

Providers are **dumb transports**; all policy (validation, cost, retry, spend,
moderation, degradation) lives in the orchestrator (`src/lib/client.ts`).

## Invariants — do not break these

1. **`ProviderResult.structured` is ADVISORY.** The orchestrator re-validates
   with `schema.safeParse()` for *every* provider, including "native" ones.
   Anthropic can return `parsed_output: null`; an OpenAI-compatible endpoint can
   claim schema enforcement it doesn't have. One validation point is the whole
   reason provider-swapping works. Never trust `structured` and skip the parse.

2. **Every retry and every repair attempt re-enters the spend guard.** A retry
   storm and a repair loop are the two shapes an accidental bill takes. The
   guard is pre-flight (`spend.check()` *before* the HTTP call), because a
   post-hoc check only tells you about the runaway loop after it has finished
   spending.

3. **Nothing degrades silently.** Anything the provider can't honor becomes an
   `AiDegradation` on the result. `degradations.length === 0` must continue to
   mean "everything you asked for was honored", or apps that assert on it are
   being lied to.

4. **`costUsd: null` ≠ `costUsd: 0`.** Unknown is not free. This distinction has
   to survive aggregation (`AiUsageSummary.unpricedCalls`).

5. **Moderation fails closed.** No moderator + a requested policy = throw. A
   safety control that quietly allows everything is worse than none, because the
   app believes it has one.

6. **Never read `process.env`.** API keys come from
   `getContext(app).secrets.get(apiKeySecret)` in `setupMiddleware`, and a
   provider that declares a key it can't get fails the *boot*.

## The framework trap this package already stepped in

Capability publication must be **declarative** — `definePackage({ capabilities:
{ provides: [...] } })`. Two things make this non-obvious:

- The framework resolves those values **eagerly**, during
  `publishPackageRuntimeState`, which runs *before* this package's
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

Implement `AiProvider` (`src/provider/types.ts`), register it with
`registerBuiltinProvider(kind, factory)`, and add
`runProviderConformanceSuite('your-kind', factory)` to
`tests/conformance/`. The suite asserts only what the orchestrator depends on —
notably that a provider declaring `promptCaching: 'explicit'` also declares
`promptCacheMinTokens`, and that streaming deltas concatenate to exactly
`finalResult().text`.

Take the SDK as an **optional peer**: lazy `await import()` in a try/catch with a
typed error naming the install command (precedent:
`slingshot-webhooks/src/queues/bullmq.ts`). Importing this package must never
pull `@anthropic-ai/sdk` into an app that doesn't use it.
