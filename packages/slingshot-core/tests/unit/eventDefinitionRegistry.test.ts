import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createEventDefinitionRegistry, createEventSchemaRegistry, defineEvent } from '../../src';

describe('eventDefinitionRegistry', () => {
  test('registers definitions and mirrors schemas into the schema registry', () => {
    const schemas = createEventSchemaRegistry();
    const registry = createEventDefinitionRegistry({ schemaRegistry: schemas });
    const definition = defineEvent('app:ready', {
      ownerPlugin: 'slingshot-framework',
      exposure: ['internal'],
      schema: z.object({ plugins: z.array(z.string()) }),
      resolveScope() {
        return null;
      },
    });

    registry.register(definition);

    expect(registry.has('app:ready')).toBe(true);
    expect(registry.get('app:ready')?.ownerPlugin).toBe('slingshot-framework');
    expect(schemas.has('app:ready')).toBe(true);
  });

  test('rejects duplicate registrations', () => {
    const registry = createEventDefinitionRegistry();
    const definition = defineEvent('app:shutdown', {
      ownerPlugin: 'slingshot-framework',
      exposure: ['internal'],
      resolveScope() {
        return null;
      },
    });

    registry.register(definition);
    expect(() => registry.register(definition)).toThrow('already registered');
  });

  test('freezes the registry snapshot and rejects late registration', () => {
    const registry = createEventDefinitionRegistry();
    registry.register(
      defineEvent('app:ready', {
        ownerPlugin: 'slingshot-framework',
        exposure: ['internal'],
        resolveScope() {
          return null;
        },
      }),
    );

    registry.freeze();

    const list = registry.list();
    expect(registry.frozen).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
    expect(() =>
      registry.register(
        defineEvent('app:shutdown', {
          ownerPlugin: 'slingshot-framework',
          exposure: ['internal'],
          resolveScope() {
            return null;
          },
        }),
      ),
    ).toThrow('registry is frozen');
  });
});
