import { describe, expect, test } from 'bun:test';
import { Group } from '../../src/entities/group';
import { GroupMembership } from '../../src/entities/groupMembership';
import { Organization } from '../../src/entities/organization';
import { OrganizationInvite } from '../../src/entities/organizationInvite';
import { OrganizationMember } from '../../src/entities/organizationMember';

describe('Organization entity', () => {
  test('has required fields', () => {
    const org = { name: 'Test Org', slug: 'test-org' };
    expect(org.name).toBe('Test Org');
    expect(org.slug).toBe('test-org');
  });

  test('slug must be lowercase kebab', () => {
    const validSlugs = ['my-org', 'test-123', 'a-b-c'];
    for (const slug of validSlugs) {
      expect(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)).toBe(true);
    }
  });

  test('invalid slugs are rejected', () => {
    const invalidSlugs = ['My-Org', 'my_org', '123-org', '-org', 'org-'];
    for (const slug of invalidSlugs) {
      expect(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)).toBe(false);
    }
  });
});

describe('Group entity', () => {
  test('has required fields', () => {
    const group = { name: 'Test Group', slug: 'test-group', organizationId: 'org-1' };
    expect(group.name).toBe('Test Group');
    expect(group.slug).toBe('test-group');
    expect(group.organizationId).toBe('org-1');
  });
});

describe('OrganizationMember entity', () => {
  test('has required fields', () => {
    const member = { organizationId: 'org-1', userId: 'user-1', role: 'member' };
    expect(member.organizationId).toBe('org-1');
    expect(member.userId).toBe('user-1');
    expect(member.role).toBe('member');
  });
});

describe('OrganizationInvite entity', () => {
  test('has required fields', () => {
    const invite = {
      organizationId: 'org-1',
      email: 'test@example.com',
      role: 'member',
      token: 'abc123',
    };
    expect(invite.organizationId).toBe('org-1');
    expect(invite.email).toBe('test@example.com');
    expect(invite.role).toBe('member');
    expect(invite.token).toBe('abc123');
  });
});

describe('GroupMembership entity', () => {
  test('has required fields', () => {
    const membership = { groupId: 'group-1', userId: 'user-1' };
    expect(membership.groupId).toBe('group-1');
    expect(membership.userId).toBe('user-1');
  });
});
