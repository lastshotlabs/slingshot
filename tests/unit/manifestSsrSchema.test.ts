/**
 * Tests for src/lib/manifest/ssr.ts — specifically the z.lazy() navigationItemSchema
 * (lines 525-554) which requires actually parsing navigation items to be covered.
 */
import { describe, expect, it } from 'bun:test';
import { navigationSectionSchema } from '../../src/lib/manifest/ssr';

describe('navigationSectionSchema — navigationItemSchema (lines 525-554)', () => {
  it('validates a minimal navigation section with one item', () => {
    const result = navigationSectionSchema.safeParse({
      shell: 'sidebar',
      items: [{ label: 'Dashboard', path: '/dashboard' }],
    });
    expect(result.success).toBe(true);
  });

  it('validates navigation item with all optional fields', () => {
    const result = navigationSectionSchema.safeParse({
      shell: 'top-nav',
      title: 'My App',
      items: [
        {
          label: 'Users',
          path: '/users',
          icon: 'users-icon',
          auth: 'userAuth',
          permission: 'admin.users.read',
          badge: 'new',
        },
      ],
      userMenu: [
        { label: 'Profile', path: '/profile' },
        { label: 'Logout', path: '/logout' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('validates navigation item with children (recursive z.lazy schema)', () => {
    const result = navigationSectionSchema.safeParse({
      shell: 'sidebar',
      items: [
        {
          label: 'Settings',
          path: '/settings',
          children: [
            { label: 'Profile', path: '/settings/profile' },
            { label: 'Security', path: '/settings/security' },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('validates navigation item with deeply nested children', () => {
    const result = navigationSectionSchema.safeParse({
      shell: 'sidebar',
      items: [
        {
          label: 'Level 1',
          path: '/level1',
          children: [
            {
              label: 'Level 2',
              path: '/level1/level2',
              children: [{ label: 'Level 3', path: '/level1/level2/level3' }],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('validates navigation item with a badge object', () => {
    const result = navigationSectionSchema.safeParse({
      shell: 'sidebar',
      items: [
        {
          label: 'Tasks',
          path: '/tasks',
          badge: {
            entity: 'task',
            aggregate: 'count',
            filter: { status: 'pending' },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects item with invalid auth value', () => {
    const result = navigationSectionSchema.safeParse({
      shell: 'sidebar',
      items: [{ label: 'Home', path: '/home', auth: 'invalid-auth' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects item with path that does not start with /', () => {
    const result = navigationSectionSchema.safeParse({
      shell: 'sidebar',
      items: [{ label: 'Home', path: 'no-leading-slash' }],
    });
    expect(result.success).toBe(false);
  });
});
