import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SLUG_CONFLICT_CODE, SlugConflictError, isUniqueViolationError } from '../../src/errors';
import { type OrgPluginTestHarness, setupOrgPluginHarness } from './helpers/setupOrgPlugin';

describe('organizations slug conflicts', () => {
  let harness: OrgPluginTestHarness;

  beforeEach(async () => {
    harness = await setupOrgPluginHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('POST /orgs with a duplicate slug returns 409 with SLUG_CONFLICT code', async () => {
    const { app, adminId } = harness;

    const first = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Acme', slug: 'acme-co' }),
    });
    expect(first.status).toBe(201);

    const second = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Acme Two', slug: 'acme-co' }),
    });
    expect(second.status).toBe(409);

    const body = (await second.json()) as { error: string; code: string; slug: string };
    expect(body.code).toBe(SLUG_CONFLICT_CODE);
    expect(body.slug).toBe('acme-co');
    expect(body.error).toContain('acme-co');
  });

  test('does not crash with an opaque 500 on duplicate-slug create', async () => {
    const { app, adminId } = harness;

    const first = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Initech', slug: 'initech' }),
    });
    expect(first.status).toBe(201);

    const second = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Initech Other', slug: 'initech' }),
    });
    // Must not be a generic 500 — the duplicate-key violation should be
    // converted into a typed 409 response.
    expect(second.status).not.toBe(500);
    expect(second.status).toBe(409);
  });
});

describe('SlugConflictError', () => {
  test('is throwable and exposes the conflicting slug + stable code', () => {
    const err = new SlugConflictError('taken-slug');
    expect(err).toBeInstanceOf(SlugConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe(SLUG_CONFLICT_CODE);
    expect(err.slug).toBe('taken-slug');
    expect(SlugConflictError.CODE).toBe(SLUG_CONFLICT_CODE);
  });

  test('produces a JSON 409 response with code and slug fields', async () => {
    const err = new SlugConflictError('dup');
    const res = err.getResponse();
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { code: string; slug: string };
    expect(body.code).toBe(SLUG_CONFLICT_CODE);
    expect(body.slug).toBe('dup');
  });
});

describe('isUniqueViolationError', () => {
  test('matches the in-memory adapter shape (code = UNIQUE_VIOLATION)', () => {
    const err = Object.assign(new Error('Unique constraint violated on fields: slug'), {
      code: 'UNIQUE_VIOLATION',
      status: 409,
    });
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('matches Postgres unique_violation (SQLSTATE 23505)', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('matches MongoDB duplicate-key error (numeric code 11000)', () => {
    const err = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('matches generic messages containing "duplicate"', () => {
    const err = new Error('a duplicate was detected');
    expect(isUniqueViolationError(err)).toBe(true);
  });

  test('does not match unrelated errors', () => {
    expect(isUniqueViolationError(new Error('unrelated'))).toBe(false);
    expect(isUniqueViolationError(null)).toBe(false);
    expect(isUniqueViolationError(undefined)).toBe(false);
    expect(isUniqueViolationError('string')).toBe(false);
  });

  test('does not match an already-converted SlugConflictError', () => {
    expect(isUniqueViolationError(new SlugConflictError('x'))).toBe(false);
  });
});
