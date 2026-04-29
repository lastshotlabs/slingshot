// ---------------------------------------------------------------------------
// @lastshotlabs/slingshot-orchestration-plugin/testing — Test utilities
// ---------------------------------------------------------------------------

/** Standard timeouts for orchestration plugin route tests. */
export const TEST_ROUTE_TIMEOUT_MS = 5_000;

/** Default page size for list endpoints in tests. */
export const TEST_DEFAULT_PAGE_SIZE = 20;

/** Create a minimal valid orchestration request context for testing. */
export function createTestRequestContext(overrides?: {
  tenantId?: string;
  actorId?: string;
  tags?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  return {
    tenantId: overrides?.tenantId ?? 'test-tenant',
    actorId: overrides?.actorId ?? 'test-actor',
    tags: overrides?.tags ?? {},
    metadata: overrides?.metadata ?? {},
  };
}
