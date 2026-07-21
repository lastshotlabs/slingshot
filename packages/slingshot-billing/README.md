# @lastshotlabs/slingshot-billing

Install with Bun:

```sh
bun add @lastshotlabs/slingshot-billing
```

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

## Purpose

`@lastshotlabs/slingshot-billing` owns payment plumbing — provider customer mapping, hosted
Checkout and Billing Portal sessions, one-time donations, a signature-verified webhook, and
idempotent subscription sync — behind a provider-neutral `BillingProvider` seam (Stripe is the
first implementation). What it exposes to the rest of the app is deliberately small: a
domain-agnostic **entitlement** that answers one question — _what has this owner paid for right
now?_ — as `{ plan, status, currentPeriodEnd, cancelAtPeriodEnd }`.

Plans are pure configuration: the app declares `{ key, priceId, trialDays? }` pairs and billing
reports the matching `plan` key back. Billing never knows what `'pro'` means — consuming apps map
plan keys onto their own domain (a spend tier, a perk, a feature flag). The billing entities follow
the shared package-first/entity authoring model; `createBillingPackage()` is the runtime shell that
composes provider, storage, routes, and the entitlement surface.

## When To Use It

Add this package when an app needs:

- paid subscription plans (with optional free trials) backed by hosted provider checkout
- one-time donations (preset and/or bounded custom amounts)
- a self-service billing portal for subscribers
- a single app-agnostic entitlement read (`BillingEntitlementCap`) plus change events

## Minimum Setup

```ts
import { createBillingPackage } from '@lastshotlabs/slingshot-billing';

// Add to defineApp({ packages: [...] }), alongside createAuthPlugin(...) in plugins:.
export const billing = createBillingPackage({
  provider: {
    name: 'stripe',
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },
  plans: [{ key: 'pro', priceId: process.env.STRIPE_PRICE_PRO ?? '', trialDays: 14 }],
  donations: {
    enabled: true,
    currency: 'usd',
    presets: [{ id: 'coffee', amount: 500 }],
    requireAuth: true,
  },
  urls: {
    checkoutSuccess: 'https://app.example.com/billing/success',
    checkoutCancel: 'https://app.example.com/billing/cancel',
    portalReturn: 'https://app.example.com/account',
  },
});
```

The package depends on `slingshot-auth` (declared as a package dependency): every client-facing
billing route requires an authenticated user, and the authenticated user id is the billing owner.

After adding the package, generate and apply the entity migrations from the consuming app:

```bash
slingshot migrate generate   # discovers the billing entities, emits billing_* table migrations
slingshot migrate apply
```

## Dormant By Default

Omit `provider` and billing is **dormant** — safe to ship before Stripe is configured:

- `POST /billing/checkout`, `/billing/donate`, `/billing/portal` answer `503` with error token
  `billing_unavailable`.
- `GET /billing/entitlement` answers `200` with the free entitlement
  (`{ plan: 'free', status: 'none', currentPeriodEnd: null, cancelAtPeriodEnd: false }`) — "you
  have no paid plan" is a complete answer, not an error.
- The webhook route is **not mounted at all**; POSTs to it 404.
- `BillingEntitlementCap` resolves every owner to the free entitlement.
- The Stripe SDK module's construction path is never reached.

`isBillingConfigured(config)` is the single gate every runtime path consults.

## The Entitlement Boundary

```ts
interface Entitlement {
  plan: string; // configured plan key, or 'free'
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  currentPeriodEnd: string | null; // ISO timestamp
  cancelAtPeriodEnd: boolean;
}
```

The entitlement is derived exclusively from stored `billing_subscriptions` rows (written only by
the verified webhook path — never from a client claim or a checkout redirect) via the pure
`deriveEntitlement` best-row rule: rows whose `plan` is not a configured plan key are discarded,
then the best remaining row wins, ranked `active > trialing > past_due > canceled`, tie-broken by
the latest `currentPeriodEnd`. No qualifying rows ⇒ the free entitlement.

