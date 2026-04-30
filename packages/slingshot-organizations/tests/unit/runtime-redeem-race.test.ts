import { describe, expect, test } from 'bun:test';
import type {
  BareEntityAdapter,
  EntityPluginAfterAdaptersContext,
} from '@lastshotlabs/slingshot-entity';
import type { OrganizationsAuthRuntime } from '../../src/lib/authRuntime';
import { createOrganizationsManifestRuntime } from '../../src/manifest/runtime';

/**
 * Unit tests that drive the runtime's `invite.redeem` and cascade-delete
 * handlers directly. These bypass HTTP entirely and let us inject failures
 * into specific adapter methods to exercise the race-recovery and
 * partial-cascade paths called out by P-ORG-7/8/9/10/11.
 */

interface BaseRow {
  id: string;
}

interface MemberRow extends BaseRow {
  orgId: string;
  userId: string;
  role: string;
  invitedBy?: string;
}

interface InviteRow extends BaseRow {
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

interface OrgRow extends BaseRow {
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow extends BaseRow {
  orgId: string;
  name: string;
}

interface GroupMembershipRow extends BaseRow {
  groupId: string;
  userId: string;
  role: string;
}

type AnyRow = Record<string, unknown> & BaseRow;

function createBareAdapter<T extends AnyRow>(rows: T[]): BareEntityAdapter {
  return {
    async create(input: unknown) {
      const next = { ...(input as T) };
      if (typeof next.id !== 'string' || next.id.length === 0) {
        next.id = `auto-${Math.random().toString(36).slice(2)}` as T['id'];
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

async function setup(args?: { authUser?: { email?: string; suspended?: boolean } }) {
  const orgs: OrgRow[] = [];
  const members: MemberRow[] = [];
  const invites: InviteRow[] = [];
  const groups: GroupRow[] = [];
  const groupMemberships: GroupMembershipRow[] = [];

  const baseAdapters = {
    Organization: createBareAdapter(orgs as unknown as AnyRow[]),
    OrganizationMember: createBareAdapter(members as unknown as AnyRow[]),
    OrganizationInvite: createBareAdapter(invites as unknown as AnyRow[]),
    Group: createBareAdapter(groups as unknown as AnyRow[]),
    GroupMembership: createBareAdapter(groupMemberships as unknown as AnyRow[]),
  };

  const authRuntime: OrganizationsAuthRuntime = {
    adapter: {
      async getUser() {
        return args?.authUser
          ? { email: args.authUser.email, suspended: args.authUser.suspended ?? false }
          : null;
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

  // Apply the registered adapter transforms in the order the entity layer
  // would, so each captured adapter gains the runtime helpers (token hashing,
  // findPendingByToken, deleteCascade, etc.). The runtime transforms in this
  // package are all synchronous and ignore the second `ctx` argument; a stub
  // context is enough for tests.
  const adapterTransforms = runtime.adapterTransforms!;
  const stubCtx = {} as Parameters<ReturnType<typeof adapterTransforms.resolve>>[1];
  const transformed = {
    Organization: (await runtime.adapterTransforms!.resolve(
      'organizations.organization.deleteCascade',
    )(baseAdapters.Organization, stubCtx)) as BareEntityAdapter,
    OrganizationMember: (await runtime.adapterTransforms!.resolve('organizations.member.identity')(
      baseAdapters.OrganizationMember,
      stubCtx,
    )) as BareEntityAdapter,
    OrganizationInvite: (await runtime.adapterTransforms!.resolve('organizations.invite.runtime')(
      baseAdapters.OrganizationInvite,
      stubCtx,
    )) as BareEntityAdapter,
    Group: baseAdapters.Group,
    GroupMembership: (await runtime.adapterTransforms!.resolve(
      'organizations.groupMembership.identity',
    )(baseAdapters.GroupMembership, stubCtx)) as BareEntityAdapter,
  };

  // Run the captureAdapters hook so the runtime's internal `refs` point at the
  // transformed adapters (the cascade delete and redeem handlers consume those
  // refs to do their work).
  const captureHook = runtime.hooks!.resolve('organizations.captureAdapters');
  captureHook({
    adapters: transformed,
  } as unknown as EntityPluginAfterAdaptersContext);

  // Resolve the redeem custom handler. `resolve()` invokes the outer factory
  // with the optional manifest params, so the returned value is the
  // `(backendDriver) => async (input) => {...}` function. Call it with an
  // unused driver to get the actual async handler.
  type Handler = (input: Record<string, unknown>) => Promise<unknown>;
  const driverArrow = runtime.customHandlers!.resolve('organizations.invite.redeem') as (
    driver: unknown,
  ) => Handler;
  const redeem = driverArrow(undefined);

  return {
    runtime,
    adapters: transformed,
    state: { orgs, members, invites, groups, groupMemberships },
    redeem,
    createOrgRow(row: OrgRow) {
      orgs.push(row);
    },
    createInviteRow: async (input: Record<string, unknown>) =>
      transformed.OrganizationInvite.create(input),
  };
}

describe('organizations runtime — invite redemption', () => {
  test('P-ORG-7: concurrent membership create races recover via unique-violation lookup', async () => {
    const env = await setup({ authUser: { suspended: false } });
    env.createOrgRow({
      id: 'org-1',
      name: 'Org',
      slug: 'org',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const created = (await env.createInviteRow({
      orgId: 'org-1',
      invitedBy: 'admin',
      role: 'member',
    })) as { id: string; token: string };

    // Pre-seed a membership row so the loser's second-pass lookup finds it.
    // Simulates the moment in a real race when one call has just inserted
    // the membership and another call hits the unique-violation on its own
    // insert. The runtime must convert that violation into alreadyMember=true.
    env.state.members.push({
      id: 'org-1:user-1',
      orgId: 'org-1',
      userId: 'user-1',
      role: 'member',
      invitedBy: 'admin',
    });

    // Patch the member adapter's create to ALWAYS throw a unique-violation —
    // this is the loser's view of the race: by the time we attempt to
    // insert, another transaction has already inserted the same composite id.
    const memberAdapter = env.adapters.OrganizationMember;
    memberAdapter.create = async () => {
      const err = new Error('duplicate key value violates unique constraint');
      (err as Error & { code: string }).code = '23505';
      throw err;
    };
    // The pre-create lookup must return null so the runtime reaches the
    // create call (otherwise it returns alreadyMember=true via the early
    // return path, which is a different code path covered by other tests).
    const originalList = memberAdapter.list.bind(memberAdapter);
    let listCallCount = 0;
    memberAdapter.list = async (req: unknown) => {
      listCallCount += 1;
      // Pre-create existing-membership lookup returns empty; the post-failure
      // recovery lookup returns the seeded row.
      if (listCallCount === 1) {
        return { items: [], nextCursor: undefined, hasMore: false };
      }
      return originalList(req as Parameters<typeof originalList>[0]);
    };

    const result = (await env.redeem({ token: created.token, 'actor.id': 'user-1' })) as {
      alreadyMember: boolean;
      membership: { id: string };
    };

    expect(result.alreadyMember).toBe(true);
    expect(result.membership.id).toBe('org-1:user-1');

    // Membership remains exactly the one we seeded; we did not create a duplicate.
    const matches = env.state.members.filter(m => m.userId === 'user-1' && m.orgId === 'org-1');
    expect(matches).toHaveLength(1);

    // The invite was marked accepted exactly once even though the membership
    // create failed with a unique-violation.
    const finalInvite = env.state.invites[0];
    expect(finalInvite.acceptedAt).toBeTruthy();
  });

  test('P-ORG-7: re-redeem after the invite was already used returns alreadyMember=true', async () => {
    // The "already member" early-return path: pre-create lookup finds the
    // membership immediately. Redeem still marks the invite accepted exactly
    // once (idempotent) and reports alreadyMember=true to the second caller.
    const env = await setup({ authUser: { suspended: false } });
    env.createOrgRow({
      id: 'org-2x',
      name: 'Org',
      slug: 'org',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const created = (await env.createInviteRow({
      orgId: 'org-2x',
      invitedBy: 'admin',
      role: 'member',
    })) as { token: string };
    env.state.members.push({
      id: 'org-2x:user-1',
      orgId: 'org-2x',
      userId: 'user-1',
      role: 'member',
      invitedBy: 'admin',
    });

    const result = (await env.redeem({ token: created.token, 'actor.id': 'user-1' })) as {
      alreadyMember: boolean;
    };
    expect(result.alreadyMember).toBe(true);
    expect(env.state.invites[0].acceptedAt).toBeTruthy();
  });

  test('P-ORG-8: suspended user is rejected with 403 account_suspended', async () => {
    const env = await setup({ authUser: { suspended: true } });
    env.createOrgRow({
      id: 'org-2',
      name: 'Org',
      slug: 'org',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const invite = (await env.createInviteRow({
      orgId: 'org-2',
      invitedBy: 'admin',
      role: 'member',
    })) as { token: string };

    let caught: unknown;
    try {
      await env.redeem({ token: invite.token, 'actor.id': 'user-suspended' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const message =
      typeof caught === 'object' && caught && 'message' in caught
        ? String((caught as { message: unknown }).message)
        : '';
    expect(message).toContain('account_suspended');
  });

  test('P-ORG-9: cascade delete partial failure rejects with 500 and exposes reconcile', async () => {
    const env = await setup({ authUser: { suspended: false } });
    env.createOrgRow({
      id: 'org-3',
      name: 'Cascade',
      slug: 'cascade',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    env.state.members.push({
      id: 'org-3:user-a',
      orgId: 'org-3',
      userId: 'user-a',
      role: 'member',
    });
    env.state.members.push({
      id: 'org-3:user-b',
      orgId: 'org-3',
      userId: 'user-b',
      role: 'member',
    });

    // Force the member adapter delete to throw on the first call so the
    // cascade reports `memberships` as failed.
    const memberAdapter = env.adapters.OrganizationMember;
    const originalDelete = memberAdapter.delete.bind(memberAdapter);
    memberAdapter.delete = async () => {
      throw new Error('synthetic member delete failure');
    };

    let caught: unknown;
    try {
      await env.adapters.Organization.delete('org-3');
    } catch (err) {
      caught = err;
    }
    // Org row is gone (delete ran first), but the cascade reported failure.
    expect(env.state.orgs.find(o => o.id === 'org-3')).toBeUndefined();
    expect(caught).toBeDefined();
    const status = (caught as { status?: number }).status;
    expect(status).toBe(500);

    // Reconcile while the patch is still active still reports the failure.
    const stillFailing = await env.runtime.reconcileOrphanedOrgRecords('org-3');
    expect(stillFailing.orgGone).toBe(true);
    expect(stillFailing.failed).toContain('memberships');

    // Restore the adapter, then reconcile cleans everything up.
    memberAdapter.delete = originalDelete;
    const cleanResult = await env.runtime.reconcileOrphanedOrgRecords('org-3');
    expect(cleanResult.orgGone).toBe(true);
    expect(cleanResult.failed).toEqual([]);
    expect(env.state.members.filter(m => m.orgId === 'org-3')).toHaveLength(0);
  });

  test('P-ORG-9: cascade delete returns true on full success and clears all dependent rows', async () => {
    const env = await setup({ authUser: { suspended: false } });
    env.createOrgRow({
      id: 'org-4',
      name: 'Clean',
      slug: 'clean',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    env.state.members.push({
      id: 'org-4:u',
      orgId: 'org-4',
      userId: 'u',
      role: 'member',
    });
    const ok = await env.adapters.Organization.delete('org-4');
    expect(ok).toBe(true);
    expect(env.state.members.filter(m => m.orgId === 'org-4')).toHaveLength(0);
  });

  test('P-ORG-9: reconcileOrphanedOrgRecords refuses to run while org still exists', async () => {
    const env = await setup();
    env.createOrgRow({
      id: 'org-live',
      name: 'Live',
      slug: 'live',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    let caught: unknown;
    try {
      await env.runtime.reconcileOrphanedOrgRecords('org-live');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(String((caught as Error).message)).toContain('still exists');
  });

  test('P-ORG-10: cascade group-membership delete failure is reported and reconcilable', async () => {
    const env = await setup();
    env.createOrgRow({
      id: 'org-gm',
      name: 'GroupOrg',
      slug: 'group-org',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    env.state.groups.push({ id: 'g1', orgId: 'org-gm', name: 'Big' });
    // Push 100 group memberships to ensure the partial-failure path is exercised
    // even when the group has many members. Real production-scale concern would
    // be 100k; correctness of the path is identical.
    for (let i = 0; i < 100; i++) {
      env.state.groupMemberships.push({
        id: `g1:user-${i}`,
        groupId: 'g1',
        userId: `user-${i}`,
        role: 'member',
      });
    }

    const gmAdapter = env.adapters.GroupMembership;
    const originalGmDelete = gmAdapter.delete.bind(gmAdapter);
    gmAdapter.delete = async () => {
      throw new Error('synthetic gm delete failure');
    };

    let caught: unknown;
    try {
      await env.adapters.Organization.delete('org-gm');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status?: number }).status).toBe(500);

    gmAdapter.delete = originalGmDelete;
    const result = await env.runtime.reconcileOrphanedOrgRecords('org-gm');
    expect(result.orgGone).toBe(true);
    expect(result.failed).toEqual([]);
    expect(env.state.groupMemberships.filter(m => m.groupId === 'g1')).toHaveLength(0);
  });

  test('P-ORG-11: invite creation with the same idempotencyKey returns the same invite without replaying token', async () => {
    const env = await setup();
    env.createOrgRow({
      id: 'org-idem',
      name: 'IdemOrg',
      slug: 'idem-org',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const first = (await env.createInviteRow({
      orgId: 'org-idem',
      invitedBy: 'admin',
      role: 'member',
      idempotencyKey: 'invite-key-1',
    })) as { id: string; token: string };

    const second = (await env.createInviteRow({
      orgId: 'org-idem',
      invitedBy: 'admin',
      role: 'member',
      idempotencyKey: 'invite-key-1',
    })) as { id: string; token?: string };

    expect(second.id).toBe(first.id);
    expect(second.token).toBeUndefined();

    const third = (await env.createInviteRow({
      orgId: 'org-idem',
      invitedBy: 'admin',
      role: 'member',
      idempotencyKey: 'invite-key-2',
    })) as { id: string; token: string };

    expect(third.id).not.toBe(first.id);
    expect(third.token).not.toBe(first.token);

    // Without an idempotencyKey each create produces a fresh row.
    const fresh1 = (await env.createInviteRow({
      orgId: 'org-idem',
      invitedBy: 'admin',
      role: 'member',
    })) as { id: string; token: string };
    const fresh2 = (await env.createInviteRow({
      orgId: 'org-idem',
      invitedBy: 'admin',
      role: 'member',
    })) as { id: string; token: string };
    expect(fresh1.id).not.toBe(fresh2.id);
  });
});
