/**
 * The narrow storage seam billing's domain logic runs against.
 *
 * `lib/sync.ts` and `lib/entitlement.ts` are pure over `BillingStore` + plain
 * row types — they never touch an entity adapter directly. The real
 * implementation, `createEntityBillingStore`, is a thin mapping layer over the
 * framework-resolved entity adapters for `billing_customers` /
 * `billing_subscriptions` / `billing_payments`.
 *
 * How the adapters are obtained (the runtime wiring, Phase 4/5): package
 * entities registered via `definePackage({ entities: [entity({ config })] })`
 * get their adapters published into plugin state during the entity bootstrap;
 * the package resolves them from `setupPost` onward with
 * `maybeEntityAdapter(app, { plugin: BILLING_PACKAGE_NAME, entity: 'Customer' })`
 * (precedent: `slingshot-ai/src/plugin.ts`), or captures them at bootstrap via
 * `wiring: { mode: 'factories', onAdapter }` (precedent:
 * `slingshot-notifications/src/entities/modules.ts`). Either way the adapter
 * only exists inside setup contexts — which is exactly why this seam exists.
 */
import type { SubscriptionStatus } from './provider';

/** A `billing_customers` row as billing's domain logic sees it. */
export interface BillingCustomerRow {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly providerCustomerId: string;
}

/** A `billing_subscriptions` row as billing's domain logic sees it. */
export interface BillingSubscriptionRow {
  readonly id: string;
  readonly ownerId: string;
  readonly providerSubscriptionId: string;
  /** Configured plan key, or `'free'` when the price was unknown at sync time. */
  readonly plan: string;
  readonly status: SubscriptionStatus;
  readonly priceId: string | null;
  /** ISO timestamp, or null when the provider has not reported one. */
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  /** Provider event timestamp (epoch seconds) of the last applied event. */
  readonly providerEventCreated: number;
}

/** A `billing_payments` row as billing's domain logic sees it. */
export interface BillingPaymentRow {
  readonly id: string;
  /** Null for anonymous donations. */
  readonly ownerId: string | null;
  readonly providerPaymentId: string;
  readonly kind: 'donation';
  /** Integer amount in the smallest currency unit (cents). */
  readonly amount: number;
  readonly currency: string;
  readonly presetId: string | null;
  readonly status: string;
}

/** Input to create a customer row (id is adapter-generated). */
export type BillingCustomerInput = Omit<BillingCustomerRow, 'id'>;
/** Input to create a subscription row (id is adapter-generated). */
export type BillingSubscriptionInput = Omit<BillingSubscriptionRow, 'id'>;
/** Patch applied to an existing subscription row. */
export type BillingSubscriptionPatch = Partial<BillingSubscriptionInput>;
/** Input to create a payment row (id is adapter-generated). */
export type BillingPaymentInput = Omit<BillingPaymentRow, 'id'>;

/**
 * Everything `lib/sync.ts` needs from persistence — nothing more. Implemented
 * over entity adapters in production (`createEntityBillingStore`) and over a
 * `Map` in tests.
 */
