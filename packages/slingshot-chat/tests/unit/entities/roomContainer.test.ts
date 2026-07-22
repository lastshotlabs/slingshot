import { describe, expect, test } from 'bun:test';
import { Room } from '../../../src/entities/room';

describe('Room container association', () => {
  test('declares an optional containerId and exposes it on create and update', () => {
    const routes = Room.routes as {
      create: { input: { allow: readonly string[] } };
      update: { input: { allow: readonly string[] } };
    };
    expect(Room.fields.containerId).toBeDefined();
    expect(routes.create.input.allow).toContain('containerId');
    expect(routes.update.input.allow).toContain('containerId');
  });

  test('indexes tenant, container, and type for scoped room discovery', () => {
    expect(Room.indexes).toContainEqual(
      expect.objectContaining({ fields: ['tenantId', 'containerId', 'type'] }),
    );
  });
});
