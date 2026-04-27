import { describe, expect, test } from 'bun:test';
import { Group } from '../../src/entities/group';
import { GroupMembership } from '../../src/entities/groupMembership';
import { Organization } from '../../src/entities/organization';
import { OrganizationInvite } from '../../src/entities/organizationInvite';
import { OrganizationMember } from '../../src/entities/organizationMember';

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

describe('Organization entity', () => {
  test('has correct name and namespace', () => {
    expect(Organization.name).toBe('Organization');
    expect(Organization.namespace).toBe('organizations');
  });

  test('derives correct storage name', () => {
    expect(Organization._storageName).toBe('organizations_organizations');
  });

  test('has id as primary key with uuid default', () => {
    expect(Organization._pkField).toBe('id');
    expect(Organization.fields.id.primary).toBe(true);
    expect(Organization.fields.id.default).toBe('uuid');
    expect(Organization.fields.id.type).toBe('string');
  });

  test('has required fields: name, slug', () => {
    expect(Organization.fields.name.type).toBe('string');
    expect(Organization.fields.name.optional).toBe(false);

    expect(Organization.fields.slug.type).toBe('string');
    expect(Organization.fields.slug.optional).toBe(false);
    expect(Organization.fields.slug.immutable).toBe(true);
  });

  test('has optional fields: tenantId, description, logoUrl', () => {
    expect(Organization.fields.tenantId.optional).toBe(true);
    expect(Organization.fields.description.optional).toBe(true);
    expect(Organization.fields.logoUrl.optional).toBe(true);
  });

  test('has createdAt with now default (immutable) and updatedAt with onUpdate', () => {
    expect(Organization.fields.createdAt.type).toBe('date');
    expect(Organization.fields.createdAt.default).toBe('now');
    expect(Organization.fields.createdAt.immutable).toBe(true);

    expect(Organization.fields.updatedAt.type).toBe('date');
    expect(Organization.fields.updatedAt.default).toBe('now');
    expect(Organization.fields.updatedAt.onUpdate).toBe('now');
  });

  test('has unique index on slug', () => {
    const slugIndex = Organization.indexes?.find(
      idx => idx.fields.length === 1 && idx.fields[0] === 'slug',
    );
    expect(slugIndex).toBeDefined();
    expect(slugIndex?.unique).toBe(true);
  });

  test('has index on tenantId', () => {
    const tenantIndex = Organization.indexes?.find(
      idx => idx.fields.length === 1 && idx.fields[0] === 'tenantId',
    );
    expect(tenantIndex).toBeDefined();
  });

  test('has compound index on tenantId + name', () => {
    const compoundIndex = Organization.indexes?.find(
      idx => idx.fields[0] === 'tenantId' && idx.fields[1] === 'name',
    );
    expect(compoundIndex).toBeDefined();
  });

  test('disables the get-by-id route', () => {
    // The disable array should contain 'get' which disables the default GET /:id route
    const disabled = Organization.routes?.disable ?? [];
    expect(disabled).toContain('get');
  });

  test('list and create routes require organizationsAdminGuard middleware', () => {
    expect(Organization.routes?.list).toMatchObject({
      middleware: expect.arrayContaining(['organizationsAdminGuard']),
    });
    expect(Organization.routes?.create).toMatchObject({
      middleware: expect.arrayContaining(['organizationsAdminGuard']),
    });
  });

  test('update and delete routes require organizationsAdminGuard middleware', () => {
    expect(Organization.routes?.update).toMatchObject({
      middleware: expect.arrayContaining(['organizationsAdminGuard']),
    });
    expect(Organization.routes?.delete).toMatchObject({
      middleware: expect.arrayContaining(['organizationsAdminGuard']),
    });
  });

  test('getBySlug operation is defined on GET by-slug/:slug', () => {
    const getBySlug = Organization.routes?.operations?.getBySlug;
    expect(getBySlug).toBeDefined();
    expect(getBySlug?.method).toBe('get');
    expect(getBySlug?.path).toBe('by-slug/:slug');
    expect(getBySlug?.middleware).toContain('organizationsAdminGuard');
  });

  test('listMine operation is defined on GET mine', () => {
    const listMine = Organization.routes?.operations?.listMine;
    expect(listMine).toBeDefined();
    expect(listMine?.method).toBe('get');
    expect(listMine?.path).toBe('mine');
  });

  test('defaults auth is userAuth', () => {
    expect(Organization.routes?.defaults?.auth).toBe('userAuth');
  });
});

