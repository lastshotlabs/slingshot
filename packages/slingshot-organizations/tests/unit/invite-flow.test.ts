import { describe, expect, test } from 'bun:test';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import type { OrganizationsAuthRuntime } from '../../src/lib/authRuntime';
import { createOrganizationsManifestRuntime } from '../../src/manifest/runtime';
import type { EntityPluginAfterAdaptersContext } from '@lastshotlabs/slingshot-entity';

/**
 * Minimal adapter-based tests for the invite lifecycle that exercise the
 * runtime's adapter transforms directly — no HTTP layer involved.
 */

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

interface MemberRow {
  id: string;
  orgId: string;
  userId: string;
  role: string;
}

interface InviteRow {
  id: string;
  orgId: string;
  invitedBy: string;
  email?: string | null;
  userId?: string | null;
  tokenHash: string;
  role: string;
  expiresAt: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}

type AnyRow = Record<string, unknown> & { id: string };

function createBareAdapter<T extends AnyRow>(rows: T[]): BareEntityAdapter {
  return {
    async create(input: unknown) {
      const next = { ...(input as T) };
      if (typeof next.id !== 'string' || next.id.length === 0) {
        next.id = `auto-${Math.random().toString(36).slice(2)}`;
      }
      rows.push(next);
      return next;
    },
    async getById(id: string) {
      return (rows.find(r => r.id === id) ?? null) as unknown;
    },
    async list(req: { filter?: Record<string, unknown>; limit?: number; cursor?: string }) {
      const filter = (req?.filter ?? {}) as Record<string, unknown>;
      const filtered = rows.filter(row =>
        Object.entries(filter).every(([key, value]) => row[key] === value),
      );
      return { items: filtered, nextCursor: undefined, hasMore: false };
    },
    async update(id: string, patch: Record<string, unknown>) {
      const idx = rows.findIndex(r => r.id === id);
      if (idx === -1) return null;
      rows[idx] = { ...rows[idx], ...patch } as T;
      return rows[idx];
    },
    async delete(id: string) {
      const idx = rows.findIndex(r => r.id === id);
      if (idx === -1) return false;
      rows.splice(idx, 1);
      return true;
    },
  } as unknown as BareEntityAdapter;
}

