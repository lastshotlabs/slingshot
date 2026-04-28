import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import { entityConfigToManifestEntry } from '@lastshotlabs/slingshot-entity';
import { Group } from '../entities/group';
import { GroupMembership } from '../entities/groupMembership';
import { Organization, organizationOperations } from '../entities/organization';
import { OrganizationInvite, organizationInviteOperations } from '../entities/organizationInvite';
import { OrganizationMember, organizationMemberOperations } from '../entities/organizationMember';

/**
 * Declarative manifest for the organizations package.
 */
export const organizationsManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'organizations',
  hooks: {
    afterAdapters: [{ handler: 'organizations.captureAdapters' }],
  },
  entities: {
    Organization: entityConfigToManifestEntry(Organization, {
      operations: organizationOperations.operations,
      routePath: 'orgs',
      adapterTransforms: [
        // Innermost: convert duplicate-slug DB errors into a typed
        // `SlugConflictError` (HTTP 409). Must wrap the real storage adapter
        // so it sees raw unique-constraint violations.
        { handler: 'organizations.organization.slugConflictCatch' },
        { handler: 'organizations.organization.slugValidation' },
        { handler: 'organizations.organization.deleteCascade' },
      ],
      operationOverrides: {
        listMine: {
          kind: 'custom',
          handler: 'organizations.organization.listMine',
          http: { method: 'get', path: 'mine' },
        },
      },
    }),
    OrganizationMember: entityConfigToManifestEntry(OrganizationMember, {
      operations: organizationMemberOperations.operations,
      routePath: 'orgs/:orgId/members',
      adapterTransforms: [{ handler: 'organizations.member.identity' }],
    }),
    OrganizationInvite: entityConfigToManifestEntry(OrganizationInvite, {
      operations: organizationInviteOperations.operations,
      routePath: 'orgs/:orgId/invitations',
      adapterTransforms: [{ handler: 'organizations.invite.runtime' }],
      operationOverrides: {
        findByToken: {
          kind: 'custom',
          handler: 'organizations.invite.findByToken',
          http: { method: 'post', path: 'lookup' },
        },
        redeem: {
          kind: 'custom',
          handler: 'organizations.invite.redeem',
          http: { method: 'post', path: 'redeem' },
        },
        revokeInvite: {
          kind: 'custom',
          handler: 'organizations.invite.revoke',
          http: { method: 'delete', path: ':id' },
        },
      },
    }),
    Group: entityConfigToManifestEntry(Group, {
      routePath: 'groups',
    }),
    GroupMembership: entityConfigToManifestEntry(GroupMembership, {
      routePath: 'groups/:groupId/members',
      adapterTransforms: [{ handler: 'organizations.groupMembership.identity' }],
    }),
  },
};
