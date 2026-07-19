# slingshot-billing (AI orientation)

Provider-abstracted billing package. Public surface: `createBillingPackage(config)`, the
`BillingEntitlementCap` capability, `billing:entitlement.changed` / `billing:payment.completed`
events, and the `BillingProvider` interface (Stripe impl in Phase 2). Dormant unless a provider is
configured. See `docs/human/index.md` and `slingshot-specs/specs/feature.billing.md`.
