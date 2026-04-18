import type { MiddlewareHandler } from 'hono';

type MembershipCreateInput = Record<string, unknown> & {
  userId?: unknown;
  role?: unknown;
  tenantId?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Enforce that `ContainerMember.create` behaves as a self-join endpoint.
 *
 * The generated CRUD route accepts an arbitrary JSON body, so this middleware
 * normalizes the payload to the authenticated user and forces the persisted
 * membership role to `member`. Callers cannot join other users, self-promote,
 * or spoof tenant scope through the raw create route.
 */
export function createMemberJoinGuardMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const authUserId = c.get('authUserId' as never) as string | null | undefined;
    if (!authUserId) return c.json({ error: 'Unauthorized' }, 401);

    let body: MembershipCreateInput;
    try {
      const raw = (await c.req.json()) as unknown;
      if (!isRecord(raw)) return c.json({ error: 'Invalid JSON body' }, 400);
      body = raw;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (body.userId !== undefined && body.userId !== authUserId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (body.role !== undefined && body.role !== 'member') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const tenantId = (c.get('tenantId' as never) as string | null | undefined) ?? null;
    if (body.tenantId !== undefined && body.tenantId !== tenantId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const normalized: MembershipCreateInput = {
      ...body,
      userId: authUserId,
      role: 'member',
    };

    if (tenantId !== null) normalized.tenantId = tenantId;
    else delete normalized.tenantId;

    (c.req as unknown as { json: () => Promise<MembershipCreateInput> }).json = () =>
      Promise.resolve(normalized);

    await next();
  };
}
