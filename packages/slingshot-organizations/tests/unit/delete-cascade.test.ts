import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from './helpers/setupOrgPlugin';

describe('organizations delete-cascade', () => {
  let harness: OrgPluginTestHarness;

  beforeEach(async () => {
    harness = await setupOrgPluginHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('DELETE /orgs/:id removes org plus dependent rows', async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade Org', slug: 'cascade-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    // 3 members (admin + two synthesized userIds)
    const memberUserIds = ['user-1', 'user-2', 'user-3'];
    for (const userId of memberUserIds) {
      const res = await app.request(`/orgs/${org.id}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': adminId },
        body: JSON.stringify({ userId, role: 'member' }),
      });
      expect(res.status).toBe(201);
    }

    // 2 invites
    for (const email of ['inv1@example.com', 'inv2@example.com']) {
      const res = await app.request(`/orgs/${org.id}/invitations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': adminId },
        body: JSON.stringify({ email, role: 'member' }),
      });
      expect(res.status).toBe(201);
    }

    // 1 group with 2 members
    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade Group', slug: 'cascade-group', orgId: org.id }),
    });
    expect(createGroup.status).toBe(201);
    const group = (await createGroup.json()) as { id: string };

    for (const userId of ['guser-1', 'guser-2']) {
      const res = await app.request(`/groups/${group.id}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': adminId },
        body: JSON.stringify({ userId, role: 'member' }),
      });
      expect(res.status).toBe(201);
    }

    // Verify rows exist before delete via list endpoints.
    const listMembersBefore = await app.request(`/orgs/${org.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listMembersBefore.status).toBe(200);
    const membersBefore = (await listMembersBefore.json()) as { items: unknown[] };
    expect(membersBefore.items.length).toBe(3);

    const listInvitesBefore = await app.request(`/orgs/${org.id}/invitations`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listInvitesBefore.status).toBe(200);
    const invitesBefore = (await listInvitesBefore.json()) as { items: unknown[] };
    expect(invitesBefore.items.length).toBe(2);

    const listGroupMembersBefore = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listGroupMembersBefore.status).toBe(200);
    const groupMembersBefore = (await listGroupMembersBefore.json()) as { items: unknown[] };
    expect(groupMembersBefore.items.length).toBe(2);

    // DELETE the org.
    const deleteOrg = await app.request(`/orgs/${org.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(deleteOrg.status).toBe(204);

    // Org list should now exclude the deleted id.
    const listOrgs = await app.request('/orgs', { headers: { 'x-user-id': adminId } });
    expect(listOrgs.status).toBe(200);
    const orgs = (await listOrgs.json()) as { items: Array<{ id: string }> };
    expect(orgs.items.some(o => o.id === org.id)).toBe(false);

    // Memberships are gone.
    const listMembersAfter = await app.request(`/orgs/${org.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listMembersAfter.status).toBe(200);
    const membersAfter = (await listMembersAfter.json()) as { items: unknown[] };
    expect(membersAfter.items.length).toBe(0);

    // Invites are gone.
    const listInvitesAfter = await app.request(`/orgs/${org.id}/invitations`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listInvitesAfter.status).toBe(200);
    const invitesAfter = (await listInvitesAfter.json()) as { items: unknown[] };
    expect(invitesAfter.items.length).toBe(0);

    // Group memberships for the deleted group are gone.
    const listGroupMembersAfter = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listGroupMembersAfter.status).toBe(200);
    const groupMembersAfter = (await listGroupMembersAfter.json()) as { items: unknown[] };
    expect(groupMembersAfter.items.length).toBe(0);

    // The group itself is gone — listing all groups must not contain it.
    const listGroups = await app.request('/groups', { headers: { 'x-user-id': adminId } });
    expect(listGroups.status).toBe(200);
    const groups = (await listGroups.json()) as { items: Array<{ id: string }> };
    expect(groups.items.some(g => g.id === group.id)).toBe(false);
  });
});
