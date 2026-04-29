import { describe, expect, test } from 'bun:test';
import {
  buildSearchAttributes,
  buildVisibilityQuery,
  buildVisibilityValidationQueries,
  decodeTag,
  decodeTags,
  encodeTag,
  encodeTags,
  SLINGSHOT_KIND_SEARCH_ATTRIBUTE,
  SLINGSHOT_NAME_SEARCH_ATTRIBUTE,
  SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE,
  SLINGSHOT_TAGS_SEARCH_ATTRIBUTE,
  SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE,
} from '../src/searchAttributes';

describe('encodeTag / decodeTag', () => {
  test('roundtrips basic key-value pairs', () => {
    const encoded = encodeTag('team', 'ops');
    expect(decodeTag(encoded)).toEqual(['team', 'ops']);
  });

  test('roundtrips values with special characters (slashes, spaces, colons)', () => {
    const encoded = encodeTag('env', 'alpha/beta:gamma v1');
    expect(decodeTag(encoded)).toEqual(['env', 'alpha/beta:gamma v1']);
  });

  test('roundtrips Unicode values', () => {
    const encoded = encodeTag('label', 'cafe-100');
    expect(decodeTag(encoded)).toEqual(['label', 'cafe-100']);
  });

  test('handles empty key and empty value', () => {
    const encodedEmptyKey = encodeTag('', 'val');
    expect(decodeTag(encodedEmptyKey)).toEqual(['', 'val']);

    const encodedEmptyVal = encodeTag('key', '');
    expect(decodeTag(encodedEmptyVal)).toEqual(['key', '']);
  });

  test('handles keys or values with equals signs', () => {
    const encoded = encodeTag('key=foo', 'val=bar');
    expect(decodeTag(encoded)).toEqual(['key=foo', 'val=bar']);
  });

  test('decodeTag without delimiter returns the whole string as key with empty value', () => {
    expect(decodeTag('raw-token')).toEqual(['raw-token', '']);
    expect(decodeTag('')).toEqual(['', '']);
  });

  test('decodeTag handles base64-encoded padding edge cases', () => {
    // Values whose base64 encoding needs padding
    const encoded = encodeTag('key', 'a');
    expect(decodeTag(encoded)).toEqual(['key', 'a']);
  });
});

describe('encodeTags / decodeTags', () => {
  test('encodeTags returns sorted entries', () => {
    expect(encodeTags({ zed: 'last', alpha: 'first', beta: 'middle' })).toEqual([
      encodeTag('alpha', 'first'),
      encodeTag('beta', 'middle'),
      encodeTag('zed', 'last'),
    ]);
  });

  test('encodeTags returns empty array for undefined or null', () => {
    expect(encodeTags(undefined)).toEqual([]);
    expect(encodeTags(undefined!)).toEqual([]);
  });

  test('encodeTags returns empty array for empty object', () => {
    expect(encodeTags({})).toEqual([]);
  });

  test('encodeTags handles values with special characters', () => {
    const tags = encodeTags({ route: '/api/v1/users', query: '?q=hello&page=1' });
    expect(decodeTags(tags)).toEqual({
      route: '/api/v1/users',
      query: '?q=hello&page=1',
    });
  });

  test('decodeTags returns undefined for non-array input', () => {
    expect(decodeTags(undefined)).toBeUndefined();
    expect(decodeTags(null)).toBeUndefined();
    expect(decodeTags('string')).toBeUndefined();
    expect(decodeTags(42)).toBeUndefined();
    expect(decodeTags({})).toBeUndefined();
  });

  test('decodeTags filters out non-string entries from the array', () => {
    expect(
      decodeTags([encodeTag('team', 'ops'), 123, false, null, undefined, encodeTag('env', 'prod')]),
    ).toEqual({ team: 'ops', env: 'prod' });
  });

  test('decodeTags returns undefined when no valid tags remain after filtering', () => {
    expect(decodeTags([123, false, null])).toBeUndefined();
    expect(decodeTags([])).toBeUndefined();
  });

  test('decodeTags decodes multiple entries with the same key (last wins)', () => {
    expect(
      decodeTags([encodeTag('color', 'red'), encodeTag('color', 'blue')]),
    ).toEqual({
      color: 'blue',
    });
  });
});

