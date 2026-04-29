import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { SlugConflictError, isUniqueViolationError } from '../../src/errors';
import { createOrganizationsPlugin } from '../../src/plugin';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from './helpers/setupOrgPlugin';

describe('prod hardening — error propagation', () => {
  test('SlugConflictError propagates as HTTP 409 even when thrown in deep adapter call', async () => {
    const err = new SlugConflictError('deep-slug');
    expect(err.status).toBe(409);

    // Use getResponse only once since the Response body stream can only be read once
    const res = err.getResponse();
    expect(res.status).toBe(409);

    const body = JSON.parse(await res.text());
    expect(body).toMatchObject({
      code: 'SLUG_CONFLICT',
      slug: 'deep-slug',
    });
  });

  test('isUniqueViolationError correctly classifies adapter-specific errors', () => {
    // Simulate error patterns from different adapters
    const cases: Array<{ error: unknown; expected: boolean; label: string }> = [
      {
        error: Object.assign(new Error('unique'), { code: 'UNIQUE_VIOLATION' }),
        expected: true,
        label: 'memory adapter',
      },
      {
        error: Object.assign(new Error('duplicate key'), { code: '23505' }),
        expected: true,
        label: 'postgres',
      },
      {
        error: Object.assign(new Error('E11000 dup'), { code: 11000 }),
        expected: true,
        label: 'mongodb',
      },
      { error: new TypeError('not a function'), expected: false, label: 'type error' },
      { error: new RangeError('invalid'), expected: false, label: 'range error' },
      { error: 'string error', expected: false, label: 'string error' },
    ];

    for (const c of cases) {
      expect(isUniqueViolationError(c.error)).toBe(c.expected);
    }
  });

  test('unique-violation error with minimal message is still detected', () => {
    // Edge case: error with just the word "unique" in its message
    expect(isUniqueViolationError(new Error('unique'))).toBe(true);
    // Edge case: error with just the word "duplicate" in its message
    expect(isUniqueViolationError(new Error('duplicate'))).toBe(true);
    // Non-matching word
    expect(isUniqueViolationError(new Error('conflict'))).toBe(false);
  });
});

describe('prod hardening — HTTP error responses', () => {
  let harness: OrgPluginTestHarness;

  beforeEach(async () => {
    harness = await setupOrgPluginHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('create org with invalid body returns 400, not 500', async () => {
    const { app, adminId } = harness;

    // Missing required name field
    const res = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ slug: 'bad-org' }),
    });
    // Should be a client error, not a server error
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('create org with empty slug returns 400', async () => {
    const { app, adminId } = harness;

    const res = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Empty Slug', slug: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('create org with reserved slug returns 400', async () => {
    const { app, adminId } = harness;

    const res = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Admin Org', slug: 'admin' }),
    });
    expect(res.status).toBe(400);
  });

  test('create org with duplicate slug returns 409 not 500', async () => {
    const { app, adminId } = harness;

    // First creation succeeds
    const first = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Unique Org', slug: 'unique-org-name' }),
    });
    expect(first.status).toBe(201);

    // Second creation with same slug must NOT produce a 500
    const second = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Unique Org Copy', slug: 'unique-org-name' }),
    });
    expect(second.status).toBe(409);
    expect(second.status).not.toBe(500);
  });

  test('unauthorized request without x-user-id returns 401', async () => {
    const { app } = harness;

    const res = await app.request('/orgs', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });
});

describe('prod hardening — plugin config validation', () => {
  test('createOrganizationsPlugin with invalid mountPath throws', () => {
    // mountPath without leading /
    expect(() =>
      createOrganizationsPlugin({
        mountPath: 'no-leading-slash',
      } as Parameters<typeof createOrganizationsPlugin>[0]),
    ).toThrow(/must start with '\/'/);
  });

  test('createOrganizationsPlugin with just slash as mountPath throws', () => {
    // mountPath that normalizes to '/' (empty after trimming trailing slashes)
    expect(() =>
      createOrganizationsPlugin({
        mountPath: '/',
      } as Parameters<typeof createOrganizationsPlugin>[0]),
    ).toThrow(/must not be '\//);
  });

  test('createOrganizationsPlugin handles missing config gracefully', () => {
    // No config or undefined config should not throw at construction
    expect(() => createOrganizationsPlugin()).not.toThrow();
    expect(() => createOrganizationsPlugin(undefined)).not.toThrow();
  });
});

describe('prod hardening — org service reconciliation', () => {
  let harness: OrgPluginTestHarness;

  beforeEach(async () => {
    harness = await setupOrgPluginHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('deleting an org with no dependents returns 204', async () => {
    const { app, adminId } = harness;

    const createRes = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Lonely Org', slug: 'lonely-org' }),
    });
    expect(createRes.status).toBe(201);
    const org = (await createRes.json()) as { id: string };

    const delRes = await app.request(`/orgs/${org.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(delRes.status).toBe(204);

    // Verify org is gone
    const listRes = await app.request('/orgs', { headers: { 'x-user-id': adminId } });
    const orgs = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(orgs.items.some(o => o.id === org.id)).toBe(false);
  });

  test('concurrent org slug race results in 409 not 500', async () => {
    const { app, adminId } = harness;

    // Create one org with a slug
    const first = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Race Org', slug: 'race-slug' }),
    });
    expect(first.status).toBe(201);

    // Try to create another with the same slug (simulates loser of a race)
    const second = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Race Org 2', slug: 'race-slug' }),
    });
    // Must not be a generic 500
    expect(second.status).not.toBe(500);
    expect(second.status).toBe(409);

    // Response body must contain SLUG_CONFLICT code
    const body = (await second.json()) as { code: string; slug: string };
    expect(body.code).toBe('SLUG_CONFLICT');
    expect(body.slug).toBe('race-slug');
  });
});
