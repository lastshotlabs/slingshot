import { describe, expect, test } from 'bun:test';
import type { UserRecord } from '@lastshotlabs/slingshot-core';
import { parseScimFilter, scimError, userRecordToScim } from '../src/lib/scim';

// ---------------------------------------------------------------------------
// parseScimFilter
// ---------------------------------------------------------------------------

describe('parseScimFilter', () => {
  test('returns empty object when filter is absent', () => {
    expect(parseScimFilter()).toEqual({});
    expect(parseScimFilter('')).toEqual({});
  });

  test('returns null for compound AND expressions', () => {
    expect(parseScimFilter('userName eq "alice" AND active eq "true"')).toBeNull();
  });

  test('returns null for compound OR expressions', () => {
    expect(parseScimFilter('userName eq "a" OR userName eq "b"')).toBeNull();
  });

  test('returns null for NOT expressions', () => {
    expect(parseScimFilter('NOT active eq "true"')).toBeNull();
  });

  test('returns null for grouped (parenthesised) expressions', () => {
    expect(parseScimFilter('(userName eq "a")')).toBeNull();
  });

  test('maps userName to email query', () => {
    expect(parseScimFilter('userName eq "alice@example.com"')).toEqual({
      email: 'alice@example.com',
    });
  });

  test('maps email attribute to email query', () => {
    expect(parseScimFilter('email eq "bob@example.com"')).toEqual({
      email: 'bob@example.com',
    });
  });

  test('maps externalId attribute to externalId query', () => {
    expect(parseScimFilter('externalId eq "ext-123"')).toEqual({ externalId: 'ext-123' });
  });

  test('maps active=true to suspended=false', () => {
    expect(parseScimFilter('active eq "true"')).toEqual({ suspended: false });
  });

  test('maps active=false to suspended=true', () => {
    expect(parseScimFilter('active eq "false"')).toEqual({ suspended: true });
  });

  test('returns null for active with non-boolean value', () => {
    expect(parseScimFilter('active eq "yes"')).toBeNull();
  });

  test('returns null for unsupported attribute', () => {
    expect(parseScimFilter('displayName eq "Alice"')).toBeNull();
  });

  test('returns null for malformed clause (missing eq)', () => {
    expect(parseScimFilter('userName "alice"')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// userRecordToScim
// ---------------------------------------------------------------------------

describe('userRecordToScim', () => {
  const base: UserRecord = {
    id: 'user-1',
    email: 'alice@example.com',
    displayName: 'Alice Smith',
    firstName: 'Alice',
    lastName: 'Smith',
    externalId: 'ext-1',
    suspended: false,
  };

  test('maps a full UserRecord to a ScimUser', () => {
    const result = userRecordToScim(base);
    expect(result.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User']);
    expect(result.id).toBe('user-1');
    expect(result.userName).toBe('alice@example.com');
    expect(result.externalId).toBe('ext-1');
    expect(result.displayName).toBe('Alice Smith');
    expect(result.active).toBe(true);
    expect(result.emails).toEqual([{ value: 'alice@example.com', primary: true }]);
    expect(result.name).toEqual({
      givenName: 'Alice',
      familyName: 'Smith',
      formatted: 'Alice Smith',
    });
    expect(result.meta.resourceType).toBe('User');
  });

  test('maps suspended=true to active=false', () => {
    const result = userRecordToScim({ ...base, suspended: true });
    expect(result.active).toBe(false);
  });

  test('falls back to user.id as userName when email is absent', () => {
    const result = userRecordToScim({ ...base, email: undefined });
    expect(result.userName).toBe('user-1');
    expect(result.emails).toBeUndefined();
  });

  test('omits name block when both firstName and lastName are absent', () => {
    const result = userRecordToScim({ ...base, firstName: undefined, lastName: undefined });
    expect(result.name).toBeUndefined();
  });

  test('includes name block with only givenName when lastName is absent', () => {
    const result = userRecordToScim({ ...base, lastName: undefined });
    expect(result.name?.givenName).toBe('Alice');
    expect(result.name?.familyName).toBeUndefined();
    expect(result.name?.formatted).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------
// scimError
// ---------------------------------------------------------------------------

describe('scimError', () => {
  test('returns a Response with correct status and content-type', async () => {
    const res = scimError(404, 'User not found');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/scim+json');
    const body = await res.json();
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(body.status).toBe('404');
    expect(body.detail).toBe('User not found');
    expect(body.scimType).toBeUndefined();
  });

  test('includes scimType when provided', async () => {
    const res = scimError(400, 'Unsupported filter', 'invalidFilter');
    const body = await res.json();
    expect(body.status).toBe('400');
    expect(body.scimType).toBe('invalidFilter');
  });
});
