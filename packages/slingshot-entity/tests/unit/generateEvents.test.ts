/**
 * Tests for generateEvents() — event type augmentation codegen.
 */
import { describe, expect, it } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { generateEvents, hasEvents } from '../../src/generators/events';

const baseFields = {
  id: {
    type: 'string' as const,
    primary: true,
    immutable: true,
    optional: false,
    default: 'uuid' as const,
  },
  authorId: { type: 'string' as const, primary: false, immutable: false, optional: false },
  title: { type: 'string' as const, primary: false, immutable: false, optional: false },
  status: {
    type: 'enum' as const,
    primary: false,
    immutable: false,
    optional: false,
    enumValues: ['draft', 'published'] as const,
  },
  viewCount: {
    type: 'integer' as const,
    primary: false,
    immutable: false,
    optional: true,
  },
};

const makeConfig = (routes: ResolvedEntityConfig['routes']): ResolvedEntityConfig => {
  const config: ResolvedEntityConfig = {
    name: 'Post',
    fields: baseFields,
    _pkField: 'id',
    _storageName: 'posts',
    routes,
  } as unknown as ResolvedEntityConfig;
  return config;
};

describe('hasEvents', () => {
  it('returns false when no route config', () => {
    expect(hasEvents({})).toBe(false);
  });

  it('returns false when no events in config', () => {
    expect(hasEvents({ create: { auth: 'userAuth' } })).toBe(false);
  });

  it('returns true when any CRUD op has an event', () => {
    expect(hasEvents({ create: { event: 'post:created' } })).toBe(true);
  });

  it('returns true when a named op has an event', () => {
    expect(hasEvents({ operations: { publish: { event: 'post:published' } } })).toBe(true);
  });
});

describe('generateEvents', () => {
  it('returns empty string when no routes', () => {
    const config = makeConfig(undefined);
    expect(generateEvents(config)).toBe('');
  });

  it('returns empty string when routes but no events', () => {
    const config = makeConfig({ create: { auth: 'userAuth' } });
    expect(generateEvents(config)).toBe('');
  });

  it('generates module augmentation for a string event', () => {
    const config = makeConfig({ create: { event: 'post:created' } });
    const output = generateEvents(config);
    expect(output).toContain("declare module '@lastshotlabs/slingshot-core'");
    expect(output).toContain('interface SlingshotEventMap');
    expect(output).toContain("'post:created'");
    expect(output).toContain('tenantId?: string');
    expect(output).toContain('actorId?: string');
  });

  it('generates field types for event payload', () => {
    const config = makeConfig({
      create: {
        event: { key: 'post:created', payload: ['title', 'authorId'] },
      },
    });
    const output = generateEvents(config);
    expect(output).toContain("'post:created'");
    expect(output).toContain('title: string');
    expect(output).toContain('authorId: string');
  });

  it('generates enum type with union for enum fields', () => {
    const config = makeConfig({
      update: {
        event: { key: 'post:status_changed', payload: ['status'] },
      },
    });
    const output = generateEvents(config);
    expect(output).toContain("'draft' | 'published'");
  });

  it('generates integer fields as number type', () => {
    const config = makeConfig({
      get: {
        event: { key: 'post:viewed', payload: ['viewCount'] },
      },
    });
    const output = generateEvents(config);
    expect(output).toContain('viewCount: number | undefined'); // optional integer
  });

  it('generates events for named operations', () => {
    const config = makeConfig({
      operations: {
        publish: { event: { key: 'post:published', payload: ['title'] } },
      },
    });
    const output = generateEvents(config);
    expect(output).toContain("'post:published'");
    expect(output).toContain('title: string');
  });

  it('generates multiple events from multiple operations', () => {
    const config = makeConfig({
      create: { event: 'post:created' },
      delete: { event: 'post:deleted' },
      operations: { publish: { event: 'post:published' } },
    });
    const output = generateEvents(config);
    expect(output).toContain("'post:created'");
    expect(output).toContain("'post:deleted'");
    expect(output).toContain("'post:published'");
  });
});
