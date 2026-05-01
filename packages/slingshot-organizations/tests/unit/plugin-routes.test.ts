import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createOrganizationsPlugin } from '../../src/plugin';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from './helpers/setupOrgPlugin';

describe('plugin metadata', () => {
  test('has correct name and dependencies', () => {
    const p = createOrganizationsPlugin();
    expect(p.name).toBe('slingshot-organizations');
    expect(p.dependencies).toEqual(['slingshot-auth']);
  });

  test('tenantExemptPaths includes orgs and groups with default mountPath', () => {
    const p = createOrganizationsPlugin();
    for (const path of ['/orgs', '/orgs/*', '/groups', '/groups/*']) {
      expect(p.tenantExemptPaths).toContain(path);
    }
  });

  test('tenantExemptPaths respects mountPath prefix', () => {
    const p = createOrganizationsPlugin({ mountPath: '/api' });
    for (const path of ['/api/orgs', '/api/orgs/*', '/api/groups', '/api/groups/*']) {
      expect(p.tenantExemptPaths).toContain(path);
    }
  });
});

describe('route registration', () => {
  let h: OrgPluginTestHarness;

  beforeEach(async () => { h = await setupOrgPluginHarness(); });
  afterEach(async () => { await h.teardown(); });

  const headers = (): Record<string, string> => ({ 'content-type': 'application/json', 'x-user-id': h.adminId });

  test('GET /orgs returns 200 for admin', async () => {
    expect((await h.app.request('/orgs', { headers: { 'x-user-id': h.adminId } })).status).toBe(200);
  });

  test('POST /orgs returns 201 for admin with valid data', async () => {
    const res = await h.app.request('/orgs', { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Test Org', slug: 'test-org' }) });
    expect(res.status).toBe(201);
  });

  test('POST /orgs/:orgId/members returns 201', async () => {
    const org = await (await h.app.request('/orgs', { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'M Org', slug: 'm-org' }) })).json() as { id: string };
    const res = await h.app.request(`/orgs/${org.id}/members`, { method: 'POST', headers: headers(), body: JSON.stringify({ userId: h.memberId, role: 'member' }) });
    expect(res.status).toBe(201);
  });

  test('POST /orgs/:orgId/invitations returns 201', async () => {
    const org = await (await h.app.request('/orgs', { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'I Org', slug: 'i-org' }) })).json() as { id: string };
    const res = await h.app.request(`/orgs/${org.id}/invitations`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: 'invite@example.com' }) });
    expect(res.status).toBe(201);
  });

  test('GET /groups returns 200 for admin when group management is enabled', async () => {
    expect((await h.app.request('/groups', { headers: { 'x-user-id': h.adminId } })).status).toBe(200);
  });
});

describe('custom mount path', () => {
  test('routes respond at configured prefix and are absent at root', async () => {
    const h = await setupOrgPluginHarness({ mountPath: '/api', organizations: { enabled: true, invitationTtlSeconds: 3600 }, groups: { managementRoutes: true } });
    try {
      expect((await h.app.request('/api/orgs', { headers: { 'x-user-id': h.adminId } })).status).toBe(200);
      expect((await h.app.request('/orgs', { headers: { 'x-user-id': h.adminId } })).status).toBe(404);
    } finally { await h.teardown(); }
  });
});

describe('route toggling', () => {
  test('disabling organizations removes organization routes', async () => {
    const h = await setupOrgPluginHarness({ organizations: { enabled: false } });
    try { expect((await h.app.request('/orgs', { headers: { 'x-user-id': h.adminId } })).status).toBe(404); }
    finally { await h.teardown(); }
  });

  test('disabling groups removes group routes', async () => {
    const h = await setupOrgPluginHarness({ organizations: { enabled: true, invitationTtlSeconds: 3600 } });
    try { expect((await h.app.request('/groups', { headers: { 'x-user-id': h.adminId } })).status).toBe(404); }
    finally { await h.teardown(); }
  });
});

describe('middleware composition', () => {
  let h: OrgPluginTestHarness;

  beforeEach(async () => { h = await setupOrgPluginHarness(); });
  afterEach(async () => { await h.teardown(); });

  test('unauthenticated request returns 401', async () => {
    expect((await h.app.request('/orgs')).status).toBe(401);
  });

  test('member receives 403 on admin-only POST /orgs', async () => {
    const res = await h.app.request('/orgs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': h.memberId }, body: JSON.stringify({ name: 'Nope', slug: 'nope' }) });
    expect(res.status).toBe(403);
  });

  test('admin passes through admin guard on POST /orgs', async () => {
    const res = await h.app.request('/orgs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': h.adminId }, body: JSON.stringify({ name: 'Working Org', slug: 'working' }) });
    expect(res.status).toBe(201);
  });

  test('invite lookup route is public (auth: none)', async () => {
    const res = await h.app.request('/orgs/dummy/invitations/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'unknown-token' }) });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(500);
  });
});
