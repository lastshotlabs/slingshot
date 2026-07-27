import { describe, expect, test } from 'bun:test';
import { defineEntity, field } from '@lastshotlabs/slingshot-core';
import {
  defineOperations as forwardedDefineOperations,
  op as forwardedOp,
} from '../../src/configDriven/operations';
import { defineOperations as canonicalDefineOperations, op as canonicalOp } from '../../src/index';

describe('config-driven operation forwarding', () => {
  test('uses the exact canonical builder and validator objects', () => {
    expect(forwardedOp).toBe(canonicalOp);
    expect(forwardedDefineOperations).toBe(canonicalDefineOperations);
    expect(Object.keys(forwardedOp).sort()).toEqual(Object.keys(canonicalOp).sort());
    expect(Object.keys(forwardedOp)).toContain('transaction');
    expect(Object.keys(forwardedOp)).toContain('pipe');
  });

  test('retains canonical validation and deep-freeze behavior', () => {
    const Entity = defineEntity('BuilderParity', {
      fields: {
        id: field.string({ primary: true }),
        state: field.string(),
      },
    });
    const operations = forwardedDefineOperations(Entity, {
      complete: forwardedOp.transition({
        field: 'state',
        from: 'open',
        to: 'done',
        match: { id: 'param:id' },
      }),
    });

    expect(Object.isFrozen(operations.operations)).toBe(true);
    expect(Object.isFrozen(operations.operations.complete)).toBe(true);
  });
});