export interface BillingStore {
  /** Forward customer lookup the checkout/portal routes make for the acting owner. */
  findCustomerByOwnerId(ownerId: string): Promise<BillingCustomerRow | null>;
  /** Persist the owner ↔ provider-customer mapping (lazy, first checkout only). */
  createCustomer(input: BillingCustomerInput): Promise<void>;
  /** Reverse customer lookup used to attribute webhook events to an owner. */
  findCustomerByProviderCustomerId(providerCustomerId: string): Promise<BillingCustomerRow | null>;
  /** Fetch the stored subscription for a provider subscription id, if any. */
  getSubscriptionByProviderSubscriptionId(
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionRow | null>;
  /** All of an owner's subscription rows — the entitlement derivation input. */
  listSubscriptionsByOwner(ownerId: string): Promise<readonly BillingSubscriptionRow[]>;
  /** Insert a new subscription row. */
  createSubscription(input: BillingSubscriptionInput): Promise<void>;
  /** Patch an existing subscription row by primary key. */
  updateSubscription(id: string, patch: BillingSubscriptionPatch): Promise<void>;
  /** Fetch a stored payment by provider payment id — the duplicate check. */
  findPaymentByProviderPaymentId(providerPaymentId: string): Promise<BillingPaymentRow | null>;
  /** Insert a new payment row. */
  createPayment(input: BillingPaymentInput): Promise<void>;
}

/**
 * The structural slice of a framework entity adapter this store needs
 * (`BareEntityAdapterCrud` in `slingshot-entity` satisfies it). Kept local so
 * the store compiles against a stable, minimal shape.
 */
export interface BillingEntityAdapter {
  create(data: unknown): Promise<unknown>;
  update(id: string, data: unknown): Promise<unknown>;
  list(opts: {
    filter?: unknown;
    limit?: number;
  }): Promise<{ items: unknown[]; hasMore?: boolean }>;
}

/** The three entity adapters `createEntityBillingStore` maps over. */
export interface BillingEntityAdapters {
  readonly customers: BillingEntityAdapter;
  readonly subscriptions: BillingEntityAdapter;
  readonly payments: BillingEntityAdapter;
}

/** Coerce an adapter-returned date (Date | ISO string | epoch ms) to ISO, or null. */
function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** Coerce an ISO string (or null) to the Date the entity date field expects. */
function toDateOrNull(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

async function findOne(
  adapter: BillingEntityAdapter,
  filter: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const { items } = await adapter.list({ filter, limit: 1 });
  const first = items[0];
  return first == null ? null : asRecord(first);
}

function customerRowFrom(record: Record<string, unknown>): BillingCustomerRow {
  return {
    id: String(record.id),
    ownerId: String(record.ownerId),
    provider: String(record.provider),
    providerCustomerId: String(record.providerCustomerId),
  };
}

function subscriptionRowFrom(record: Record<string, unknown>): BillingSubscriptionRow {
  return {
    id: String(record.id),
    ownerId: String(record.ownerId),
    providerSubscriptionId: String(record.providerSubscriptionId),
    plan: String(record.plan),
    status: record.status as SubscriptionStatus,
    priceId: record.priceId == null ? null : String(record.priceId),
    currentPeriodEnd: toIsoOrNull(record.currentPeriodEnd),
    cancelAtPeriodEnd: record.cancelAtPeriodEnd === true,
    providerEventCreated: Number(record.providerEventCreated ?? 0),
  };
}

function paymentRowFrom(record: Record<string, unknown>): BillingPaymentRow {
  return {
    id: String(record.id),
    ownerId: record.ownerId == null ? null : String(record.ownerId),
    providerPaymentId: String(record.providerPaymentId),
    kind: 'donation',
    amount: Number(record.amount ?? 0),
    currency: String(record.currency),
    presetId: record.presetId == null ? null : String(record.presetId),
    status: String(record.status),
  };
}

/**
 * The production `BillingStore`: a thin, stateless mapping over the three
 * billing entity adapters. Constructed wherever the adapters are reachable
 * (`setupPost` via `maybeEntityAdapter`, or `onAdapter` wiring callbacks).
 */
export function createEntityBillingStore(adapters: BillingEntityAdapters): BillingStore {
  return {
    async findCustomerByOwnerId(ownerId) {
      const record = await findOne(adapters.customers, { ownerId });
      return record ? customerRowFrom(record) : null;
    },

    async createCustomer(input) {
      await adapters.customers.create({ ...input });
    },

    async findCustomerByProviderCustomerId(providerCustomerId) {
      const record = await findOne(adapters.customers, { providerCustomerId });
      return record ? customerRowFrom(record) : null;
    },

    async getSubscriptionByProviderSubscriptionId(providerSubscriptionId) {
      const record = await findOne(adapters.subscriptions, { providerSubscriptionId });
      return record ? subscriptionRowFrom(record) : null;
    },

    async listSubscriptionsByOwner(ownerId) {
      const { items } = await adapters.subscriptions.list({ filter: { ownerId } });
      return items.map(item => subscriptionRowFrom(asRecord(item)));
    },

    async createSubscription(input) {
      await adapters.subscriptions.create({
        ...input,
        currentPeriodEnd: toDateOrNull(input.currentPeriodEnd),
      });
    },

    async updateSubscription(id, patch) {
      const data: Record<string, unknown> = { ...patch };
      if ('currentPeriodEnd' in patch) {
        data.currentPeriodEnd = toDateOrNull(patch.currentPeriodEnd);
      }
      await adapters.subscriptions.update(id, data);
    },

    async findPaymentByProviderPaymentId(providerPaymentId) {
      const record = await findOne(adapters.payments, { providerPaymentId });
      return record ? paymentRowFrom(record) : null;
    },

    async createPayment(input) {
      await adapters.payments.create({ ...input });
    },
  };
}
