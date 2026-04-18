import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { HttpError, ValidationError } from '@lastshotlabs/slingshot-core';
import { validate } from '../../src/framework/lib/validate';

const schema = z.object({
  name: z.string(),
  age: z.number(),
});

describe('validate', () => {
  test('returns parsed object for a valid JSON body', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', age: 30 }),
    });
    const result = await validate(schema, req);
    expect(result.name).toBe('Alice');
    expect(result.age).toBe(30);
  });

  test('throws ValidationError(400) when schema validation fails', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }), // missing age
    });
    try {
      await validate(schema, req);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as ValidationError).status).toBe(400);
      expect(Array.isArray((err as ValidationError).issues)).toBe(true);
      expect((err as ValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  test('throws ValidationError(400) for multiple validation errors', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: true }), // both name and age missing
    });
    try {
      await validate(schema, req);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).status).toBe(400);
      expect((err as ValidationError).issues.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('propagates the error when body is not valid JSON', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json',
    });
    await expect(validate(schema, req)).rejects.toThrow();
  });

  test('works with nested schemas', async () => {
    const nested = z.object({ user: z.object({ id: z.string() }) });
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { id: 'u-1' } }),
    });
    const result = await validate(nested, req);
    expect(result.user.id).toBe('u-1');
  });
});