// ---------------------------------------------------------------------------
// OrganizationMember
// ---------------------------------------------------------------------------

describe('OrganizationMember entity', () => {
  test('has correct name and namespace', () => {
    expect(OrganizationMember.name).toBe('OrganizationMember');
    expect(OrganizationMember.namespace).toBe('organizations');
  });

  test('has id as primary key with uuid default', () => {
    expect(OrganizationMember._pkField).toBe('id');
    expect(OrganizationMember.fields.id.primary).toBe(true);
    expect(OrganizationMember.fields.id.default).toBe('uuid');
  });

  test('has required immutable fields: orgId, userId', () => {
    expect(OrganizationMember.fields.orgId.type).toBe('string');
    expect(OrganizationMember.fields.orgId.optional).toBe(false);
    expect(OrganizationMember.fields.orgId.immutable).toBe(true);

    expect(OrganizationMember.fields.userId.type).toBe('string');
    expect(OrganizationMember.fields.userId.optional).toBe(false);
    expect(OrganizationMember.fields.userId.immutable).toBe(true);
  });

  test('role is an enum with default member', () => {
    expect(OrganizationMember.fields.role.type).toBe('enum');
    expect(OrganizationMember.fields.role.default).toBe('member');
    expect(OrganizationMember.fields.role.enumValues).toEqual(['owner', 'admin', 'member']);
  });

  test('joinedAt has now default and is immutable', () => {
    expect(OrganizationMember.fields.joinedAt.type).toBe('date');
    expect(OrganizationMember.fields.joinedAt.default).toBe('now');
    expect(OrganizationMember.fields.joinedAt.immutable).toBe(true);
  });

  test('invitedBy is optional', () => {
    expect(OrganizationMember.fields.invitedBy.optional).toBe(true);
  });

  test('has unique compound index on orgId + userId', () => {
    const idx = OrganizationMember.indexes?.find(
      i => i.fields[0] === 'orgId' && i.fields[1] === 'userId',
    );
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(true);
  });

  test('has index on orgId', () => {
    const idx = OrganizationMember.indexes?.find(
      i => i.fields.length === 1 && i.fields[0] === 'orgId',
    );
    expect(idx).toBeDefined();
  });

  test('has index on userId', () => {
    const idx = OrganizationMember.indexes?.find(
      i => i.fields.length === 1 && i.fields[0] === 'userId',
    );
    expect(idx).toBeDefined();
  });

  test('routes default to userAuth with organizationsAdminGuard', () => {
    expect(OrganizationMember.routes?.defaults?.auth).toBe('userAuth');
    expect(OrganizationMember.routes?.defaults?.middleware).toContain('organizationsAdminGuard');
  });

  test('dataScope scopes to orgId from param', () => {
    const dataScope = OrganizationMember.routes?.dataScope;
    // dataScope is an object with field/from
    expect(dataScope).toMatchObject({ field: 'orgId', from: 'param:orgId' });
  });
});

// ---------------------------------------------------------------------------
// OrganizationInvite
// ---------------------------------------------------------------------------

