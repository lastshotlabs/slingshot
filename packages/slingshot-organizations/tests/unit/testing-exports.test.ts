import { describe, expect, test } from 'bun:test';
import {
  SlugConflictError,
  createTestOrganizationsPlugin,
  isUniqueViolationError,
} from '../../src/testing';

describe('organizations testing entrypoint', () => {
  test('exports plugin factory and error helpers', () => {
    const plugin = createTestOrganizationsPlugin();
    const nestedDuplicate = new Error('outer', {
      cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });

    expect(plugin.name).toBe('slingshot-organizations');
    expect(new SlugConflictError('taken').status).toBe(409);
    expect(isUniqueViolationError(nestedDuplicate)).toBe(true);
  });
});
