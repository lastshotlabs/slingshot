import { describe, expect, it } from 'bun:test';
import {
  type EventDefinitionRegistry,
  createEventDefinitionRegistry,
  defineEvent,
} from '@lastshotlabs/slingshot-core';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import { type WebhookRuntimeAdapter, createWebhooksManifestRuntime } from '../src/manifest/runtime';
import type { WebhookAttempt, WebhookEndpointSubscription } from '../src/types/models';
import { WebhookSecretDecryptError } from '../src/types/queue';

/**
 * Coverage for the secret-decryption fail-closed path.
 *
 * The webhook runtime intentionally throws {@link WebhookSecretDecryptError}
 * when the cipher cannot recover a stored endpoint secret rather than falling
 * back to the ciphertext. These tests prove:
 *
 * 1. A delivery cannot be dispatched when its secret cannot be decrypted —
 *    it is dropped (effectively dead-lettered) without leaking material.
 * 2. The thrown error contains NO ciphertext-shaped data: no base64 blobs,
 *    no hex blobs, no JSON envelope braces. Only the endpoint id is
 *    surfaced, so operators can identify the broken row.
 * 3. After rotating the encryption configuration so decrypt no longer
 *    fails, subsequent dispatches succeed.
 */

// Augment the event map so the test events typecheck against the bus surface.
declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'test:secret.decrypt.failure': { tenantId: string; id: string };
  }
}

type EndpointRecord = {
  id: string;
  ownerType?: 'tenant' | 'user' | 'app' | 'system';
  ownerId?: string;
  tenantId?: string | null;
  url: string;
  secret: string;
  subscriptions?: WebhookEndpointSubscription[];
  events?: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type DeliveryRecord = {
  id: string;
  tenantId?: string | null;
  endpointId: string;
  event: string;
  eventId: string;
  occurredAt: string;
  subscriber: {
    ownerType: 'tenant' | 'user' | 'app' | 'system';
    ownerId: string;
    tenantId?: string | null;
  };
  sourceScope?: { tenantId?: string | null } | null;
  projectedPayload: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  attempts: number;
  nextRetryAt?: string | null;
  lastAttempt?: WebhookAttempt;
  createdAt: string;
  updatedAt: string;
};

function createDefinitions(): EventDefinitionRegistry {
  const definitions = createEventDefinitionRegistry();
  definitions.register(
    defineEvent('test:secret.decrypt.failure', {
      ownerPlugin: 'test-secret-decrypt-failure',
      exposure: ['tenant-webhook'],
      resolveScope(payload) {
        return { tenantId: payload.tenantId };
      },
    }),
  );
  return definitions;
}

function paginate<T>(
  items: T[],
  cursor: string | undefined,
  limit: number | undefined,
): {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
} {
  const start = cursor ? Number(cursor) : 0;
  const pageSize = limit ?? items.length;
  const pageItems = items.slice(start, start + pageSize);
  const nextIndex = start + pageItems.length;
  return {
    items: pageItems,
    nextCursor: nextIndex < items.length ? String(nextIndex) : undefined,
    hasMore: nextIndex < items.length,
  };
}

function createEndpointBaseAdapter(records: EndpointRecord[]): BareEntityAdapter {
  return {
    async create(input: unknown) {
      const record = input as EndpointRecord;
      records.push(record);
      return record;
    },
    async getById(id: string) {
      return records.find(record => record.id === id) ?? null;
    },
    async list(opts: { filter?: unknown; limit?: number; cursor?: string }) {
      const filter = (opts.filter ?? {}) as { enabled?: boolean };
      const filtered = records.filter(record =>
        filter.enabled === undefined ? true : record.enabled === filter.enabled,
      );
      return paginate(filtered, opts.cursor, opts.limit);
    },
    async update(id: string, input: unknown) {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) return null;
      records[index] = { ...records[index]!, ...(input as Partial<EndpointRecord>) };
      return records[index]!;
    },
    async delete() {
      return true;
    },
  };
}

