# slingshot-billing — maintainer notes

- Phase 1 (this): scaffold — config, `BillingProvider` interface, entitlement contract + events,
  dormant gate, stub entitlement capability. No entities, no Stripe impl, no live routes.
- Later phases per `slingshot-specs/specs/feature.billing.md`.
- The Stripe webhook must stay a plain `app.post` with no `request.body` schema so the raw bytes
  reach `constructEvent` unparsed; `publicPaths`/`csrfExemptPaths` are declared on the package.
