/**
 * The minimal PostgreSQL client contract required to establish an RLS tenant
 * inside the caller's current transaction.
 */
export interface PostgresTenantContextClient {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

/**
 * Bind PostgreSQL row-level-security policies to a tenant for the current
 * transaction. The third `set_config` argument is deliberately `true`, so a
 * pooled connection cannot retain tenant identity after COMMIT or ROLLBACK.
 */
export async function setPostgresTenantContext(
  client: PostgresTenantContextClient,
  tenantId: string,
): Promise<void> {
  if (tenantId.trim().length === 0) {
    throw new Error('PostgreSQL tenant context requires a non-empty tenantId');
  }
  await client.query(`SELECT set_config('slingshot.tenant_id', $1, true)`, [tenantId]);
}
