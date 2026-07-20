# slingshot-billing

Provider-abstracted billing. Owns Stripe (customer, Checkout, Portal, signature-verified webhook,
subscription sync) behind a `BillingProvider` interface, and exposes an app-agnostic **entitlement**
(`{ plan, status, currentPeriodEnd, cancelAtPeriodEnd }`) via a capability + bus events. Apps map
plans onto their own domain. Dormant with no provider configured.

## Key Files

| File                        | What                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/plugin.ts               | `createBillingPackage()` — `definePackage` factory: entities, events, dormant gate, provider/store wiring, route mount, DB-backed entitlement capability             |
| src/types/config.ts         | zod config schema (`provider`/`plans`/`donations`/`urls`) + `isBillingConfigured`                                                                                    |
| src/lib/provider.ts         | `BillingProvider` interface + normalized `ProviderEvent`                                                                                                             |
| src/lib/providers/stripe.ts | Stripe `BillingProvider` impl + `normalizeStripeEvent` (the only file that may import the Stripe SDK)                                                                |
| src/lib/sync.ts             | provider-agnostic webhook sync: idempotent, order-tolerant, pure over `BillingStore`                                                                                 |
| src/lib/entitlement.ts      | pure `deriveEntitlement` (best-row rule) + `planKeyForPrice`                                                                                                         |
| src/lib/store.ts            | `BillingStore` seam + `createEntityBillingStore` (thin entity-adapter mapping)                                                                                       |
| src/routes/\_shared.ts      | route deps seam (`BillingRouteDeps`), shared schemas, `readyBilling` 503 gate, lazy `ensureCustomerRow`                                                              |
| src/routes/checkout.ts      | `POST /billing/checkout` — plan-key subscription checkout (typed OpenAPI route, `userAuth`)                                                                          |
| src/routes/donate.ts        | `POST /billing/donate` — preset/custom one-time donation checkout (sign-in required)                                                                                 |
| src/routes/portal.ts        | `POST /billing/portal` — hosted billing portal session (404 without a customer row)                                                                                  |
| src/routes/entitlement.ts   | `GET /billing/entitlement` — DB-backed entitlement; free (200) while dormant                                                                                         |
| src/routes/webhook.ts       | `POST /billing/webhooks/stripe` — plain (non-OpenAPI) raw-body route: bounded read (413), signature verify (400), sync, `billing:*` emits; not mounted while dormant |
| src/entities/\*.ts          | `Customer`/`Subscription`/`Payment` entities (namespace `billing`, deliberately NO `routes` key — zero HTTP surface)                                                 |
| src/public.ts               | `Billing` contract, `Entitlement`, `BillingEntitlementCap`                                                                                                           |
| src/events.ts               | `SlingshotEventMap` augmentation for `billing:entitlement.changed` / `billing:payment.completed`                                                                     |
| src/index.ts                | public export surface                                                                                                                                                |

## Connections

- **Imports from**: `@lastshotlabs/slingshot-core` (definePackage, capability/event contracts, routing, config validation), `@lastshotlabs/slingshot-entity` (`entity({ config })` wrappers), `stripe` (ONLY inside `src/lib/providers/stripe.ts`).
- **Runtime dependencies**: `slingshot-auth` (declared package dependency) — every client-facing route runs `userAuth`.
- **Imported by**: consuming apps (aicoach first) via `packages:`; they read `BillingEntitlementCap` and subscribe to `billing:*` events.

## Common Tasks

- **Add a provider**: implement `BillingProvider` in `src/lib/providers/<name>.ts` (normalize webhooks onto `ProviderEvent`; `lib/sync.ts` needs no changes), then extend the config discriminator + the construction switch in `src/plugin.ts`.
- **Change config**: edit `src/types/config.ts` (keep `.describe()` on every field), then update `docs/human/index.md`.
- **Testing**: `packages/slingshot-billing/tests/` — unit (pure sync/entitlement/store/provider-normalizer) + integration via `runPackageLifecycle` with a `FakeBillingProvider` injected through the `internals` seam.
- **Full design**: `slingshot-specs/specs/feature.billing.md`.

## Gotchas

- **`README.md` is build output** — `scripts/build.ts` copies `docs/human/index.md` over it on every `bun run build`. Never hand-edit README.md; edit the human guide and rebuild.
- **Bun + Stripe sync crypto**: Bun resolves the Stripe SDK's worker build (`bun` export condition), whose default crypto provider can't do sync `constructEvent`. `src/lib/providers/stripe.ts` passes the explicit `stripeSyncCryptoProvider` (node:crypto HMAC); tests generating signed test headers under Bun must use the same provider.
- The webhook must stay a plain `app.post` with NO `request.body` schema (raw bytes must reach `constructEvent`); its path rides the package's `publicPaths`/`csrfExemptPaths`, auto-merged by the framework.
- `subscription.deleted` yields `{ plan: '<stored key>', status: 'canceled' }`, not the literal free entitlement — consumers key off `status`. Bus emits are fire-and-forget (handler throws are swallowed by the bus); consumers reconcile via `BillingEntitlementCap` on read.
