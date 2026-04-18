/**
 * manifestToEntity — invalid JSON → clear error messages.
 *
 * Verifies that bad entity definitions produce actionable Zod or domain errors.
 */
import { describe, expect, it } from 'bun:test';
import type { ManifestEntity } from '../../src/index';
import { createEntityHandlerRegistry, manifestToEntity } from '../../src/index';

describe('manifestToEntity — clear validation errors', () => {
  it('rejects missing primary key with clear error', () => {
    const def: ManifestEntity = {
      fields: { name: { type: 'string' } },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow('No primary key');
  });

  it('rejects multiple primary keys with clear error', () => {
    const def: ManifestEntity = {
      fields: {
        id: { type: 'string', primary: true },
        altId: { type: 'string', primary: true },
      },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow('Multiple primary key');
  });

  it('rejects invalid primary key type with clear error', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'boolean', primary: true } },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow('must be string, number, or integer');
  });

  it('rejects invalid field type with Zod error', () => {
    const invalidInput = { fields: { id: { type: 'uuid_v4', primary: true } } };
    let err: Error | undefined;
    try {
      manifestToEntity('Bad', invalidInput as unknown as ManifestEntity);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message.length).toBeGreaterThan(0);
  });

  it('rejects softDelete referencing nonexistent field', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      softDelete: { field: 'nonexistent', value: 'deleted' },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow("softDelete.field 'nonexistent' not found");
  });

  it('rejects index referencing unknown field', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      indexes: [{ fields: ['nonexistent'] }],
    };
    expect(() => manifestToEntity('Bad', def)).toThrow(
      "Index references unknown field 'nonexistent'",
    );
  });

  it('rejects operation referencing unknown field', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      operations: { bad: { kind: 'search', fields: ['nonexistent'] } },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow("references unknown field 'nonexistent'");
  });

  it('rejects pagination cursor referencing unknown field', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      pagination: { cursor: { fields: ['nonexistent'] } },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow(
      "pagination.cursor references unknown field 'nonexistent'",
    );
  });

  it('rejects tenant.field referencing unknown field', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      tenant: { field: 'nonexistent' },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow("tenant.field 'nonexistent' not found");
  });

  it('rejects defaultSort.field referencing unknown field', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      defaultSort: { field: 'nonexistent', direction: 'desc' },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow("defaultSort.field 'nonexistent' not found");
  });

  it('rejects uniques referencing unknown field', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      uniques: [{ fields: ['nonexistent'] }],
    };
    expect(() => manifestToEntity('Bad', def)).toThrow(
      "Unique constraint references unknown field 'nonexistent'",
    );
  });

  it('rejects uniques with duplicate field in a single constraint', () => {
    const def: ManifestEntity = {
      fields: {
        id: { type: 'string', primary: true },
        email: { type: 'string' },
      },
      uniques: [{ fields: ['email', 'email'] }],
    };
    expect(() => manifestToEntity('Bad', def)).toThrow(
      "Unique constraint has duplicate field 'email'",
    );
  });

  it('rejects custom op referencing unknown handler', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      operations: { score: { kind: 'custom', handler: 'not-registered' } },
    };
    const registry = createEntityHandlerRegistry();
    expect(() => manifestToEntity('Bad', def, registry)).toThrow(
      "references unknown handler 'not-registered'",
    );
  });

  it('rejects custom op without a handler registry', () => {
    const def: ManifestEntity = {
      fields: { id: { type: 'string', primary: true } },
      operations: { score: { kind: 'custom', handler: 'anything' } },
    };
    expect(() => manifestToEntity('Bad', def)).toThrow('requires a handler registry');
  });

  it('rejects unknown operation kind with Zod error', () => {
    const invalidInput = {
      fields: { id: { type: 'string', primary: true } },
      operations: { op: { kind: 'nonexistent_kind' } },
    };
    let err: Error | undefined;
    try {
      manifestToEntity('Bad', invalidInput as unknown as ManifestEntity);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message.length).toBeGreaterThan(0);
  });
});
