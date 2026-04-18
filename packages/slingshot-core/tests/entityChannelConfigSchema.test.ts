/**
 * Tests for entityChannelConfigSchema and validateEntityChannelConfig.
 *
 * Validates that the Zod schema correctly accepts and rejects channel
 * configurations, including the new `receive` field.
 */
import { describe, expect, it } from 'bun:test';
import {
  entityChannelConfigSchema,
  validateEntityChannelConfig,
} from '../src/entityChannelConfigSchema';

describe('entityChannelConfigSchema', () => {
  it('accepts minimal valid config', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: { live: {} },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty channels record', () => {
    const result = entityChannelConfigSchema.safeParse({ channels: {} });
    expect(result.success).toBe(false);
  });

  it('accepts channel with forward config', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        activity: { forward: { events: ['entity:things.updated'], idField: 'thingId' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects forward.events as empty array', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: { live: { forward: { events: [] } } },
    });
    expect(result.success).toBe(false);
  });

  // --- receive field tests ---

  it('accepts EntityChannelDeclaration with valid receive config', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        live: {
          auth: 'userAuth',
          receive: {
            events: ['document.typing', 'thread.typing'],
            toRoom: true,
            excludeSender: true,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts receive without optional fields', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        live: {
          receive: { events: ['cursor.move'] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects receive.events as empty array', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: { live: { receive: { events: [] } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects receive.events with empty string entries', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: { live: { receive: { events: [''] } } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts full channel declaration combining forward, receive, and presence', () => {
    const result = entityChannelConfigSchema.safeParse({
      channels: {
        live: {
          auth: 'userAuth',
          permission: { requires: 'container:read' },
          presence: true,
          forward: {
            events: ['community:thread.created'],
            idField: 'containerId',
          },
          receive: {
            events: ['document.typing'],
            toRoom: true,
            excludeSender: true,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('validateEntityChannelConfig', () => {
  it('returns success: true for valid config', () => {
    const result = validateEntityChannelConfig({
      channels: { live: { receive: { events: ['typing'] } } },
    });
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('returns success: false with errors for invalid config', () => {
    const result = validateEntityChannelConfig({ channels: {} });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('never throws for arbitrary input', () => {
    expect(() => validateEntityChannelConfig(null)).not.toThrow();
    expect(() => validateEntityChannelConfig(42)).not.toThrow();
    expect(() => validateEntityChannelConfig('string')).not.toThrow();
  });
});