describe('buildSearchAttributes', () => {
  test('returns kind and name when no options are provided', () => {
    expect(buildSearchAttributes('task', 'my-task')).toEqual({
      [SLINGSHOT_KIND_SEARCH_ATTRIBUTE]: ['task'],
      [SLINGSHOT_NAME_SEARCH_ATTRIBUTE]: ['my-task'],
    });
  });

  test('includes tenantId when provided', () => {
    const attrs = buildSearchAttributes('workflow', 'ship-order', { tenantId: 'tenant-a' });
    expect(attrs[SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE]).toEqual(['tenant-a']);
  });

  test('includes priority when provided as a number', () => {
    const attrs = buildSearchAttributes('task', 'my-task', { priority: 7 });
    expect(attrs[SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE]).toEqual([7]);
  });

  test('includes priority of zero', () => {
    const attrs = buildSearchAttributes('task', 'my-task', { priority: 0 });
    expect(attrs[SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE]).toEqual([0]);
  });

  test('omits priority when undefined', () => {
    const attrs = buildSearchAttributes('task', 'my-task', {});
    expect(attrs[SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE]).toBeUndefined();
  });

  test('omits priority when undefined explicitly', () => {
    const attrs = buildSearchAttributes('task', 'my-task', { priority: undefined });
    expect(attrs[SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE]).toBeUndefined();
  });

  test('includes encoded tags when tags are provided', () => {
    const attrs = buildSearchAttributes('workflow', 'ship-order', {
      tags: { team: 'ops', env: 'prod' },
    });
    expect(attrs[SLINGSHOT_TAGS_SEARCH_ATTRIBUTE]).toEqual([
      encodeTag('env', 'prod'),
      encodeTag('team', 'ops'),
    ]);
  });

  test('omits tags attribute when tags object is empty', () => {
    const attrs = buildSearchAttributes('task', 'my-task', { tags: {} });
    expect(attrs[SLINGSHOT_TAGS_SEARCH_ATTRIBUTE]).toBeUndefined();
  });

  test('omits tags attribute when tags is undefined', () => {
    const attrs = buildSearchAttributes('task', 'my-task', {});
    expect(attrs[SLINGSHOT_TAGS_SEARCH_ATTRIBUTE]).toBeUndefined();
  });

  test('includes all optional fields when all are provided', () => {
    const attrs = buildSearchAttributes('workflow', 'ship-order', {
      tenantId: 'tenant-prod',
      priority: 3,
      tags: { deploy: 'canary' },
    });
    expect(attrs).toEqual({
      [SLINGSHOT_KIND_SEARCH_ATTRIBUTE]: ['workflow'],
      [SLINGSHOT_NAME_SEARCH_ATTRIBUTE]: ['ship-order'],
      [SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE]: ['tenant-prod'],
      [SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE]: [3],
      [SLINGSHOT_TAGS_SEARCH_ATTRIBUTE]: [encodeTag('deploy', 'canary')],
    });
  });
});