Subtleties consumers must handle:

- **A canceled subscription is `{ plan: '<key>', status: 'canceled', ... }`, NOT the literal free
  entitlement.** `customer.subscription.deleted` marks the stored row canceled and keeps its plan.
  Key your access logic off `status`, not off `plan === 'free'` — treat anything other than
  `active`/`trialing` (and, per your own policy, `past_due`) as unentitled.
- **Donations never alter the entitlement.** A payment is a one-time signal surfaced via
  `billing:payment.completed`; an app granting a "supporter" perk reacts to that event itself.
- An unknown provider price maps to plan `'free'` — a webhook for a price the app never configured
  cannot grant an entitlement.

## Consuming The Entitlement

At runtime the package publishes one typed capability:

- `BillingEntitlementCap` — `(ownerId: string) => Promise<Entitlement>`, the DB-backed on-demand
  read.

```ts
import { BillingEntitlementCap } from '@lastshotlabs/slingshot-billing';
import type { HookServices } from '@lastshotlabs/slingshot-core';

export function readEntitlement(ctx: HookServices, ownerId: string) {
  return ctx.capabilities.require(BillingEntitlementCap)(ownerId);
}
```

And two bus events (both `exposure: ['internal']` — in-process only, never client-deliverable or
externally webhook-deliverable):

- `billing:entitlement.changed` — `{ ownerId, entitlement }`, emitted after a verified webhook
  event actually changed the derived entitlement. The payload is the full derivation over ALL of
  the owner's stored rows, so it always equals what `GET /billing/entitlement` reports afterwards.
- `billing:payment.completed` — `{ ownerId | null, amount, currency, presetId? }`, emitted once per
  settled donation.

**Reconcile on read.** Bus emission is fire-and-forget: the in-process bus catches and logs handler
throws, and delivery does not survive a process restart. An event-driven projection (e.g. mapping
`entitlement.changed` onto a tier table) can therefore silently miss or fail an update. Consumers
MUST treat the event as a cache-invalidation hint and reconcile against
`BillingEntitlementCap` on read paths that matter — the capability read is always the DB-backed
truth.

## Routes

All client-facing routes are typed OpenAPI routes (they appear in the app's generated OpenAPI
contract and Snapshot clients), tagged `Billing`, and require an authenticated user via the
auth plugin's `userAuth` (401 otherwise). Paths below assume the default `mountPath: '/billing'`.

