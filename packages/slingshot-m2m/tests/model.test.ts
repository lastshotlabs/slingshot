import { describe, expect, mock, test } from 'bun:test';
import { createM2MClientModel } from '../src/models/M2MClient';

describe('createM2MClientModel', () => {
  test('returns the cached model when the connection already has one', () => {
    const existingModel = { modelName: 'M2MClient' };
    const conn = {
      modelNames: () => ['M2MClient'],
      model: mock(() => existingModel),
    };

    const model = createM2MClientModel(conn as never, {} as never) as unknown;

    expect(model).toBe(existingModel);
    expect(conn.model).toHaveBeenCalledWith('M2MClient');
  });

  test('creates and registers the model when the connection does not have one yet', () => {
    const createdSchemas: Array<{ definition: Record<string, unknown>; options: unknown }> = [];

    class MockSchema<TShape extends Record<string, unknown>> {
      definition: TShape;
      options: unknown;

      constructor(definition: TShape, options: unknown) {
        this.definition = definition;
        this.options = options;
        createdSchemas.push({ definition, options });
      }
    }

    const createdModel = { modelName: 'M2MClient' };
    const conn = {
      modelNames: () => [],
      model: mock((_name: string, _schema?: unknown) => createdModel),
    };

    const model = createM2MClientModel(conn as never, { Schema: MockSchema } as never) as unknown;

    expect(model).toBe(createdModel);
    expect(conn.model).toHaveBeenCalledTimes(1);
    const [firstCall] = conn.model.mock.calls as unknown as Array<[string, unknown?]>;
    expect(firstCall[0]).toBe('M2MClient');
    expect(createdSchemas[0]?.options).toEqual({ timestamps: true });
    expect(createdSchemas[0]?.definition).toMatchObject({
      clientId: { type: String, required: true, unique: true },
      clientSecretHash: { type: String, required: true },
      name: { type: String, required: true },
      active: { type: Boolean, default: true },
    });
  });
});
