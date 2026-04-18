import { describe, expect, test } from 'bun:test';
import {
  entityChannelConfigSchema,
  validateEntityChannelConfig,
} from '../../src/entityChannelConfigSchema';

// ---------------------------------------------------------------------------
// Valid channel configs
// ---------------------------------------------------------------------------

describe('entityChannelConfigSchema — valid configs', () => {
  test('single channel with auth + permission parses', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        updates: {
          auth: 'userAuth',
          permission: { requires: 'thread:read' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('full channel declaration parses', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        updates: {
          auth: 'userAuth',
          permission: {
            requires: 'thread:read',
            ownerField: 'containerId',
            or: 'thread:admin',
            scope: { tenantId: 'param:tenantId' },
          },
          middleware: ['banCheck'],
          forward: {
            events: ['entity:threads.updated'],
            idField: 'id',
          },
          presence: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid channel configs
// ---------------------------------------------------------------------------

describe('entityChannelConfigSchema — invalid configs', () => {
  test('rejects empty channels record', () => {
    const result = entityChannelConfigSchema.safeParse({ channels: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('channels must not be empty'))).toBe(true);
    }
  });

  test('rejects missing channels key', () => {
    expect(entityChannelConfigSchema.safeParse({}).success).toBe(false);
  });

  test('rejects empty forward.events array', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        updates: {
          forward: { events: [] },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown auth value', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        updates: { auth: 'bogus' },
      },
    });
    expect(result.success).toBe(false);
  });

  test('validateEntityChannelConfig returns structured errors on empty channels', () => {
    const result = validateEntityChannelConfig({ channels: {} });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });
});
