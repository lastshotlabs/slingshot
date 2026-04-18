import { type AuthResolvedConfig, DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { createLoginSchema, createPasswordSchema, createRegisterSchema } from '@auth/schemas/auth';
import { beforeEach, describe, expect, test } from 'bun:test';

let config: AuthResolvedConfig;

describe('createRegisterSchema', () => {
  beforeEach(() => {
    // Reset to defaults
    config = { ...DEFAULT_AUTH_CONFIG };
  });

  test('email primaryField requires valid email', () => {
    const schema = createRegisterSchema('email', config.passwordPolicy);
    expect(schema.safeParse({ email: 'bad', password: 'Password1' }).success).toBe(false);
    expect(schema.safeParse({ email: 'a@b.com', password: 'Password1' }).success).toBe(true);
  });

  test('username primaryField requires min 3 chars', () => {
    const schema = createRegisterSchema('username', config.passwordPolicy);
    expect(schema.safeParse({ username: 'ab', password: 'Password1' }).success).toBe(false);
    expect(schema.safeParse({ username: 'abc', password: 'Password1' }).success).toBe(true);
  });

  test('phone primaryField requires min 3 chars', () => {
    const schema = createRegisterSchema('phone', config.passwordPolicy);
    expect(schema.safeParse({ phone: '12', password: 'Password1' }).success).toBe(false);
    expect(schema.safeParse({ phone: '123', password: 'Password1' }).success).toBe(true);
  });

  test('password respects minLength policy', () => {
    config = {
      ...config,
      passwordPolicy: { minLength: 12, requireLetter: false, requireDigit: false },
    };
    const schema = createRegisterSchema('email', config.passwordPolicy);
    expect(schema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(false);
    expect(schema.safeParse({ email: 'a@b.com', password: 'longenoughhere' }).success).toBe(true);
  });

  test('password requires letter by default', () => {
    const schema = createRegisterSchema('email', config.passwordPolicy);
    expect(schema.safeParse({ email: 'a@b.com', password: '12345678' }).success).toBe(false);
  });

  test('password requireLetter can be disabled', () => {
    config = { ...config, passwordPolicy: { requireLetter: false, requireDigit: false } };
    const schema = createRegisterSchema('email', config.passwordPolicy);
    expect(schema.safeParse({ email: 'a@b.com', password: '12345678' }).success).toBe(true);
  });

  test('password requires digit by default', () => {
    const schema = createRegisterSchema('email', config.passwordPolicy);
    expect(schema.safeParse({ email: 'a@b.com', password: 'abcdefgh' }).success).toBe(false);
  });

  test('password requireDigit can be disabled', () => {
    config = { ...config, passwordPolicy: { requireDigit: false } };
    const schema = createRegisterSchema('email', config.passwordPolicy);
    expect(schema.safeParse({ email: 'a@b.com', password: 'abcdefgh' }).success).toBe(true);
  });

  test('password requireSpecial enforces special char', () => {
    config = { ...config, passwordPolicy: { requireSpecial: true } };
    const schema = createRegisterSchema('email', config.passwordPolicy);
    expect(schema.safeParse({ email: 'a@b.com', password: 'Password1' }).success).toBe(false);
    expect(schema.safeParse({ email: 'a@b.com', password: 'Password1!' }).success).toBe(true);
  });
});

describe('createLoginSchema', () => {
  beforeEach(() => {
    config = { ...DEFAULT_AUTH_CONFIG };
  });

  test('email primaryField requires valid email', () => {
    const schema = createLoginSchema('email');
    expect(schema.safeParse({ email: 'bad', password: 'x' }).success).toBe(false);
    expect(schema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });

  test('username primaryField requires min 1 char', () => {
    const schema = createLoginSchema('username');
    expect(schema.safeParse({ username: '', password: 'x' }).success).toBe(false);
    expect(schema.safeParse({ username: 'a', password: 'x' }).success).toBe(true);
  });

  test('phone primaryField requires min 1 char', () => {
    const schema = createLoginSchema('phone');
    expect(schema.safeParse({ phone: '', password: 'x' }).success).toBe(false);
    expect(schema.safeParse({ phone: '1', password: 'x' }).success).toBe(true);
  });

  test('password requires min 1 char (no policy enforcement on login)', () => {
    const schema = createLoginSchema('email');
    expect(schema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
    expect(schema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });
});

describe('createPasswordSchema', () => {
  beforeEach(() => {
    config = { ...DEFAULT_AUTH_CONFIG };
  });

  test('uses same policy as registration', () => {
    config = { ...config, passwordPolicy: { requireSpecial: true } };
    const schema = createPasswordSchema(config.passwordPolicy);
    expect(schema.safeParse('Password1').success).toBe(false);
    expect(schema.safeParse('Password1!').success).toBe(true);
  });
});
