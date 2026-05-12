/**
 * Package-authoring entity modules for the organizations package.
 *
 * Each module uses `wiring: { mode: 'manual', buildAdapter }` so the package
 * factory can:
 *
 *   - Resolve a config-driven adapter via `createEntityFactories(...)`,
 *   - Wrap it in the per-entity adapter transforms (slug catch + validation +
 *     cascade-delete for Organization, identity + role resolution for the
 *     membership entities, token hashing + idempotency + sanitization for
 *     OrganizationInvite),
 *   - Publish the resulting adapter into the shared
 *     {@link OrganizationsAdapterRefs} bag through `onAdapter` so custom-op
 *     handlers, the orgService capability, and the reconcile service all see
 *     the same adapter instance (Rule 3 — closure-owned state, no globals).
 *
 * The bespoke routes (`listMine`, `findByToken`, `redeem`, `revokeInvite`)
 * are declared as `extraRoutes` on the corresponding modules. They mirror the
 * routePath + middleware shape of the original manifest and reuse the same
 * handler implementations lifted into `./runtime.ts`.
 *
 * @internal
 */
import type { OperationIdempotencyAdapter, StoreInfra, StoreType } from '@lastshotlabs/slingshot-core';
import { RESOLVE_ENTITY_FACTORIES, resolveRepo } from '@lastshotlabs/slingshot-core';
import { createEntityFactories, entity } from '@lastshotlabs/slingshot-entity';
import type {
  BareEntityAdapter,
  EntityRouteExecutionContext,
  EntityRouteExecutorBuilder,
  EntityRouteExecutorOverrides,
} from '@lastshotlabs/slingshot-entity';
import type { z } from 'zod';
import { Group } from './group';
import { GroupMembership } from './groupMembership';
import { Organization, organizationOperations } from './organization';
import { OrganizationInvite, organizationInviteOperations } from './organizationInvite';
import { OrganizationMember, organizationMemberOperations } from './organizationMember';
import type { OrganizationsAuthRuntime } from '../lib/authRuntime';
import {
  type OrganizationsAdapterRefs,
  applyDeleteCascadeTransform,
  applyGroupMembershipIdentityTransform,
  applyInviteRuntimeTransform,
  applyMemberIdentityTransform,
  applySlugConflictCatchTransform,
  applySlugValidationTransform,
  createFindByTokenHandler,
  createInviteIdempotencyDefaults,
  createListMineHandler,
  createRedeemHandler,
  createRevokeHandler,
  createRoleResolver,
} from './runtime';

type EntityFactoryCreator = typeof createEntityFactories;

/**
 * Resolve a config-driven adapter for an entity. Matches the framework's
 * standard-wiring code path so manual-wiring entities here behave the same
 * as the default factory pipeline.
 */
function resolveStandardAdapter(args: {
  config: Parameters<typeof createEntityFactories>[0];
  operations?: Parameters<typeof createEntityFactories>[1];
  storeType: StoreType;
  infra: StoreInfra;
}): BareEntityAdapter {
  const creator = Reflect.get(args.infra as object, RESOLVE_ENTITY_FACTORIES) as
    | EntityFactoryCreator
    | undefined;
  const factoryCreator = creator ?? createEntityFactories;
  const factories = args.operations
    ? factoryCreator(args.config, args.operations)
    : factoryCreator(args.config);
  return resolveRepo(factories, args.storeType, args.infra) as unknown as BareEntityAdapter;
}

export interface BuildOrganizationsEntityModulesArgs {
  refs: OrganizationsAdapterRefs;
  invitationTtlSeconds: number;
  defaultMemberRole: string;
  knownRoles: ReadonlyArray<string>;
  slugSchema: z.ZodType<string>;
  authRuntime: OrganizationsAuthRuntime;
  inviteIdempotencyAdapter?: OperationIdempotencyAdapter;
  inviteIdempotencyTtlMs?: number;
  organizationsEnabled: boolean;
  groupsEnabled: boolean;
}

/**
 * Build the entity modules the package mounts. Returns only the entities the
 * given config has enabled.
 */
