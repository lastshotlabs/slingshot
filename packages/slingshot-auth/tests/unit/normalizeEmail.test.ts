import { describe, expect, test } from 'bun:test';
import { normalizeEmail } from '../../src/lib/normalizeEmail';

describe('normalizeEmail', () => {
  test('basic lowercase', () => {
    expect(normalizeEmail('Alice@Example.com')).toBe('alice@example.com');
  });

  test('Gmail dot removal', () => {
    expect(normalizeEmail('u.s.e.r@gmail.com')).toBe('user@gmail.com');
  });

  test('Gmail plus removal', () => {
    expect(normalizeEmail('user+tag@gmail.com')).toBe('user@gmail.com');
  });

  test('Gmail dot + plus combined', () => {
    expect(normalizeEmail('u.s.e.r+shopping@gmail.com')).toBe('user@gmail.com');
  });

  test('googlemail treated same as gmail', () => {
    expect(normalizeEmail('u.s.e.r+tag@googlemail.com')).toBe('user@googlemail.com');
  });

  test('non-Gmail preserves dots', () => {
    expect(normalizeEmail('first.last@outlook.com')).toBe('first.last@outlook.com');
  });

  test('non-Gmail preserves plus', () => {
    expect(normalizeEmail('user+tag@yahoo.com')).toBe('user+tag@yahoo.com');
  });

  test('no @ sign returns lowercased input', () => {
    expect(normalizeEmail('invalid')).toBe('invalid');
  });

  test('multiple @ signs uses lastIndexOf', () => {
    // lastIndexOf('@') splits at the last '@', so local='weird@name', domain='gmail.com'
    // Gmail provider: strip dots and plus from local
    expect(normalizeEmail('weird@name@gmail.com')).toBe('weird@name@gmail.com');
  });

  test('empty string', () => {
    expect(normalizeEmail('')).toBe('');
  });

  test('already normalized', () => {
    expect(normalizeEmail('user@gmail.com')).toBe('user@gmail.com');
  });

  test('case folding on domain triggers Gmail normalization', () => {
    expect(normalizeEmail('user@GMAIL.COM')).toBe('user@gmail.com');
  });

  test('plus at start of local — edge case', () => {
    // local='+tag', plus stripped → local='', domain='gmail.com'
    expect(normalizeEmail('+tag@gmail.com')).toBe('@gmail.com');
  });

  test('only dots in local — edge case', () => {
    // local='...', dots removed → local='', domain='gmail.com'
    expect(normalizeEmail('...@gmail.com')).toBe('@gmail.com');
  });
});
