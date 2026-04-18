/**
 * Tests for retention job codegen: generate() produces correct retention factory
 * and the generated code correctly identifies expired records.
 */
import { describe, expect, it } from 'bun:test';
import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { defineEntity, field } from '../../src/defineEntity';
import { generate } from '../../src/generate';
import { generateRetentionJob, hasRetention } from '../../src/generators/retention';

// ---------------------------------------------------------------------------
// Test entity with retention config
// ---------------------------------------------------------------------------

const messageEntity = defineEntity('Message', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    body: field.string(),
    status: field.enum(['active', 'deleted'], { default: 'active' }),
    updatedAt: field.date({ default: 'now' }),
  },
  routes: {
    create: {},
    retention: {
      hardDelete: {
        after: '90d',
        when: { status: 'deleted' },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Tests: hasRetention()
// ---------------------------------------------------------------------------

describe('hasRetention', () => {
  it('returns false when no routes config', () => {
    const config: ResolvedEntityConfig = {
      name: 'T',
      fields: {},
      _pkField: 'id',
      _storageName: 'ts',
    };
    expect(hasRetention(config)).toBe(false);
  });

  it('returns false when routes exists but no retention', () => {
    const config: ResolvedEntityConfig = {
      name: 'T',
      fields: {},
      _pkField: 'id',
      _storageName: 'ts',
      routes: { create: {} },
    };
    expect(hasRetention(config)).toBe(false);
  });

  it('returns true when retention.hardDelete is configured', () => {
    expect(hasRetention(messageEntity)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: generateRetentionJob()
// ---------------------------------------------------------------------------

describe('generateRetentionJob', () => {
  it('returns empty string when no retention config', () => {
    const config: ResolvedEntityConfig = {
      name: 'T',
      fields: {},
      _pkField: 'id',
      _storageName: 'ts',
    };
    expect(generateRetentionJob(config)).toBe('');
  });

  it('generates a factory function named create{Name}RetentionJob', () => {
    const output = generateRetentionJob(messageEntity);
    expect(output).toContain('createMessageRetentionJob');
    expect(output).toContain('MessageAdapter');
  });

  it('includes the configured duration', () => {
    const output = generateRetentionJob(messageEntity);
    expect(output).toContain('"90d"');
  });

  it('includes the when filter', () => {
    const output = generateRetentionJob(messageEntity);
    expect(output).toContain('"deleted"');
    expect(output).toContain('status');
  });

  it('includes parseDuration helper', () => {
    const output = generateRetentionJob(messageEntity);
    expect(output).toContain('parseDuration');
    expect(output).toContain('86_400_000'); // days multiplier
  });

  it('uses adapter.list and adapter.delete', () => {
    const output = generateRetentionJob(messageEntity);
    expect(output).toContain('adapter.list(');
    expect(output).toContain('adapter.delete(');
  });

  it('returns the count of deleted records', () => {
    const output = generateRetentionJob(messageEntity);
    expect(output).toContain('return items.length');
  });
});

// ---------------------------------------------------------------------------
// Tests: generate() integration
// ---------------------------------------------------------------------------

describe('generate() with retention config', () => {
  it('routes.ts includes retention job factory', () => {
    const files = generate(messageEntity, { backends: ['memory'] });
    expect('routes.ts' in files).toBe(true);
    expect(files['routes.ts']).toContain('createMessageRetentionJob');
  });

  it('routes.ts includes parseDuration', () => {
    const files = generate(messageEntity, { backends: ['memory'] });
    expect(files['routes.ts']).toContain('parseDuration');
  });

  it('does not include retention in routes.ts when no retention config', () => {
    const plain = defineEntity('Plain', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
      },
      routes: { create: {} },
    });
    const files = generate(plain, { backends: ['memory'] });
    expect('routes.ts' in files).toBe(true);
    expect(files['routes.ts']).not.toContain('RetentionJob');
    expect(files['routes.ts']).not.toContain('parseDuration');
  });
});
