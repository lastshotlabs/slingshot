import { describe, expect, test } from 'bun:test';
import {
  buildSearchAttributes,
  buildVisibilityQuery,
  buildVisibilityValidationQueries,
  decodeTag,
  decodeTags,
  encodeTag,
  encodeTags,
} from '../src/searchAttributes';

describe('Temporal search attributes helpers', () => {
  test('encodes tags with reversible base64url values', () => {
    const encoded = encodeTag('team', 'alpha/beta');
    expect(decodeTag(encoded)).toEqual(['team', 'alpha/beta']);
  });

  test('builds reserved search attributes and visibility query clauses', () => {
    expect(
      buildSearchAttributes('workflow', 'ship-order', {
        tenantId: 'tenant-a',
        priority: 7,
        tags: { team: 'ops' },
      }),
    ).toEqual({
      SlingshotKind: ['workflow'],
      SlingshotName: ['ship-order'],
      SlingshotTenantId: ['tenant-a'],
      SlingshotPriority: [7],
      SlingshotTags: [encodeTag('team', 'ops')],
    });

    expect(
      buildVisibilityQuery({
        type: 'workflow',
        name: 'ship-order',
        tenantId: 'tenant-a',
        status: ['running', 'failed'],
        tags: { team: 'ops' },
      }),
    ).toContain(`SlingshotTags = '${encodeTag('team', 'ops')}'`);
  });

  test('sorts, decodes, and tolerates malformed visibility tag values', () => {
    expect(encodeTags({ zed: 'last', alpha: 'first' })).toEqual([
      encodeTag('alpha', 'first'),
      encodeTag('zed', 'last'),
    ]);
    expect(decodeTag('raw-token')).toEqual(['raw-token', '']);
    expect(decodeTags([encodeTag('team', 'ops'), 123, encodeTag('env', 'prod')])).toEqual({
      team: 'ops',
      env: 'prod',
    });
    expect(decodeTags(undefined)).toBeUndefined();
    expect(decodeTags([123, false])).toBeUndefined();
  });

  test('builds optional visibility filters for statuses, dates, and escaped values', () => {
    const query = buildVisibilityQuery({
      type: 'task',
      name: "sync'user\\data",
      tenantId: 'tenant-prod',
      status: ['completed', 'cancelled', 'skipped'],
      createdAfter: new Date('2026-01-01T00:00:00.000Z'),
      createdBefore: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(query).toContain("SlingshotName = 'sync\\'user\\\\data'");
    expect(query).toContain(
      "(ExecutionStatus = 'Completed' OR ExecutionStatus = 'Canceled' OR ExecutionStatus = 'Completed')",
    );
    expect(query).toContain("StartTime >= '2026-01-01T00:00:00.000Z'");
    expect(query).toContain("StartTime <= '2026-01-02T00:00:00.000Z'");
    expect(buildVisibilityQuery()).toBeUndefined();
    expect(buildVisibilityQuery({})).toBeUndefined();
  });

  test('exposes validation probes for every reserved Temporal search attribute', () => {
    expect(buildVisibilityValidationQueries()).toEqual([
      "SlingshotKind = 'task' OR SlingshotKind = 'workflow'",
      "SlingshotName = 'slingshot'",
      "SlingshotTenantId = 'tenant'",
      'SlingshotPriority >= 0 OR SlingshotPriority < 0',
      `SlingshotTags = '${encodeTag('key', 'value')}'`,
    ]);
  });
});
