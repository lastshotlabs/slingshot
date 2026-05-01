/**
 * Unit tests for parseMigrationVersion, which extracts a validated integer
 * migration version from the raw value stored in _slingshot_auth_schema_version.
 */
import { describe, expect, test } from 'bun:test';
import { parseMigrationVersion } from '../../src/adapter.js';

// ---------------------------------------------------------------------------
// Valid string inputs
// ---------------------------------------------------------------------------

describe('parseMigrationVersion', () => {
  describe('valid string inputs', () => {
    test('"0001" parses to 1', () => {
      expect(parseMigrationVersion('0001', 5)).toBe(1);
    });

    test('"0002_init" parses to 2', () => {
      expect(parseMigrationVersion('0002_init', 5)).toBe(2);
    });

    test('"0001_some_description" parses to 1', () => {
      expect(parseMigrationVersion('0001_some_description', 5)).toBe(1);
    });

    test('"0" parses to 0', () => {
      expect(parseMigrationVersion('0', 5)).toBe(0);
    });

    test('"9999" parses to 9999 when maxVersion allows it', () => {
      expect(parseMigrationVersion('9999', 9999)).toBe(9999);
    });

    test('multiple underscore segments parse correctly', () => {
      expect(parseMigrationVersion('0010_long_description_here', 100)).toBe(10);
    });

    test('leading zeros are stripped during parsing', () => {
      expect(parseMigrationVersion('0000007_migration', 10)).toBe(7);
    });
  });

  // ---------------------------------------------------------------------------
  // Valid numeric inputs
  // ---------------------------------------------------------------------------

  describe('valid numeric inputs', () => {
    test('positive integer returns the same value', () => {
      expect(parseMigrationVersion(3, 5)).toBe(3);
    });

    test('zero returns 0', () => {
      expect(parseMigrationVersion(0, 5)).toBe(0);
    });

    test('maxVersion boundary returns the max value', () => {
      expect(parseMigrationVersion(5, 5)).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty string
  // ---------------------------------------------------------------------------

  describe('empty string', () => {
    test('throws an error', () => {
      expect(() => parseMigrationVersion('', 5)).toThrow(
        '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: ',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid string formats
  // ---------------------------------------------------------------------------

  describe('invalid string formats', () => {
    test('non-numeric string throws', () => {
      expect(() => parseMigrationVersion('abc', 5)).toThrow(
        '[slingshot-postgres] Invalid value in _slingshot_auth_schema_version: abc',
      );
    });

    test('string starting with letters throws', () => {
      expect(() => parseMigrationVersion('abc123', 5)).toThrow();
    });

    test('negative number string throws', () => {
      expect(() => parseMigrationVersion('-1', 5)).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid types
  // ---------------------------------------------------------------------------

  describe('invalid types', () => {
    test('null throws', () => {
      expect(() => parseMigrationVersion(null, 5)).toThrow();
    });

    test('undefined throws', () => {
      expect(() => parseMigrationVersion(undefined, 5)).toThrow();
    });

    test('float throws', () => {
      expect(() => parseMigrationVersion(1.5, 5)).toThrow();
    });

    test('negative integer throws', () => {
      expect(() => parseMigrationVersion(-1, 5)).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // maxVersion boundary
  // ---------------------------------------------------------------------------

  describe('maxVersion boundary', () => {
    test('string version exceeding maxVersion throws', () => {
      expect(() => parseMigrationVersion('0010', 5)).toThrow(
        '[slingshot-postgres] Database schema version 10 is newer than this binary supports (5).',
      );
    });

    test('number version exceeding maxVersion throws', () => {
      expect(() => parseMigrationVersion(10, 5)).toThrow(
        '[slingshot-postgres] Database schema version 10 is newer than this binary supports (5).',
      );
    });
  });
});
