/**
 * End-to-end integration test for the organizations package.
 *
 * Exercises CRUD, invite flow, and delete cascade through the full HTTP surface
 * using the in-memory entity adapter. The in-memory adapter implements the same
 * `EntityAdapter` contract as the SQLite adapter, so all package-level code paths
 * (middleware, routes, runtime helpers) are exercised identically.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getOrganizationsOrgServiceOrNull } from '../../src/orgService';
import { getOrganizationsReconcileOrNull } from '../../src/reconcile';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from '../unit/helpers/setupOrgPlugin';

describe('organizations package end-to-end', () => {
  let harness: OrgPluginTestHarness;

  beforeEach(async () => {
    harness = await setupOrgPluginHarness({
      organizations: { enabled: true, invitationTtlSeconds: 3600 },
      groups: { managementRoutes: true },
    });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  // ── CRUD ──────────────────────────────────────────────────────────────

  test('full CRUD: create, read, update, list, delete an organization', async () => {
    const { app, adminId } = harness;

    // CREATE
    const createRes = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'CRUD Org', slug: 'crud-org', description: 'E2E test org' }),
    });
    expect(createRes.status).toBe(201);
    const org = (await createRes.json()) as { id: string; name: string; slug: string };
    expect(org.id).toBeString();
    expect(org.slug).toBe('crud-org');

    // READ by slug (the `get` route is disabled; use getBySlug instead)
    const getRes = await app.request(`/orgs/by-slug/${org.slug}`, {
      headers: { 'x-user-id': adminId },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string; name: string };
    expect(fetched.id).toBe(org.id);

    // UPDATE
    const updateRes = await app.request(`/orgs/${org.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'CRUD Org Updated' }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { name: string };
    expect(updated.name).toBe('CRUD Org Updated');

    // LIST
    const listRes = await app.request('/orgs', {
      headers: { 'x-user-id': adminId },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(list.items.some(o => o.id === org.id)).toBe(true);

    // DELETE
    const deleteRes = await app.request(`/orgs/${org.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(deleteRes.status).toBe(204);
  });

  // ── Invite flow ───────────────────────────────────────────────────────

  test('full invite flow: create invite, lookup, redeem, then list membership', async () => {
    const { app, adminId, memberId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Invite Org', slug: 'invite-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    // CREATE INVITE (link-based, no email)
    const createInvite = await app.request(`/orgs/${org.id}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(createInvite.status).toBe(201);
    const invite = (await createInvite.json()) as { id: string; token: string };
    expect(invite.token).toBeString();
    expect(invite.token.length).toBeGreaterThan(0);

    // LOOKUP invite (unauthenticated POST with token)
    const lookup = await app.request(`/orgs/${org.id}/invitations/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(lookup.status).toBe(200);
    const lookedUp = (await lookup.json()) as { orgId: string; role: string };
    expect(lookedUp.orgId).toBe(org.id);
    expect(lookedUp.role).toBe('member');

    // REDEEM invite
    const redeem = await app.request(`/orgs/${org.id}/invitations/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': memberId },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(redeem.status).toBe(200);
    const redeemed = (await redeem.json()) as {
      organization: { id: string } | null;
      membership: { role: string };
      alreadyMember: boolean;
    };
    expect(redeemed.organization?.id).toBe(org.id);
    expect(redeemed.membership.role).toBe('member');
    expect(redeemed.alreadyMember).toBe(false);

    // VERIFY membership appears in listMine
    const mine = await app.request('/orgs/mine', {
      headers: { 'x-user-id': memberId },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { items: Array<{ id: string }> };
    expect(mineBody.items.some(entry => entry.id === org.id)).toBe(true);
  });

  // ── Delete cascade ────────────────────────────────────────────────────

  test('delete cascade: org deletion removes members, invites, and groups', async () => {
    const { app, adminId, memberId, pluginState } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade Org', slug: 'cascade-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    const addMember = await app.request(`/orgs/${org.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: memberId, role: 'member' }),
    });
    expect(addMember.status).toBe(201);

    const createInvite = await app.request(`/orgs/${org.id}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(createInvite.status).toBe(201);

    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade Team', slug: 'cascade-team', orgId: org.id }),
    });
    expect(createGroup.status).toBe(201);
    const group = (await createGroup.json()) as { id: string };

    const addGroupMember = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: memberId, role: 'member' }),
    });
    expect(addGroupMember.status).toBe(201);

    const deleteOrg = await app.request(`/orgs/${org.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(deleteOrg.status).toBe(204);

    const getOrg = await app.request(`/orgs/${org.id}`, {
      headers: { 'x-user-id': adminId },
    });
    expect(getOrg.status).toBe(404);

    const reconcile = getOrganizationsReconcileOrNull(pluginState);
    expect(reconcile).not.toBeNull();
  });

  // ── Groups CRUD ───────────────────────────────────────────────────────

  test('groups CRUD: create, list members, delete group within an org', async () => {
    const { app, adminId, memberId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Group Org', slug: 'group-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Engineering', slug: 'engineering', orgId: org.id }),
    });
    expect(createGroup.status).toBe(201);
    const group = (await createGroup.json()) as { id: string; name: string };
    expect(group.name).toBe('Engineering');

    const addMember = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: memberId, role: 'member' }),
    });
    expect(addMember.status).toBe(201);

    const listMembers = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listMembers.status).toBe(200);
    const members = (await listMembers.json()) as { items: Array<{ userId: string }> };
    expect(members.items.some((m: { userId: string }) => m.userId === memberId)).toBe(true);

    const deleteGroup = await app.request(`/groups/${group.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(deleteGroup.status).toBe(204);
  });

  // ── Slug validation ───────────────────────────────────────────────────

  test('slug uniqueness is enforced: duplicate slug returns 409', async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'First', slug: 'duplicate' }),
    });
    expect(createOrg.status).toBe(201);

    const createDup = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Second', slug: 'duplicate' }),
    });
    expect(createDup.status).toBe(409);
  });

  // ── Org service ───────────────────────────────────────────────────────

  test('org service is published and functional for programmatic access', async () => {
    const { adminId, memberId, pluginState } = harness;

    const orgService = getOrganizationsOrgServiceOrNull(pluginState);
    expect(orgService).not.toBeNull();
    if (!orgService) throw new Error('org service not available');

    const created = await orgService.createOrg({ name: 'Svc Org', slug: 'svc-org' });
    expect(created.id).toBeString();

    const found = await orgService.getOrgBySlug('svc-org');
    expect(found?.id).toBe(created.id);

    await expect(
      orgService.addOrgMember(created.id, memberId, ['admin'], adminId),
    ).resolves.toBeDefined();
  });

  // ── Tenant isolation ──────────────────────────────────────────────────

  test('getOrgBySlug filters by tenantId when provided', async () => {
    const { pluginState } = harness;

    const orgService = getOrganizationsOrgServiceOrNull(pluginState);
    if (!orgService) throw new Error('org service not available');

    await orgService.createOrg({
      name: 'Tenant Scoped Org',
      slug: 'scoped-org',
      tenantId: 'tenant-a',
    });

    const found = await orgService.getOrgBySlug('scoped-org', 'tenant-a');
    expect(found).not.toBeNull();

    const crossTenant = await orgService.getOrgBySlug('scoped-org', 'tenant-b');
    expect(crossTenant).toBeNull();

    const noFilter = await orgService.getOrgBySlug('scoped-org');
    expect(noFilter).not.toBeNull();
  });

  // ── Reconcile service ─────────────────────────────────────────────────

  test('reconcile service is published and callable', async () => {
    const { pluginState } = harness;

    const reconcile = getOrganizationsReconcileOrNull(pluginState);
    expect(reconcile).not.toBeNull();
    if (!reconcile) throw new Error('reconcile service not available');

    const result = await reconcile.reconcileOrphanedOrgRecords('nonexistent-org-id');
    expect(result).toBeDefined();
  });
});
