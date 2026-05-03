import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from './helpers/setupOrgPlugin';

describe('malformed organization input', () => {
  let h: OrgPluginTestHarness;

  beforeEach(async () => {
    h = await setupOrgPluginHarness();
  });
  afterEach(async () => {
    await h.teardown();
  });

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-user-id': h.adminId,
  });

  test('empty body returns 400', async () => {
    expect(
      (await h.app.request('/orgs', { method: 'POST', headers: headers(), body: '{}' })).status,
    ).toBe(400);
  });

  test('missing name returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ slug: 'valid-slug' }),
    });
    expect(res.status).toBe(400);
  });

  test('missing slug returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'Valid Name' }),
    });
    expect(res.status).toBe(400);
  });

  test('number instead of string for name returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 42, slug: 'num-name' }),
    });
    expect(res.status).toBe(400);
  });

  test('null name returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: null, slug: 'null-name' }),
    });
    expect(res.status).toBe(400);
  });

  test('array instead of object for body returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify([{ name: 'Array', slug: 'array-org' }]),
    });
    expect(res.status).toBe(400);
  });

  test('uppercase slug returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'Upper', slug: 'UPPER-CASE' }),
    });
    expect(res.status).toBe(400);
  });

  test('slug with spaces returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'Spaces', slug: 'spaced slug' }),
    });
    expect(res.status).toBe(400);
  });

  test('slug over 63 characters returns 400', async () => {
    const res = await h.app.request('/orgs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'Long', slug: 'a'.repeat(64) }),
    });
    expect(res.status).toBe(400);
  });
});

describe('malformed member and invite input', () => {
  let h: OrgPluginTestHarness;
  let orgId: string;

  beforeEach(async () => {
    h = await setupOrgPluginHarness();
    const org = (await (
      await h.app.request('/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': h.adminId },
        body: JSON.stringify({ name: 'Parent', slug: 'parent-org' }),
      })
    ).json()) as { id: string };
    orgId = org.id;
  });
  afterEach(async () => {
    await h.teardown();
  });

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-user-id': h.adminId,
  });

  describe('member creation', () => {
    test('missing userId returns 400', async () => {
      const res = await h.app.request(`/orgs/${orgId}/members`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'member' }),
      });
      expect(res.status).toBe(400);
    });

    test('empty body returns 400', async () => {
      expect(
        (
          await h.app.request(`/orgs/${orgId}/members`, {
            method: 'POST',
            headers: headers(),
            body: '{}',
          })
        ).status,
      ).toBe(400);
    });

    test('invalid role value returns 400', async () => {
      const res = await h.app.request(`/orgs/${orgId}/members`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ userId: 'user-1', role: 'invalid-role' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('invite creation', () => {
    test('object instead of email returns 400', async () => {
      const res = await h.app.request(`/orgs/${orgId}/invitations`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: { nested: 'object' } }),
      });
      expect(res.status).toBe(400);
    });

    test('number instead of email returns 400', async () => {
      const res = await h.app.request(`/orgs/${orgId}/invitations`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: 12345 }),
      });
      expect(res.status).toBe(400);
    });

    test('boolean instead of string for role returns 400', async () => {
      const res = await h.app.request(`/orgs/${orgId}/invitations`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: 'test@example.com', role: true }),
      });
      expect(res.status).toBe(400);
    });
  });
});