async function setupInviteEnv() {
  const orgs: OrgRow[] = [];
  const members: MemberRow[] = [];
  const invites: InviteRow[] = [];

  const baseAdapters = {
    Organization: createBareAdapter(orgs as unknown as AnyRow[]),
    OrganizationMember: createBareAdapter(members as unknown as AnyRow[]),
    OrganizationInvite: createBareAdapter(invites as unknown as AnyRow[]),
  };

  const authRuntime: OrganizationsAuthRuntime = {
    adapter: {
      async getUser() {
        return { email: 'user@example.com', suspended: false };
      },
      async getEmailVerified() {
        return true;
      },
    },
  };

  const runtime = createOrganizationsManifestRuntime({
    authRuntime,
    invitationTtlSeconds: 3600,
    defaultMemberRole: 'member',
  });

  const stubCtx = {} as Parameters<ReturnType<typeof runtime.adapterTransforms.resolve>>[1];
  const transformed = {
    Organization: (await runtime.adapterTransforms.resolve('organizations.organization.deleteCascade')(
      baseAdapters.Organization,
      stubCtx,
    )) as BareEntityAdapter,
    OrganizationMember: (await runtime.adapterTransforms.resolve('organizations.member.identity')(
      baseAdapters.OrganizationMember,
      stubCtx,
    )) as BareEntityAdapter,
    OrganizationInvite: (await runtime.adapterTransforms.resolve('organizations.invite.runtime')(
      baseAdapters.OrganizationInvite,
      stubCtx,
    )) as BareEntityAdapter & { findPendingByToken: (t: string) => Promise<InviteRow | null>; reveal: (id: string) => Promise<InviteRow | null> },
  };

  const captureHook = runtime.hooks.resolve('organizations.captureAdapters');
  captureHook({
    adapters: transformed,
  } as unknown as EntityPluginAfterAdaptersContext);

  const driverArrow = runtime.customHandlers.resolve('organizations.invite.redeem') as (
    driver: unknown,
  ) => (input: Record<string, unknown>) => Promise<unknown>;
  const redeem = driverArrow(undefined);

  const revokeHandler = runtime.customHandlers.resolve('organizations.invite.revoke') as (
    driver: unknown,
  ) => (input: Record<string, unknown>) => Promise<unknown>;
  const revoke = revokeHandler(undefined);

  const findByTokenHandler = runtime.customHandlers.resolve('organizations.invite.findByToken') as (
    driver: unknown,
  ) => (input: Record<string, unknown>) => Promise<unknown>;
  const findByToken = findByTokenHandler(undefined);

  return {
    runtime,
    inviteAdapter: transformed.OrganizationInvite,
    memberAdapter: transformed.OrganizationMember,
    orgAdapter: transformed.Organization,
    state: { orgs, members, invites },
    redeem,
    revoke,
    findByToken,
    async createOrg(id: string) {
      orgs.push({ id, name: 'Org', slug: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    },
    async createInvite(orgId: string, overrides?: Record<string, unknown>) {
      return transformed.OrganizationInvite.create({
        orgId,
        invitedBy: 'admin',
        role: 'member',
        ...overrides,
      }) as Promise<InviteRow & { token: string }>;
    },
  };
}

describe('invite creation', () => {
  test('creates an invite and returns a raw token', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-create-1');

    const result = (await env.createInvite('org-create-1')) as { id: string; token: string };
    expect(result.id).toBeTruthy();
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);

    // The raw token must not be stored in the persisted record
    const persisted = env.state.invites[0];
    expect(persisted.tokenHash).toBeTruthy();
    expect(persisted.tokenHash).not.toBe(result.token);
  });

  test('invite creation with idempotencyKey returns the same invite', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-idem');

    const first = (await env.createInvite('org-idem', {
      idempotencyKey: 'key-1',
    })) as { id: string; token: string };

    const second = (await env.createInvite('org-idem', {
      idempotencyKey: 'key-1',
    })) as { id: string; token: string };

    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
  });

  test('invite creation without idempotencyKey creates distinct rows', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-no-idem');

    const first = (await env.createInvite('org-no-idem')) as { id: string };
    const second = (await env.createInvite('org-no-idem')) as { id: string };

    expect(first.id).not.toBe(second.id);
  });

  test('invite expiry is set to now + invitationTtlSeconds', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-ttl');

    const before = Date.now();
    const result = (await env.createInvite('org-ttl')) as { id: string };
    const after = Date.now();

    const persisted = env.state.invites.find(i => i.id === result.id)!;
    const expiresAt = new Date(persisted.expiresAt).getTime();
    // Should be roughly now + 3600s (with some tolerance for test execution)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_500_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3_700_000);
  });
});

describe('invite findPendingByToken', () => {
  test('findPendingByToken returns the invite for a valid pending token', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-find-1');

    const created = (await env.createInvite('org-find-1')) as { id: string; token: string };
    const pending = await env.inviteAdapter.findPendingByToken(created.token);
    expect(pending).not.toBeNull();
    expect(pending!.orgId).toBe('org-find-1');
  });

  test('findPendingByToken returns null for an accepted invite', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-accepted');

    const created = (await env.createInvite('org-accepted')) as { id: string; token: string };

    // Manually mark as accepted
    const persisted = env.state.invites[0];
    persisted.acceptedAt = new Date().toISOString();

    const result = await env.inviteAdapter.findPendingByToken(created.token);
    expect(result).toBeNull();
  });

  test('findPendingByToken returns null for a revoked invite', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-revoked');

    const created = (await env.createInvite('org-revoked')) as { id: string; token: string };

    // Manually mark as revoked
    const persisted = env.state.invites[0];
    persisted.revokedAt = new Date().toISOString();

    const result = await env.inviteAdapter.findPendingByToken(created.token);
    expect(result).toBeNull();
  });

  test('findPendingByToken returns null for an expired invite', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-expired');

    const created = (await env.createInvite('org-expired')) as { id: string; token: string };

    // Set expiry in the past
    const persisted = env.state.invites[0];
    persisted.expiresAt = new Date(Date.now() - 1000).toISOString();

    const result = await env.inviteAdapter.findPendingByToken(created.token);
    expect(result).toBeNull();
  });

  test('findPendingByToken returns null for an unknown token', async () => {
    const env = await setupInviteEnv();
    const result = await env.inviteAdapter.findPendingByToken('nonexistent-token');
    expect(result).toBeNull();
  });
});

