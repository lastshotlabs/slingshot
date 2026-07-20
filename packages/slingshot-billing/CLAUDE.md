# slingshot-billing

Provider-abstracted billing. Owns Stripe (customer, Checkout, Portal, signature-verified webhook,
subscription sync) behind a `BillingProvider` interface, and exposes an app-agnostic **entitlement**
(`{ plan, status, currentPeriodEnd, cancelAtPeriodEnd }`) via a capability + bus events. Apps map
plans onto their own domain. Dormant with no provider configured.

## Key Files

| File                        | What                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| src/plugin.ts               | `createBillingPackage()` — the `definePackage` factory, entities, events, dormant gate, stub entitlement capability  |
| src/types/config.ts         | zod config schema (`provider`/`plans`/`donations`/`urls`) + `isBillingConfigured`                                    |
| src/lib/provider.ts         | `BillingProvider` interface + normalized `ProviderEvent`                                                             |
| src/lib/providers/stripe.ts | Stripe `BillingProvider` impl + `normalizeStripeEvent` (the only file that may import the Stripe SDK)                |
| src/lib/sync.ts             | provider-agnostic webhook sync: idempotent, order-tolerant, pure over `BillingStore`                                 |
| src/lib/entitlement.ts      | pure `deriveEntitlement` (best-row rule) + `planKeyForPrice`                                                         |
| src/lib/store.ts            | `BillingStore` seam + `createEntityBillingStore` (thin entity-adapter mapping)                                       |
| src/entities/\*.ts          | `Customer`/`Subscription`/`Payment` entities (namespace `billing`, deliberately NO `routes` key — zero HTTP surface) |
| src/public.ts               | `Billing` contract, `Entitlement`, `BillingEntitlementCap`                                                           |
| src/events.ts               | `SlingshotEventMap` augmentation for `billing:entitlement.changed` / `billing:payment.completed`                     |
| src/index.ts                | public export surface                                                                                                |

## Connections

- **Imports from**: `@lastshotlabs/slingshot-core` (definePackage, capability/event contracts, config validation), `@lastshotlabs/slingshot-entity` (entities — Phase 2).
- **Imported by**: consuming apps (aicoach first) via `packages:`; they read `BillingEntitlementCap` and subscribe to `billing:*` events.

## Common Tasks

- **Add a provider**: implement `BillingProvider` in `src/lib/providers/<name>.ts` (Phase 2 pattern).
- **Change config**: edit `src/types/config.ts` (keep `.describe()` on every field) — the entitlement/routes read the frozen config.
- **Full design**: `slingshot-specs/specs/feature.billing.md`.
