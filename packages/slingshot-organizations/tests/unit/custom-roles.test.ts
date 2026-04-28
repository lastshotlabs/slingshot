import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from './helpers/setupOrgPlugin';

describe('organizations custom roles', () => {
  let harness: OrgPluginTestHarness;

  beforeEach(async () => {
    harness = await setupOrgPluginHarness({
      organizations: {
        enabled: true,
        invitationTtlSeconds: 3600,
        knownRoles: ['owner', 'admin', 'member', 'viewer'],
      },
      groups: { managementRoutes: true },
    });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test("creating a membership with role 'viewer' succeeds when 'viewer' is in knownRoles", async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Roles Org', slug: 'roles-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    const addMember = await app.request(`/orgs/${org.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'viewer-user-1', role: 'viewer' }),
    });
    expect(addMember.status).toBe(201);
    const member = (await addMember.json()) as { role: string };
    expect(member.role).toBe('viewer');
  });

  test("creating a membership with role 'unknown' is rejected with 400", async () => {
    const { app, adminId } = harness;

    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Reject Org', slug: 'reject-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    const addMember = await app.request(`/orgs/${org.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: 'unknown-user-1', role: 'unknown' }),
    });
    expect(addMember.status).toBe(400);
    const text = await addMember.text();
    expect(text).toContain("Invalid role 'unknown'");
  });

  test('defaultMemberRole outside knownRoles is rejected at plugin construction', async () => {
    await expect(
      setupOrgPluginHarness({
        organizations: {
          enabled: true,
          knownRoles: ['member', 'viewer'],
          defaultMemberRole: 'admin',
        },
      }),
    ).rejects.toThrow();
  });
});
