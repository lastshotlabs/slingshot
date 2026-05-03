import type { MiddlewareHandler } from 'hono';

type ContainerRecord = {
  id: string;
  joinPolicy?: string;
  deletedAt?: unknown;
};

type ContainerAdapter = {
  getById(id: string): Promise<ContainerRecord | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Enforce container join policy on the raw self-join route.
 *
 * Invite-based joins use the invite redemption handler, which creates the
 * membership through the adapter rather than this public CRUD route.
 */
export function createMemberJoinPolicyGuardMiddleware(deps: {
  containerAdapter: ContainerAdapter;
}): MiddlewareHandler {
  return async (c, next) => {
    let containerId: string;
    try {
      const body = (await c.req.json()) as unknown;
      if (!isRecord(body)) return c.json({ error: 'Invalid JSON body' }, 400);
      containerId = typeof body.containerId === 'string' ? body.containerId : '';
    } catch {
      // Body is not valid JSON; reject with 400
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!containerId) return c.json({ error: 'containerId is required' }, 400);
    const container = await deps.containerAdapter.getById(containerId);
    if (!container || container.deletedAt) {
      return c.json({ error: 'Container not found' }, 404);
    }
    if ((container.joinPolicy ?? 'open') !== 'open') {
      return c.json({ error: 'Container is not open to direct joins' }, 403);
    }

    await next();
  };
}