export function buildOrganizationsEntityModules(args: BuildOrganizationsEntityModulesArgs) {
  const {
    refs,
    invitationTtlSeconds,
    defaultMemberRole,
    knownRoles,
    slugSchema,
    authRuntime,
    organizationsEnabled,
    groupsEnabled,
  } = args;

  const resolveRole = createRoleResolver({ knownRoles, defaultMemberRole });
  const idempotencyDefaults = createInviteIdempotencyDefaults(args.inviteIdempotencyAdapter);
  const inviteIdempotencyAdapter = idempotencyDefaults.adapter;
  const inviteIdempotencyTtlMs = args.inviteIdempotencyTtlMs ?? idempotencyDefaults.ttlMs;

  // ─── Custom-op handler wrappers as extraRoute executors ────────────────────
  const listMine = createListMineHandler(refs);
  const findByToken = createFindByTokenHandler(refs);
  const redeem = createRedeemHandler({ refs, authRuntime });
  const revoke = createRevokeHandler(refs);

  /**
   * Bind a custom-op handler to an entity route executor. The handler is the
   * lifted manifest custom-handler; routing/auth/middleware comes from each
   * entity's `routes.operations.{name}` config so the response shape and
   * authorization story stay identical to the manifest path.
   */
  const wrapHandler =
    (handler: (input: unknown) => Promise<unknown>): EntityRouteExecutorBuilder =>
    () =>
    async (ctx: EntityRouteExecutionContext) => {
      const result = await handler(ctx.input);
      if (result === null) {
        return ctx.respond.json(null);
      }
      return ctx.respond.json(result as Record<string, unknown>);
    };

  const organizationOverrides: EntityRouteExecutorOverrides = {
    operations: {
      listMine: wrapHandler(listMine),
    },
  };

  const inviteOverrides: EntityRouteExecutorOverrides = {
    operations: {
      findByToken: wrapHandler(findByToken),
      redeem: wrapHandler(redeem),
      revokeInvite: wrapHandler(revoke),
    },
  };

  // ─── Module assembly ──────────────────────────────────────────────────────

  const organizationModule = organizationsEnabled
    ? entity({
        config: Organization,
        operations: organizationOperations,
        path: 'orgs',
        overrides: organizationOverrides,
        wiring: {
          mode: 'manual',
          buildAdapter: (storeType, infra) => {
            const base = resolveStandardAdapter({
              config: Organization,
              operations: organizationOperations.operations,
              storeType,
              infra,
            });
            // Innermost first → outermost: slugConflictCatch → slugValidation
            //   → deleteCascade. Matches the manifest's transform order
            // (manifest registers them in the same outer-to-inner-traversal
            // order: slugConflictCatch, slugValidation, deleteCascade — the
            // entity layer applies them left-to-right, so each subsequent
            // transform wraps the previous one).
            const withConflict = applySlugConflictCatchTransform(base);
            const withValidation = applySlugValidationTransform(withConflict, slugSchema);
            const wrapped = applyDeleteCascadeTransform(withValidation, refs);
            refs.organizations = wrapped;
            return wrapped;
          },
        },
      })
    : null;

  const organizationMemberModule = organizationsEnabled
    ? entity({
        config: OrganizationMember,
        operations: organizationMemberOperations,
        path: 'orgs/:orgId/members',
        wiring: {
          mode: 'manual',
          buildAdapter: (storeType, infra) => {
            const base = resolveStandardAdapter({
              config: OrganizationMember,
              operations: organizationMemberOperations.operations,
              storeType,
              infra,
            });
            const wrapped = applyMemberIdentityTransform(base, { resolveRole });
            refs.members = wrapped;
            return wrapped;
          },
        },
      })
    : null;

  const organizationInviteModule = organizationsEnabled
    ? entity({
        config: OrganizationInvite,
        operations: organizationInviteOperations,
        path: 'orgs/:orgId/invitations',
        overrides: inviteOverrides,
        wiring: {
          mode: 'manual',
          buildAdapter: (storeType, infra) => {
            const base = resolveStandardAdapter({
              config: OrganizationInvite,
              operations: organizationInviteOperations.operations,
              storeType,
              infra,
            });
            const wrapped = applyInviteRuntimeTransform(base, {
              invitationTtlSeconds,
              resolveRole,
              inviteIdempotencyAdapter,
              inviteIdempotencyTtlMs,
            });
            refs.invites = wrapped;
            return wrapped;
          },
        },
      })
    : null;

  const groupModule = groupsEnabled
    ? entity({
        config: Group,
        path: 'groups',
        wiring: {
          mode: 'manual',
          buildAdapter: (storeType, infra) => {
            const base = resolveStandardAdapter({
              config: Group,
              storeType,
              infra,
            });
            refs.groups = base;
            return base;
          },
        },
      })
    : null;

  const groupMembershipModule = groupsEnabled
    ? entity({
        config: GroupMembership,
        path: 'groups/:groupId/members',
        wiring: {
          mode: 'manual',
          buildAdapter: (storeType, infra) => {
            const base = resolveStandardAdapter({
              config: GroupMembership,
              storeType,
              infra,
            });
            const wrapped = applyGroupMembershipIdentityTransform(base, { resolveRole });
            refs.groupMemberships = wrapped;
            return wrapped;
          },
        },
      })
    : null;

  return {
    organizationModule,
    organizationMemberModule,
    organizationInviteModule,
    groupModule,
    groupMembershipModule,
  };
}
