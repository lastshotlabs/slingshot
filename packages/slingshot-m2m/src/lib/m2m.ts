import type { AuthAdapter, M2MClientRecord, RuntimePassword } from '@lastshotlabs/slingshot-core';

/**
 * Look up an M2M client by `clientId`. Only active clients are returned.
 *
 * @param adapter - The `AuthAdapter` that stores M2M client records.
 * @param clientId - The client's unique identifier.
 * @returns The client record (including `clientSecretHash` for verification),
 *   or `null` if not found or if the adapter does not support M2M.
 *
 * @example
 * ```ts
 * import { getM2MClient } from '@lastshotlabs/slingshot-m2m';
 *
 * const client = await getM2MClient(adapter, 'my-service');
 * if (!client) throw new Error('Unknown client');
 * ```
 */
export async function getM2MClient(
  adapter: AuthAdapter,
  clientId: string,
): Promise<(M2MClientRecord & { clientSecretHash: string }) | null> {
  if (!adapter.getM2MClient) return null;
  return adapter.getM2MClient(clientId);
}

/**
 * Create a new M2M client and return the auto-generated plaintext secret.
 *
 * The secret is hashed with the caller-provided `RuntimePassword` before being persisted;
 * it is **never stored in plaintext**. The returned `clientSecret` is shown only once
 * and cannot be recovered later; callers must store it securely.
 *
 * @param opts.clientId - Human-readable identifier for the client (must be unique).
 * @param opts.name - Display name for the client.
 * @param opts.scopes - OAuth scopes the client is allowed to request. Defaults to `[]`.
 * @param opts.adapter - The `AuthAdapter` that persists the client record.
 * @param opts.password - Runtime password implementation used to hash the client secret.
 * @returns `{ id, clientId, clientSecret }` where `clientSecret` is the
 *   one-time plaintext secret.
 *
 * @throws {Error} If the adapter does not support M2M client creation.
 *
 * @remarks
 * The plaintext secret is generated as two UUID v4 values joined with `'-'`:
 * `"<uuidv4>-<uuidv4>"` (two `crypto.randomUUID()` calls concatenated). This
 * produces a high-entropy secret. The secret is immediately hashed via the supplied
 * `RuntimePassword` and only the hash is persisted; the plaintext is returned
 * once and cannot be recovered.
 *
 * @example
 * ```ts
 * import { createM2MClient } from '@lastshotlabs/slingshot-m2m';
 *
 * const { clientId, clientSecret } = await createM2MClient({
 *   clientId: 'billing-service',
 *   name: 'Billing Service',
 *   scopes: ['read:invoices', 'write:invoices'],
 *   adapter,
 *   password,
 * });
 * // Store clientSecret securely - it cannot be retrieved again.
 * ```
 */
export async function createM2MClient(opts: {
  clientId: string;
  name: string;
  scopes?: string[];
  adapter: AuthAdapter;
  password: RuntimePassword;
}): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const { adapter, password } = opts;
  if (!adapter.createM2MClient) {
    throw new Error('Auth adapter does not support M2M clients');
  }
  const existingClient = adapter.getM2MClient ? await adapter.getM2MClient(opts.clientId) : null;
  if (existingClient) {
    throw new Error(`M2M client already exists: ${opts.clientId}`);
  }
  const clientSecret = crypto.randomUUID() + '-' + crypto.randomUUID();
  const clientSecretHash = await password.hash(clientSecret);
  const { id } = await adapter.createM2MClient({
    clientId: opts.clientId,
    clientSecretHash,
    name: opts.name,
    scopes: opts.scopes ?? [],
  });
  return { id, clientId: opts.clientId, clientSecret };
}

/**
 * Delete an M2M client by `clientId`.
 *
 * No-op if the adapter does not support M2M client deletion or if the client
 * does not exist.
 *
 * @param adapter - The `AuthAdapter` that stores M2M client records.
 * @param clientId - The client's unique identifier.
 *
 * @example
 * ```ts
 * import { deleteM2MClient } from '@lastshotlabs/slingshot-m2m';
 *
 * await deleteM2MClient(adapter, 'billing-service');
 * ```
 */
export async function deleteM2MClient(adapter: AuthAdapter, clientId: string): Promise<void> {
  if (adapter.deleteM2MClient) {
    await adapter.deleteM2MClient(clientId);
  }
}

/**
 * List all M2M clients registered with the adapter.
 *
 * Client secret hashes are **not** included in the returned records. Returns
 * an empty array if the adapter does not support M2M client listing.
 *
 * @param adapter - The `AuthAdapter` that stores M2M client records.
 * @returns An array of `M2MClientRecord` objects (without secret hashes).
 *
 * @remarks
 * `clientSecretHash` is intentionally excluded from list results. The hash
 * is persisted internally for credential verification only and must never be
 * exposed through list or read APIs. Secret hashes returned by
 * `getM2MClient` are only available to the authentication layer for
 * verification, not to callers of this function.
 *
 * @example
 * ```ts
 * import { listM2MClients } from '@lastshotlabs/slingshot-m2m';
 *
 * const clients = await listM2MClients(adapter);
 * console.log(clients.map(c => c.clientId));
 * ```
 */
export async function listM2MClients(adapter: AuthAdapter): Promise<M2MClientRecord[]> {
  if (!adapter.listM2MClients) return [];
  return adapter.listM2MClients();
}