describe('OrganizationInvite entity', () => {
  test('has correct name and namespace', () => {
    expect(OrganizationInvite.name).toBe('OrganizationInvite');
    expect(OrganizationInvite.namespace).toBe('organizations');
  });

  test('has id as primary key with uuid default', () => {
    expect(OrganizationInvite._pkField).toBe('id');
    expect(OrganizationInvite.fields.id.primary).toBe(true);
    expect(OrganizationInvite.fields.id.default).toBe('uuid');
  });

  test('has required immutable fields: orgId, invitedBy', () => {
    expect(OrganizationInvite.fields.orgId.immutable).toBe(true);
    expect(OrganizationInvite.fields.orgId.optional).toBe(false);

    expect(OrganizationInvite.fields.invitedBy.immutable).toBe(true);
    expect(OrganizationInvite.fields.invitedBy.optional).toBe(false);
  });

  test('tokenHash is immutable and optional', () => {
    expect(OrganizationInvite.fields.tokenHash.immutable).toBe(true);
    expect(OrganizationInvite.fields.tokenHash.optional).toBe(true);
  });

  test('email and userId are optional', () => {
    expect(OrganizationInvite.fields.email.optional).toBe(true);
    expect(OrganizationInvite.fields.userId.optional).toBe(true);
  });

  test('role is an enum with default member', () => {
    expect(OrganizationInvite.fields.role.type).toBe('enum');
    expect(OrganizationInvite.fields.role.default).toBe('member');
    expect(OrganizationInvite.fields.role.enumValues).toEqual(['owner', 'admin', 'member']);
  });

  test('expiresAt is a required date field', () => {
    expect(OrganizationInvite.fields.expiresAt.type).toBe('date');
    expect(OrganizationInvite.fields.expiresAt.optional).toBe(false);
  });

  test('acceptedAt and revokedAt are optional date fields', () => {
    expect(OrganizationInvite.fields.acceptedAt.type).toBe('date');
    expect(OrganizationInvite.fields.acceptedAt.optional).toBe(true);

    expect(OrganizationInvite.fields.revokedAt.type).toBe('date');
    expect(OrganizationInvite.fields.revokedAt.optional).toBe(true);
  });

  test('createdAt has now default and is immutable', () => {
    expect(OrganizationInvite.fields.createdAt.default).toBe('now');
    expect(OrganizationInvite.fields.createdAt.immutable).toBe(true);
  });

  test('has unique index on tokenHash', () => {
    const idx = OrganizationInvite.indexes?.find(
      i => i.fields.length === 1 && i.fields[0] === 'tokenHash',
    );
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(true);
  });

  test('has index on orgId', () => {
    const idx = OrganizationInvite.indexes?.find(
      i => i.fields.length === 1 && i.fields[0] === 'orgId',
    );
    expect(idx).toBeDefined();
  });

  test('has compound index on orgId + acceptedAt', () => {
    const idx = OrganizationInvite.indexes?.find(
      i => i.fields[0] === 'orgId' && i.fields[1] === 'acceptedAt',
    );
    expect(idx).toBeDefined();
  });

  test('has compound index on orgId + revokedAt', () => {
    const idx = OrganizationInvite.indexes?.find(
      i => i.fields[0] === 'orgId' && i.fields[1] === 'revokedAt',
    );
    expect(idx).toBeDefined();
  });

  test('update and delete are disabled', () => {
    const disabled = OrganizationInvite.routes?.disable ?? [];
    expect(disabled).toContain('update');
    expect(disabled).toContain('delete');
  });

  test('create route requires inviteCreateDefaults and organizationsAdminGuard', () => {
    expect(OrganizationInvite.routes?.create).toMatchObject({
      middleware: expect.arrayContaining(['inviteCreateDefaults', 'organizationsAdminGuard']),
    });
  });

  test('list and get routes require organizationsAdminGuard', () => {
    expect(OrganizationInvite.routes?.list).toMatchObject({
      middleware: expect.arrayContaining(['organizationsAdminGuard']),
    });
    expect(OrganizationInvite.routes?.get).toMatchObject({
      middleware: expect.arrayContaining(['organizationsAdminGuard']),
    });
  });

  test('findByToken operation uses POST with no auth', () => {
    const op = OrganizationInvite.routes?.operations?.findByToken;
    expect(op).toBeDefined();
    expect(op?.method).toBe('post');
    expect(op?.path).toBe('lookup');
    expect(op?.auth).toBe('none');
  });

  test('redeem operation uses POST with userAuth', () => {
    const op = OrganizationInvite.routes?.operations?.redeem;
    expect(op).toBeDefined();
    expect(op?.method).toBe('post');
    expect(op?.path).toBe('redeem');
    expect(op?.auth).toBe('userAuth');
  });

  test('revokeInvite operation uses DELETE with userAuth and organizationsAdminGuard', () => {
    const op = OrganizationInvite.routes?.operations?.revokeInvite;
    expect(op).toBeDefined();
    expect(op?.method).toBe('delete');
    expect(op?.path).toBe(':id');
    expect(op?.auth).toBe('userAuth');
    expect(op?.middleware).toContain('organizationsAdminGuard');
  });

  test('defaults auth is userAuth', () => {
    expect(OrganizationInvite.routes?.defaults?.auth).toBe('userAuth');
  });
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

describe('Group entity', () => {
  test('has correct name and namespace', () => {
    expect(Group.name).toBe('Group');
    expect(Group.namespace).toBe('organizations');
  });

  test('has id as primary key with uuid default', () => {
    expect(Group._pkField).toBe('id');
    expect(Group.fields.id.primary).toBe(true);
    expect(Group.fields.id.default).toBe('uuid');
  });

  test('has required fields: name, slug', () => {
    expect(Group.fields.name.type).toBe('string');
    expect(Group.fields.name.optional).toBe(false);

    expect(Group.fields.slug.type).toBe('string');
    expect(Group.fields.slug.optional).toBe(false);
  });

  test('tenantId and orgId are optional', () => {
    expect(Group.fields.tenantId.optional).toBe(true);
    expect(Group.fields.orgId.optional).toBe(true);
  });

  test('createdAt has now default and is immutable', () => {
    expect(Group.fields.createdAt.default).toBe('now');
    expect(Group.fields.createdAt.immutable).toBe(true);
  });

  test('has unique compound index on tenantId + slug', () => {
    const idx = Group.indexes?.find(
      i => i.fields[0] === 'tenantId' && i.fields[1] === 'slug',
    );
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(true);
  });

  test('has index on orgId', () => {
    const idx = Group.indexes?.find(i => i.fields.length === 1 && i.fields[0] === 'orgId');
    expect(idx).toBeDefined();
  });

  test('has index on tenantId', () => {
    const idx = Group.indexes?.find(i => i.fields.length === 1 && i.fields[0] === 'tenantId');
    expect(idx).toBeDefined();
  });

  test('routes default to userAuth with groupsAdminGuard', () => {
    expect(Group.routes?.defaults?.auth).toBe('userAuth');
    expect(Group.routes?.defaults?.middleware).toContain('groupsAdminGuard');
  });
});

// ---------------------------------------------------------------------------
// GroupMembership
// ---------------------------------------------------------------------------

describe('GroupMembership entity', () => {
  test('has correct name and namespace', () => {
    expect(GroupMembership.name).toBe('GroupMembership');
    expect(GroupMembership.namespace).toBe('organizations');
  });

  test('has id as primary key with uuid default', () => {
    expect(GroupMembership._pkField).toBe('id');
    expect(GroupMembership.fields.id.primary).toBe(true);
    expect(GroupMembership.fields.id.default).toBe('uuid');
  });

  test('has required immutable fields: groupId, userId', () => {
    expect(GroupMembership.fields.groupId.immutable).toBe(true);
    expect(GroupMembership.fields.groupId.optional).toBe(false);

    expect(GroupMembership.fields.userId.immutable).toBe(true);
    expect(GroupMembership.fields.userId.optional).toBe(false);
  });

  test('role is an enum with default member', () => {
    expect(GroupMembership.fields.role.type).toBe('enum');
    expect(GroupMembership.fields.role.default).toBe('member');
    expect(GroupMembership.fields.role.enumValues).toEqual(['owner', 'admin', 'member']);
  });

  test('joinedAt has now default and is immutable', () => {
    expect(GroupMembership.fields.joinedAt.default).toBe('now');
    expect(GroupMembership.fields.joinedAt.immutable).toBe(true);
  });

  test('has unique compound index on groupId + userId', () => {
    const idx = GroupMembership.indexes?.find(
      i => i.fields[0] === 'groupId' && i.fields[1] === 'userId',
    );
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(true);
  });

  test('has index on groupId', () => {
    const idx = GroupMembership.indexes?.find(
      i => i.fields.length === 1 && i.fields[0] === 'groupId',
    );
    expect(idx).toBeDefined();
  });

  test('has index on userId', () => {
    const idx = GroupMembership.indexes?.find(
      i => i.fields.length === 1 && i.fields[0] === 'userId',
    );
    expect(idx).toBeDefined();
  });

  test('update is disabled', () => {
    const disabled = GroupMembership.routes?.disable ?? [];
    expect(disabled).toContain('update');
  });

  test('dataScope scopes to groupId from param', () => {
    const dataScope = GroupMembership.routes?.dataScope;
    expect(dataScope).toMatchObject({ field: 'groupId', from: 'param:groupId' });
  });

  test('routes default to userAuth with groupsAdminGuard', () => {
    expect(GroupMembership.routes?.defaults?.auth).toBe('userAuth');
    expect(GroupMembership.routes?.defaults?.middleware).toContain('groupsAdminGuard');
  });
});
