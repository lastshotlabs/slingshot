/**
 * Backcompat tests: generate() without routes config produces same output as before.
 */
import { describe, expect, it } from 'bun:test';
import { defineEntity, field } from '../../src/defineEntity';
import { generate } from '../../src/generate';

const basicEntity = defineEntity('Widget', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    name: field.string(),
    value: field.number({ optional: true }),
  },
});

describe('generate() backcompat — no routes config', () => {
  it('does not produce routes.ts when no operations and no routes config', () => {
    const files = generate(basicEntity);
    expect('routes.ts' in files).toBe(false);
  });

  it('does not produce events.ts when no routes config', () => {
    const files = generate(basicEntity);
    expect('events.ts' in files).toBe(false);
  });

  it('produces expected file set without routes', () => {
    const files = generate(basicEntity, { backends: ['memory'] });
    expect(Object.keys(files).sort()).toEqual(
      ['adapter.ts', 'index.ts', 'memory.ts', 'schemas.ts', 'types.ts'].sort(),
    );
  });

  it('generates routes.ts when operations are provided (existing behavior)', () => {
    const files = generate(basicEntity, {
      backends: ['memory'],
      operations: {
        findByName: { kind: 'lookup', fields: { name: 'eq' }, returns: 'one' },
      },
    });
    expect('routes.ts' in files).toBe(true);
    expect('events.ts' in files).toBe(false);
  });
});