function createDeliveryBaseAdapter(records: DeliveryRecord[]): BareEntityAdapter {
  return {
    async create(input: unknown) {
      const record = input as DeliveryRecord;
      records.push(record);
      return record;
    },
    async getById(id: string) {
      return records.find(record => record.id === id) ?? null;
    },
    async list(opts: { filter?: unknown; limit?: number; cursor?: string }) {
      const filter = (opts.filter ?? {}) as { endpointId?: string };
      const filtered = records.filter(record =>
        filter.endpointId === undefined ? true : record.endpointId === filter.endpointId,
      );
      return paginate(filtered, opts.cursor, opts.limit);
    },
    async update(id: string, input: unknown) {
      const index = records.findIndex(record => record.id === id);
      if (index < 0) return null;
      records[index] = { ...records[index]!, ...(input as Partial<DeliveryRecord>) };
      return records[index]!;
    },
    async delete() {
      return true;
    },
    async transition(input: {
      id: string;
      status: DeliveryRecord['status'];
      attempts?: number;
      nextRetryAt?: string | null;
      lastAttempt?: WebhookAttempt;
    }) {
      const index = records.findIndex(record => record.id === input.id);
      if (index < 0) {
        throw new Error('Delivery not found');
      }
      records[index] = {
        ...records[index]!,
        status: input.status,
        attempts: input.attempts ?? records[index]!.attempts,
        nextRetryAt: input.nextRetryAt ?? null,
        lastAttempt: input.lastAttempt,
      };
      return records[index]!;
    },
  };
}

async function setupRuntime(options: {
  endpoints: EndpointRecord[];
  deliveries?: DeliveryRecord[];
  manifestRuntimeOptions?: Parameters<typeof createWebhooksManifestRuntime>[1];
}): Promise<{ runtime: WebhookRuntimeAdapter }> {
  let runtimeAdapter: WebhookRuntimeAdapter | undefined;
  const manifestRuntime = createWebhooksManifestRuntime(adapter => {
    runtimeAdapter = adapter;
  }, options.manifestRuntimeOptions);

  const endpointAdapter = createEndpointBaseAdapter(options.endpoints);
  const deliveryAdapter = createDeliveryBaseAdapter(options.deliveries ?? []);

  const transformCtx = {
    app: {} as never,
    bus: {} as never,
    pluginName: 'webhooks',
    entityName: 'WebhookEndpoint',
    adapters: {},
  };

  const transformedEndpointAdapter = await manifestRuntime.adapterTransforms!.resolve(
    'webhooks.endpoint.runtime',
  )(endpointAdapter, transformCtx as never);
  const transformedDeliveryAdapter = await manifestRuntime.adapterTransforms!.resolve(
    'webhooks.delivery.runtime',
  )(deliveryAdapter, { ...transformCtx, entityName: 'WebhookDelivery' } as never);

  await manifestRuntime.hooks!.resolve('webhooks.captureAdapters')({
    app: {} as never,
    bus: {} as never,
    pluginName: 'webhooks',
    adapters: {
      WebhookEndpoint: transformedEndpointAdapter,
      WebhookDelivery: transformedDeliveryAdapter,
    },
    permissions: null,
  });

  if (!runtimeAdapter) {
    throw new Error('failed to capture webhook runtime adapter');
  }

  return { runtime: runtimeAdapter };
}

// A ciphertext-shaped string designed to look exactly like the kind of value a
// real cipher implementation might leak: a JSON envelope wrapping a base64 blob
// and a hex IV/tag. We assert the runtime never emits any of these substrings
// in the raised error.
const CIPHERTEXT_BLOB =
  '{"v":1,"iv":"3a7f1c9b8e22d40e9a0fbc11","ct":"VGhpcyBpcyBhIHN1cGVyIHNlY3JldCBjaXBoZXJ0ZXh0IFhYWFhYWFhYWA=="}';

const CIPHERTEXT_FRAGMENTS = [
  CIPHERTEXT_BLOB,
  '3a7f1c9b8e22d40e9a0fbc11',
  'VGhpcyBpcyBhIHN1cGVyIHNlY3JldCBjaXBoZXJ0ZXh0IFhYWFhYWFhYWA==',
];

// Anything resembling base64 (>= 24 chars), hex (>= 16 chars), or a JSON
// envelope brace pair. The error message is so short that legitimate words do
// not trip these patterns; the endpoint id is a kebab-case string by design.
const BASE64_BLOB_REGEX = /[A-Za-z0-9+/]{24,}={0,2}/;
const HEX_BLOB_REGEX = /[0-9a-fA-F]{16,}/;
const JSON_ENVELOPE_REGEX = /[{}]/;