describe('invite redeem', () => {
  test('redeem creates a membership and marks invite accepted', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-redeem-1');

    const created = (await env.createInvite('org-redeem-1')) as { token: string };

    const result = (await env.redeem({
      token: created.token,
      'actor.id': 'user-1',
    })) as { membership: { id: string }; alreadyMember: boolean };

    expect(result.membership).toBeTruthy();
    expect(result.alreadyMember).toBe(false);

    // Invite should be marked accepted
    const inviteRow = env.state.invites[0];
    expect(inviteRow.acceptedAt).toBeTruthy();
  });

  test('redeeming an accepted invite returns not-found', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-redeem-2');

    const created = (await env.createInvite('org-redeem-2')) as { token: string };

    // First redeem succeeds
    await env.redeem({ token: created.token, 'actor.id': 'user-2' });

    // Second redeem should fail because findPendingByToken returns null
    let caught: unknown;
    try {
      await env.redeem({ token: created.token, 'actor.id': 'user-2' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const status = (caught as { status?: number }).status;
    expect(status).toBe(404);
  });

  test('redeem with an expired token returns 404', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-exp-redeem');

    // Create invite and manually back-date the expiry
    const created = (await env.createInvite('org-exp-redeem')) as { token: string };
    env.state.invites[0].expiresAt = new Date(Date.now() - 10_000).toISOString();

    let caught: unknown;
    try {
      await env.redeem({ token: created.token, 'actor.id': 'user-exp' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status?: number }).status).toBe(404);
  });
});

describe('invite revoke', () => {
  test('revoke sets revokedAt on the invite', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-revoke-1');

    const created = (await env.createInvite('org-revoke-1')) as { id: string; token: string };

    const result = (await env.revoke({ id: created.id })) as { id: string; revokedAt: string };
    expect(result.revokedAt).toBeTruthy();
  });

  test('revoking a non-existent invite returns 404', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-revoke-miss');

    let caught: unknown;
    try {
      await env.revoke({ id: 'nonexistent-id' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status?: number }).status).toBe(404);
  });

  test('revoked invite is not findable by token', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-revoke-2');

    const created = (await env.createInvite('org-revoke-2')) as { id: string; token: string };

    await env.revoke({ id: created.id });

    const found = await env.inviteAdapter.findPendingByToken(created.token);
    expect(found).toBeNull();
  });
});

describe('invite findByToken (sanitized lookup)', () => {
  test('findByToken returns sanitized invite info (no token, no id)', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-lookup');

    const created = (await env.createInvite('org-lookup')) as { token: string };

    const result = (await env.findByToken({ token: created.token })) as Record<string, unknown> | null;
    expect(result).not.toBeNull();
    expect(result!.orgId).toBe('org-lookup');
    expect(result!.role).toBe('member');
    expect(result!.expiresAt).toBeTruthy();
    // Sanitized lookup should NOT include id or token
    expect(result!.id).toBeUndefined();
    expect(result!.token).toBeUndefined();
  });

  test('findByToken returns null for unknown token', async () => {
    const env = await setupInviteEnv();
    const result = await env.findByToken({ token: 'unknown-token' });
    expect(result).toBeNull();
  });

  test('findByToken returns null for accepted invite', async () => {
    const env = await setupInviteEnv();
    await env.createOrg('org-lookup-accepted');

    const created = (await env.createInvite('org-lookup-accepted')) as { token: string };
    env.state.invites[0].acceptedAt = new Date().toISOString();

    const result = await env.findByToken({ token: created.token });
    expect(result).toBeNull();
  });
});
