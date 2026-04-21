import { describe, expect, test } from 'bun:test';
import {
  buildSearchAttributes,
  buildVisibilityQuery,
  decodeTag,
  encodeTag,
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
});