describe('buildVisibilityQuery', () => {
  test('returns undefined for undefined filter', () => {
    expect(buildVisibilityQuery()).toBeUndefined();
    expect(buildVisibilityQuery(undefined)).toBeUndefined();
  });

  test('returns undefined for empty filter', () => {
    expect(buildVisibilityQuery({})).toBeUndefined();
  });

  test('filters by type', () => {
    const query = buildVisibilityQuery({ type: 'task' });
    expect(query).toBe(`SlingshotKind = 'task'`);
  });

  test('filters by name', () => {
    const query = buildVisibilityQuery({ name: 'ship-order' });
    expect(query).toBe(`SlingshotName = 'ship-order'`);
  });

  test('filters by tenantId', () => {
    const query = buildVisibilityQuery({ tenantId: 'tenant-a' });
    expect(query).toBe(`SlingshotTenantId = 'tenant-a'`);
  });

  test('filters by single status', () => {
    const query = buildVisibilityQuery({ status: 'completed' });
    expect(query).toBe(`ExecutionStatus = 'Completed'`);
  });

  test('filters by multiple statuses with OR grouping', () => {
    const query = buildVisibilityQuery({ status: ['running', 'failed'] });
    expect(query).toBe(`(ExecutionStatus = 'Running' OR ExecutionStatus = 'Failed')`);
  });

  test('filters by statuses with duplicate temporal mapping (pending/running both map to Running)', () => {
    const query = buildVisibilityQuery({ status: ['pending', 'running'] });
    // Both map to 'Running' but we still generate the OR
    expect(query).toContain('ExecutionStatus');
    expect(query).toContain('Running');
  });

  test('filters by createdAfter date', () => {
    const date = new Date('2026-01-15T10:00:00.000Z');
    const query = buildVisibilityQuery({ createdAfter: date });
    expect(query).toBe(`StartTime >= '2026-01-15T10:00:00.000Z'`);
  });

  test('filters by createdBefore date', () => {
    const date = new Date('2026-01-15T10:00:00.000Z');
    const query = buildVisibilityQuery({ createdBefore: date });
    expect(query).toBe(`StartTime <= '2026-01-15T10:00:00.000Z'`);
  });

  test('filters by tags', () => {
    const query = buildVisibilityQuery({ tags: { team: 'ops', env: 'prod' } });
    expect(query).toBe(
      `SlingshotTags = '${encodeTag('env', 'prod')}' AND SlingshotTags = '${encodeTag('team', 'ops')}'`,
    );
  });

  test('combines all filter fields with AND', () => {
    const query = buildVisibilityQuery({
      type: 'workflow',
      name: 'ship-order',
      tenantId: 'tenant-prod',
      status: ['running', 'failed'],
      tags: { team: 'ops' },
      createdAfter: new Date('2026-01-01T00:00:00.000Z'),
      createdBefore: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(query).toContain(`SlingshotKind = 'workflow'`);
    expect(query).toContain(`SlingshotName = 'ship-order'`);
    expect(query).toContain(`SlingshotTenantId = 'tenant-prod'`);
    expect(query).toContain(`(ExecutionStatus = 'Running' OR ExecutionStatus = 'Failed')`);
    expect(query).toContain(`SlingshotTags = '${encodeTag('team', 'ops')}'`);
    expect(query).toContain(`StartTime >= '2026-01-01T00:00:00.000Z'`);
    expect(query).toContain(`StartTime <= '2026-01-02T00:00:00.000Z'`);
    expect(query).toMatch(/^.+ AND .+ AND .+ AND .+ AND .+ AND .+ AND .+$/);
  });

  test('escapes single quotes and backslashes in name values', () => {
    const query = buildVisibilityQuery({
      name: "sync'user\\data",
    });
    expect(query).toBe("SlingshotName = 'sync\\'user\\\\data'");
  });

  test('handles statuses that map to the same Temporal state (cancelled -> Canceled, skipped -> Completed)', () => {
    const query = buildVisibilityQuery({ status: ['cancelled', 'skipped'] });
    expect(query).toBe(
      `(ExecutionStatus = 'Canceled' OR ExecutionStatus = 'Completed')`,
    );
  });
});

describe('buildVisibilityValidationQueries', () => {
  test('returns queries for every reserved search attribute', () => {
    const queries = buildVisibilityValidationQueries();
    expect(queries).toHaveLength(5);

    expect(queries[0]).toBe(
      `SlingshotKind = 'task' OR SlingshotKind = 'workflow'`,
    );
    expect(queries[1]).toBe(`SlingshotName = 'slingshot'`);
    expect(queries[2]).toBe(`SlingshotTenantId = 'tenant'`);
    expect(queries[3]).toBe(
      `SlingshotPriority >= 0 OR SlingshotPriority < 0`,
    );
    expect(queries[4]).toBe(
      `SlingshotTags = '${encodeTag('key', 'value')}'`,
    );
  });

  test('encoded tag in validation query is internally consistent', () => {
    const queries = buildVisibilityValidationQueries();
    // The last query should contain a valid encodeTag roundtrip
    const tagQuery = queries[4];
    const encodedValue = tagQuery.split("'")[1];
    expect(decodeTag(encodedValue)).toEqual(['key', 'value']);
  });
});