describe('webhook secret decrypt failure path', () => {
  it('fails closed without leaking ciphertext or key material in the thrown error', async () => {
    const errorFields: Array<Record<string, unknown> | undefined> = [];
    const errorMessages: string[] = [];

    // Cipher implementation whose decrypt error message embeds the very
    // ciphertext we want to keep out of operator-visible logs.
    const failingEncryptor = {
      encrypt: (plaintext: string) => Promise.resolve(plaintext),
      decrypt: () =>
        Promise.reject(new Error(`bad key while decrypting envelope ${CIPHERTEXT_BLOB} - retry`)),
    };

    const endpoints: EndpointRecord[] = [
      {
        id: 'endpoint-broken',
        ownerType: 'tenant',
        ownerId: 'tenant-a',
        tenantId: 'tenant-a',
        url: 'https://example.com/broken',
        secret: CIPHERTEXT_BLOB,
        subscriptions: [{ event: 'test:secret.decrypt.failure', exposure: 'tenant-webhook' }],
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const { runtime } = await setupRuntime({
      endpoints,
      manifestRuntimeOptions: {
        encryptor: failingEncryptor,
        logger: {
          error(message, fields) {
            errorMessages.push(message);
            errorFields.push(fields);
          },
          warn() {},
        },
      },
    });

    let caught: unknown;
    try {
      await runtime.getEndpoint('endpoint-broken');
    } catch (err) {
      caught = err;
    }

    // 1. Fail-closed: a typed error is raised, not a fallback to ciphertext.
    expect(caught).toBeInstanceOf(WebhookSecretDecryptError);
    const typed = caught as WebhookSecretDecryptError;

    // 2. Operators can identify the broken endpoint by id...
    expect(typed.endpointId).toBe('endpoint-broken');
    expect(typed.message).toContain('endpoint-broken');

    // 3. ...but the cipher value is NOT in the message.
    for (const fragment of CIPHERTEXT_FRAGMENTS) {
      expect(typed.message).not.toContain(fragment);
    }

    // 4. The error message contains nothing that LOOKS like ciphertext: no
    //    base64-shaped blob, no hex blob, no JSON envelope braces. The
    //    canonical shape is a fixed sentence with the endpoint id substituted.
    expect(typed.message).not.toMatch(BASE64_BLOB_REGEX);
    expect(typed.message).not.toMatch(HEX_BLOB_REGEX);
    expect(typed.message).not.toMatch(JSON_ENVELOPE_REGEX);

    // 5. Stable `name` so log aggregators can index error class. (We do not
    //    apply the base64 regex here — the class name is constant, not a
    //    secret-leak vector.)
    expect(typed.name).toBe('WebhookSecretDecryptError');

    // 6. toString() must also be safe to log: no cipher fragments anywhere.
    const stringified = typed.toString();
    for (const fragment of CIPHERTEXT_FRAGMENTS) {
      expect(stringified).not.toContain(fragment);
    }

    // 7. Structured log fields must not contain the cipher value either. The
    //    runtime explicitly avoids interpolating err.message into the logger
    //    payload precisely because cipher implementations can embed cipher
    //    values into their messages — this assertion proves that contract.
    expect(errorMessages.some(m => m.includes('failed to decrypt'))).toBe(true);
    for (const fields of errorFields) {
      if (!fields) continue;
      for (const value of Object.values(fields)) {
        if (typeof value !== 'string') continue;
        for (const fragment of CIPHERTEXT_FRAGMENTS) {
          expect(value).not.toContain(fragment);
        }
      }
    }
  });

  it('marks the delivery dead by skipping it from the dispatch list (no leak)', async () => {
    // listEnabledEndpoints is the entry point used by the dispatcher to
    // discover targets. When a row's secret cannot be decrypted, that row is
    // dropped from the dispatch list rather than emitted with garbage data —
    // this is the runtime's equivalent of "dead-letter without leaking".
    const failingEncryptor = {
      encrypt: (plaintext: string) => Promise.resolve(plaintext),
      decrypt: (stored: string) => {
        if (stored.startsWith('valid:')) return Promise.resolve(stored.slice('valid:'.length));
        return Promise.reject(new Error(`bad key for blob ${CIPHERTEXT_BLOB}`));
      },
    };

    const errorFields: Array<Record<string, unknown> | undefined> = [];
    const endpoints: EndpointRecord[] = [
      {
        id: 'endpoint-broken',
        ownerType: 'tenant',
        ownerId: 'tenant-a',
        tenantId: 'tenant-a',
        url: 'https://example.com/broken',
        secret: CIPHERTEXT_BLOB,
        subscriptions: [{ event: 'test:secret.decrypt.failure', exposure: 'tenant-webhook' }],
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'endpoint-healthy',
        ownerType: 'tenant',
        ownerId: 'tenant-a',
        tenantId: 'tenant-a',
        url: 'https://example.com/healthy',
        secret: 'valid:plaintext-secret',
        subscriptions: [{ event: 'test:secret.decrypt.failure', exposure: 'tenant-webhook' }],
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const { runtime } = await setupRuntime({
      endpoints,
      manifestRuntimeOptions: {
        encryptor: failingEncryptor,
        logger: {
          error(_message, fields) {
            errorFields.push(fields);
          },
          warn() {},
        },
      },
    });

    const dispatchable = await runtime.listEnabledEndpoints();

    // The broken row is excluded; the healthy row goes through with plaintext.
    expect(dispatchable.map(e => e.id)).toEqual(['endpoint-healthy']);
    expect(dispatchable[0]?.secret).toBe('plaintext-secret');

    // None of the values surfaced through the dispatch path may equal the
    // ciphertext blob (which would mean a fall-back leak).
    for (const endpoint of dispatchable) {
      for (const fragment of CIPHERTEXT_FRAGMENTS) {
        expect(endpoint.secret).not.toContain(fragment);
        expect(endpoint.url).not.toContain(fragment);
      }
    }

    // And the structured log fields must still be cipher-free.
    for (const fields of errorFields) {
      if (!fields) continue;
      for (const value of Object.values(fields)) {
        if (typeof value !== 'string') continue;
        for (const fragment of CIPHERTEXT_FRAGMENTS) {
          expect(value).not.toContain(fragment);
        }
      }
    }
  });

  it('recovers after the secret cipher is rotated to one that can decrypt the row', async () => {
    // Simulate operator action: a faulty cipher is in place at first, then
    // the runtime is rebuilt with a working cipher and the same stored row.
    // The "rotation" here means the operator deploys a new runtime instance
    // whose encryptor can decrypt the existing ciphertext (e.g. because the
    // correct KMS key has been provisioned). Subsequent reads succeed and the
    // delivery path produces a sane plaintext secret.
    const STORED = 'rotated-cipher-blob:my-real-secret';

    const brokenEncryptor = {
      encrypt: (plaintext: string) => Promise.resolve(plaintext),
      decrypt: () => Promise.reject(new Error(`temporary outage on ${CIPHERTEXT_BLOB}`)),
    };

    const workingEncryptor = {
      encrypt: (plaintext: string) => Promise.resolve(plaintext),
      decrypt: (stored: string) =>
        Promise.resolve(
          stored.startsWith('rotated-cipher-blob:')
            ? stored.slice('rotated-cipher-blob:'.length)
            : stored,
        ),
    };

    const endpoints: EndpointRecord[] = [
      {
        id: 'endpoint-rotated',
        ownerType: 'tenant',
        ownerId: 'tenant-a',
        tenantId: 'tenant-a',
        url: 'https://example.com/rotated',
        secret: STORED,
        subscriptions: [{ event: 'test:secret.decrypt.failure', exposure: 'tenant-webhook' }],
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    // Phase 1: broken cipher — getEndpoint fails closed.
    const broken = await setupRuntime({
      endpoints,
      manifestRuntimeOptions: {
        encryptor: brokenEncryptor,
        logger: { error() {}, warn() {} },
      },
    });
    await expect(broken.runtime.getEndpoint('endpoint-rotated')).rejects.toBeInstanceOf(
      WebhookSecretDecryptError,
    );
    expect(await broken.runtime.listEnabledEndpoints()).toHaveLength(0);

    // Phase 2: rotated cipher — same stored row now decrypts cleanly.
    const rotated = await setupRuntime({
      endpoints,
      manifestRuntimeOptions: {
        encryptor: workingEncryptor,
        logger: { error() {}, warn() {} },
      },
    });

    const fetched = await rotated.runtime.getEndpoint('endpoint-rotated');
    expect(fetched).not.toBeNull();
    expect(fetched?.secret).toBe('my-real-secret');

    const enabled = await rotated.runtime.listEnabledEndpoints();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.secret).toBe('my-real-secret');
  });
});