| Route                           | Auth      | Behavior                                                                                                                                    |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /billing/checkout`        | user      | Body `{ plan }` (a configured plan **key** — never a price id). Returns `{ url }` of the hosted checkout. 400 unknown plan, 503 dormant.    |
| `POST /billing/donate`          | user      | Body: exactly one of `{ presetId }` or `{ customAmount }` (bounded by config). Returns `{ url }`. 503 when dormant or donations disabled.   |
| `POST /billing/portal`          | user      | Returns `{ url }` of the hosted Billing Portal. 404 when the user has no billing customer yet (portal never lazy-creates one). 503 dormant. |
| `GET /billing/entitlement`      | user      | The caller's derived entitlement. 200 free entitlement while dormant; 503 only if configured but storage is unavailable.                    |
| `POST /billing/webhooks/stripe` | signature | Plain (non-OpenAPI) raw-body route. Mounted only when configured. See below.                                                                |

The provider customer is created lazily, exactly once, on the owner's first checkout/donation, and
reused ever after (`billing_customers` is the owner ↔ provider-customer mapping).

## The Stripe Webhook

`POST <mountPath>/webhooks/stripe` is a deliberately plain `app.post` — not an OpenAPI route — with
**no body schema and no parsing middleware**, so the raw request bytes reach Stripe's
`constructEvent` exactly as signed. Authenticity comes from the signature alone: the package
declares the path in its `publicPaths` and `csrfExemptPaths`, which the framework **auto-merges**
into the app's security config — the host app needs no config edit.

Status contract (what Stripe's retry loop sees):

- **413** — body over `webhookMaxBodyBytes` (default 1 MiB), rejected before any signature work.
- **400** — signature verification failed (missing/bad `stripe-signature` header, tampered body).
  One opaque `invalid_signature` token; the payload and verification detail are never echoed.
- **200** — after ANY successfully verified event, **including** duplicates, stale/out-of-order
  events, unknown customers, and unhandled event types. Stripe must stop retrying once the
  delivery is authenticated.
- **5xx** — an unexpected store/sync failure propagates to the framework error handler so Stripe
  redelivers later.

## Sync Semantics

`syncProviderEvent` (provider-agnostic, pure over the `BillingStore` seam) owns three invariants:

- **Idempotent** — replaying an event is a no-op: an identical subscription upsert reports
  `changed: false` (no event emitted), a repeated `providerPaymentId` is a `duplicate-payment`
  no-op. Stripe retries until it sees a 200, so every path tolerates a re-run.
- **Order-tolerant** — each subscription row stores `providerEventCreated` (the provider event
  timestamp); events strictly older than the stored value are dropped as `stale-event`. Equal
  timestamps are applied (Stripe's `created` has 1-second granularity, so an equal-timestamp
  replay is the idempotent case, not a stale one).
- **Partial-event merge** — normalizers emit `priceId: null` / `currentPeriodEnd: null` when the
  raw event carried no line item (the `checkout.session.completed` fallback with an unexpanded
  subscription, `invoice.payment_failed`). A null never clobbers a stored price or period — a real
  plan change always names the new price.

`billing:entitlement.changed` is emitted only when the recomputed entitlement structurally differs
from the previous one.

## Entities And Migrations

Three standard-wired, **internal-only** entities in namespace `billing` (tables
`billing_customers`, `billing_subscriptions`, `billing_payments`). None declares a `routes` key, so
the framework mounts **zero** generated CRUD surface — all access goes through the package's
`BillingStore` seam, and entitlement reads go through the capability. The consuming app's
`slingshot migrate generate` discovers them from the package's `entities` array and emits the table
migrations.

## Adding A Provider

All routes, sync, and entitlement logic speak only the `BillingProvider` interface
(`src/lib/provider.ts`) plus billing's own domain types — no provider SDK type crosses the seam.
To add a provider:

1. Implement `BillingProvider` in `src/lib/providers/<name>.ts`: `ensureCustomer`,
   `createSubscriptionCheckout`, `createDonationCheckout`, `createPortalSession`, and
   `verifyAndParseWebhook` (which MUST throw on an invalid signature and return a normalized
   `ProviderEvent`).
2. Normalize webhook payloads onto the four `ProviderEvent` kinds (`subscription.updated`,
   `subscription.deleted`, `payment.completed`, `ignored`) — `lib/sync.ts` needs no changes.
3. Extend the `provider` config schema discriminator and the construction switch in
   `src/plugin.ts`.

Keep implementations stateless wrappers over the SDK; persistence, entitlement derivation, and
event emission live in the package, not in providers.

## Configuration Reference

Every field carries a `.describe()` in `src/types/config.ts` (the authoritative reference). The
main knobs:

- `mountPath` — route prefix, default `/billing` (must start with `/`, must not be `/`).
- `provider` — `{ name: 'stripe', secretKey, webhookSecret, apiVersion? }`. Omit ⇒ dormant.
  Source keys from env/secrets, never source control.
- `plans` — `[{ key, priceId, trialDays? }]`. Empty ⇒ no paid plans; `free` is implicit.
- `donations` — `{ enabled, currency, presets?, allowCustomAmount?: { min, max }, requireAuth }`.
  Disabled by default.
- `urls` — `{ checkoutSuccess, checkoutCancel, portalReturn }` absolute URLs; required for any
  checkout/portal action once a provider is configured (missing urls ⇒ the action routes 503).
- `webhookMaxBodyBytes` — webhook body cap, default 1 MiB.

## Testing Seam

`createBillingPackage(config, internals)` takes a second, test-only argument:
`internals.provider` injects a `BillingProvider` (e.g. a `FakeBillingProvider`), so the full
route/lifecycle stack runs without the Stripe SDK. It is a construction seam, not app
configuration — production apps never pass it.

## Operator Runbook (Stripe)

1. **Create products and prices** in the Stripe dashboard (or via the CLI): one recurring price per
   paid plan. Copy each price id (`price_...`) into the app's `plans` config. Donations need no
   product — the donate route uses inline `price_data`.
2. **Set credentials** via the app's environment / secrets manager (never source control):
   `secretKey` (`sk_test_...` / `sk_live_...`) and `webhookSecret` (`whsec_...`).
3. **Register the webhook endpoint** in the Stripe dashboard (Developers → Webhooks):
   `https://<app>/billing/webhooks/stripe`. Subscribe to at least: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Copy the endpoint's signing secret
   into `webhookSecret`. (Everything else billing acknowledges as `ignored`.)
