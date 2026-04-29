import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from './helpers/setupOrgPlugin';

describe('group membership operations', () => {
  let harness: OrgPluginTestHarness;

  beforeEach(async () => {
    harness = await setupOrgPluginHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  // ---------------------------------------------------------------------------
  // Add and list group members
  // ---------------------------------------------------------------------------

  test('adds a member to a group and lists the membership', async () => {
    const { app, adminId } = harness;

    // Create org
    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'GM Org', slug: 'gm-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    // Create group
    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'GM Group', slug: 'gm-group', orgId: org.id }),
    });
    expect(createGroup.status).toBe(201);
    const group = (await createGroup.json()) as { id: string };

    // Add member
    const addMember = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'gm-user-1', role: 'member' }),
    });
    expect(addMember.status).toBe(201);

    // List members
    const listMembers = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listMembers.status).toBe(200);
    const members = (await listMembers.json()) as { items: Array<{ userId: string }> };
    expect(members.items.some(m => m.userId === 'gm-user-1')).toBe(true);
  });

  test('adds multiple members to a group and lists them all', async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Multi Org', slug: 'multi-org' }),
    });
    const org = (await createOrg.json()) as { id: string };

    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Multi Group', slug: 'multi-group', orgId: org.id }),
    });
    const group = (await createGroup.json()) as { id: string };

    const userIds = ['mu-1', 'mu-2', 'mu-3'];
    for (const userId of userIds) {
      const res = await app.request(`/groups/${group.id}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': adminId },
        body: JSON.stringify({ userId, role: 'member' }),
      });
      expect(res.status).toBe(201);
    }

    const listMembers = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listMembers.status).toBe(200);
    const members = (await listMembers.json()) as { items: Array<{ userId: string }> };
    expect(members.items).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Duplicate prevention
  // ---------------------------------------------------------------------------

  test('duplicate group membership (same groupId + userId) is rejected', async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Dedup Org', slug: 'dedup-org' }),
    });
    const org = (await createOrg.json()) as { id: string };

    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Dedup Group', slug: 'dedup-group', orgId: org.id }),
    });
    const group = (await createGroup.json()) as { id: string };

    // First add succeeds
    const first = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'dup-user', role: 'member' }),
    });
    expect(first.status).toBe(201);

    // Second add with same userId fails (unique constraint violation)
    const second = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'dup-user', role: 'member' }),
    });
    expect(second.status).toBe(409);
  });

  // ---------------------------------------------------------------------------
  // Remove group member
  // ---------------------------------------------------------------------------

  test('removes a member from a group', async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Remove Org', slug: 'remove-org' }),
    });
    const org = (await createOrg.json()) as { id: string };

    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Remove Group', slug: 'remove-group', orgId: org.id }),
    });
    const group = (await createGroup.json()) as { id: string };

    const addRes = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'rm-user', role: 'member' }),
    });
    expect(addRes.status).toBe(201);
    const member = (await addRes.json()) as { id: string };

    // Delete the membership
    const delRes = await app.request(`/groups/${group.id}/members/${member.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(delRes.status).toBe(204);

    // Verify the membership is gone
    const listMembers = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    const members = (await listMembers.json()) as { items: Array<{ userId: string }> };
    expect(members.items.some(m => m.userId === 'rm-user')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Cascade on group delete
  // ---------------------------------------------------------------------------

  test('deleting a group cascades to remove its memberships', async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade GM Org', slug: 'cascade-gm-org' }),
    });
    const org = (await createOrg.json()) as { id: string };

    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade GM', slug: 'cascade-gm', orgId: org.id }),
    });
    const group = (await createGroup.json()) as { id: string };

    // Add two members
    for (const userId of ['cgm-1', 'cgm-2']) {
      await app.request(`/groups/${group.id}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': adminId },
        body: JSON.stringify({ userId, role: 'member' }),
      });
    }

    // Delete the group
    const delGroup = await app.request(`/groups/${group.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(delGroup.status).toBe(204);

    // Verify memberships are gone (list on deleted group returns empty)
    const listMembers = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listMembers.status).toBe(200);
    const members = (await listMembers.json()) as { items: unknown[] };
    expect(members.items).toHaveLength(0);

    // Verify group listing no longer includes the deleted group
    const listGroups = await app.request('/groups', { headers: { 'x-user-id': adminId } });
    const groups = (await listGroups.json()) as { items: Array<{ id: string }> };
    expect(groups.items.some(g => g.id === group.id)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Non-existent group
  // ---------------------------------------------------------------------------

  test('adding a member to a non-existent group returns 404', async () => {
    const { app, adminId } = harness;

    const res = await app.request('/groups/non-existent-group/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'some-user', role: 'member' }),
    });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Group member listing is scoped to the group
  // ---------------------------------------------------------------------------

  test('group member list is scoped to the specific group', async () => {
    const { app, adminId } = harness;

    // Create org
    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Scope Org', slug: 'scope-org' }),
    });
    const org = (await createOrg.json()) as { id: string };

    // Create two groups
    const g1 = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Scope G1', slug: 'scope-g1', orgId: org.id }),
    });
    const group1 = (await g1.json()) as { id: string };

    const g2 = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Scope G2', slug: 'scope-g2', orgId: org.id }),
    });
    const group2 = (await g2.json()) as { id: string };

    // Add same user to both groups
    await app.request(`/groups/${group1.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'shared-user', role: 'member' }),
    });
    await app.request(`/groups/${group2.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'shared-user', role: 'member' }),
    });

    // Group 1 lists should contain only that group's membership
    const list1 = await app.request(`/groups/${group1.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    const members1 = (await list1.json()) as { items: Array<{ groupId: string }> };
    expect(members1.items.every(m => m.groupId === group1.id)).toBe(true);

    // Group 2 lists should contain only that group's membership
    const list2 = await app.request(`/groups/${group2.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    const members2 = (await list2.json()) as { items: Array<{ groupId: string }> };
    expect(members2.items.every(m => m.groupId === group2.id)).toBe(true);
  });
});