4. **Test vs live** — Stripe test and live modes have separate API keys, price ids, and webhook
   endpoints/secrets. Keep them as separate env sets; a test-mode price id will not resolve in
   live mode. For local development, `stripe listen --forward-to localhost:<port>/billing/webhooks/stripe`
   provides a temporary signing secret.
5. **What is NOT locally verifiable** — hosted Checkout / Billing Portal round-trips require a real
   Stripe account and a reachable, registered webhook endpoint. The test suite covers everything up
   to that boundary (signed webhook payloads included) with fakes.
6. **Smoke sequence** after deploying: sign in → `POST /billing/checkout` for a plan → complete the
   hosted checkout with a test card (`4242 4242 4242 4242`) → confirm the webhook delivery
   succeeded in the Stripe dashboard → `GET /billing/entitlement` reports the plan
   (`active`/`trialing`) → `POST /billing/portal` opens; cancel there and confirm the entitlement
   flips back after the `customer.subscription.deleted` delivery.

## Gotchas

- **Never hand-edit `README.md`** — `scripts/build.ts` copies this file
  (`docs/human/index.md`) over the package README at the end of every `bun run build`. Edit here
  and rebuild.
- Under Bun, the Stripe SDK resolves its **worker build** (the package.json `bun` export
  condition), whose default crypto provider only verifies signatures asynchronously — the sync
  `constructEvent` throws. The Stripe provider passes an explicit `node:crypto`-backed sync
  provider (`stripeSyncCryptoProvider`); tests generating signed headers under Bun need the same
  provider.
- The webhook must stay a plain `app.post` with no `request.body` schema so the raw bytes reach
  `constructEvent` unparsed. Do not "upgrade" it to an OpenAPI route.
- `GET /billing/entitlement` returning free does not mean the user never paid — check `status`
  semantics above and remember dormant mode also reports free with 200.

## Key Files

- `src/plugin.ts` — `createBillingPackage()` factory
- `src/public.ts` — contract, `Entitlement`, `BillingEntitlementCap`
- `src/types/config.ts` — config schema + `isBillingConfigured`
- `src/lib/provider.ts` — the `BillingProvider` seam + normalized `ProviderEvent`
- `src/lib/providers/stripe.ts` — Stripe implementation + `normalizeStripeEvent`
- `src/lib/sync.ts` — idempotent, order-tolerant webhook sync
- `src/lib/entitlement.ts` — pure `deriveEntitlement` best-row rule
- `src/lib/store.ts` — `BillingStore` seam + entity-adapter implementation
- `src/routes/webhook.ts` — the raw-body signature-verified webhook
