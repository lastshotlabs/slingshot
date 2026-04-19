import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getPluginState,
  getPluginStateOrNull,
  getRouteAuthOrNull,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import { getOrganizationsAuthRuntime } from './lib/authRuntime';
import { organizationsManifest } from './manifest/organizationsManifest';
import { createOrganizationsManifestRuntime } from './manifest/runtime';
import { ORGANIZATIONS_ORG_SERVICE_STATE_KEY, type OrganizationsOrgService } from './orgService';

const memberRoleSchema = z.enum(['owner', 'admin', 'member']);

const organizationsPluginConfigSchema = z.object({
  mountPath: z.string().optional(),
  organizations: z
    .object({
      enabled: z.boolean().default(true),
      invitationTtlSeconds: z.number().int().positive().optional(),
      defaultMemberRole: memberRoleSchema.optional(),
    })
    .optional(),
  groups: z
    .object({
      managementRoutes: z
        .union([
          z.literal(true),
          z.object({
            adminRole: z.string().optional(),
          }),
        ])
        .optional(),
    })
    .optional(),
});

/**
 * JSON-safe organizations plugin configuration.
 */
export type OrganizationsPluginConfig = z.infer<typeof organizationsPluginConfigSchema>;

function joinMountPath(mountPath: string, routePath: string): string {
  const normalizedMountPath =
    mountPath.length === 0 ? '' : mountPath.startsWith('/') ? mountPath : `/${mountPath}`;
  const normalizedRoutePath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${normalizedMountPath}${normalizedRoutePath}`;
}

function composeAuthenticatedGuard(
  userAuthMiddleware: MiddlewareHandler,
  guard: MiddlewareHandler,
): MiddlewareHandler {
  return async (c, next) => {
    let guardResponse: Response | undefined;
    await userAuthMiddleware(c, async () => {
      const result = await guard(c, next);
      guardResponse = result === undefined ? undefined : result;
    });
    return guardResponse;
  };
}

/**
 * Create the organizations plugin using the manifest-driven entity system.
 */
export function createOrganizationsPlugin(
  rawConfig: OrganizationsPluginConfig = {},
): SlingshotPlugin {
  const config = deepFreeze(
    validatePluginConfig('slingshot-organizations', rawConfig, organizationsPluginConfigSchema),
  );
  const organizationsEnabled = config.organizations?.enabled ?? true;
  const groupsEnabled = config.groups?.managementRoutes !== undefined;
  const groupAdminRole =
    config.groups?.managementRoutes && config.groups.managementRoutes !== true
      ? (config.groups.managementRoutes.adminRole ?? 'admin')
      : 'admin';
  const mountPath = config.mountPath ?? '';
  const tenantExemptPaths = [
    joinMountPath(mountPath, '/orgs'),
    `${joinMountPath(mountPath, '/orgs')}/*`,
    joinMountPath(mountPath, '/groups'),
    `${joinMountPath(mountPath, '/groups')}/*`,
  ];

  let innerPlugin: ReturnType<typeof createEntityPlugin> | undefined;
  let orgAdapterRef:
    | {
        create(input: Record<string, unknown>): Promise<{ id: string }>;
        list(opts: { filter?: Record<string, unknown>; limit?: number }): Promise<{
          items: ReadonlyArray<Record<string, unknown>>;
        }>;
      }
    | undefined;
  let memberAdapterRef:
    | {
        create(input: Record<string, unknown>): Promise<unknown>;
      }
    | undefined;

  return {
    name: 'slingshot-organizations',
    dependencies: ['slingshot-auth'],
    tenantExemptPaths,

    async setupMiddleware(ctx: PluginSetupContext) {
      const manifest = structuredClone(organizationsManifest);
      if (!organizationsEnabled) {
        delete manifest.entities.Organization;
        delete manifest.entities.OrganizationMember;
        delete manifest.entities.OrganizationInvite;
      }
      if (!groupsEnabled) {
        delete manifest.entities.Group;
        delete manifest.entities.GroupMembership;
      }

      const authRuntime = getOrganizationsAuthRuntime(getPluginStateOrNull(ctx.app));
      const routeAuth = getRouteAuthOrNull(ctx.app);
      if (!routeAuth) {
        throw new Error(
          '[slingshot-organizations] RouteAuthRegistry is not available. Ensure slingshot-auth setupMiddleware runs before slingshot-organizations.',
        );
      }
      innerPlugin = createEntityPlugin({
        name: 'slingshot-organizations',
        mountPath,
        manifest,
        manifestRuntime: createOrganizationsManifestRuntime({
          authRuntime,
          invitationTtlSeconds: config.organizations?.invitationTtlSeconds ?? 7 * 24 * 60 * 60,
          defaultMemberRole: config.organizations?.defaultMemberRole ?? 'member',
          onAdaptersCaptured(adapters) {
            orgAdapterRef = adapters.organizations as typeof orgAdapterRef;
            memberAdapterRef = adapters.members as typeof memberAdapterRef;
          },
        }),
        middleware: {
          inviteCreateDefaults: async (c, next) => {
            const setContextValue = c.set as (key: string, value: string) => void;
            setContextValue(
              'inviteExpiresAt',
              new Date(
                Date.now() +
                  (config.organizations?.invitationTtlSeconds ?? 7 * 24 * 60 * 60) * 1000,
              ).toISOString(),
            );
            await next();
          },
          organizationsAdminGuard: composeAuthenticatedGuard(
            routeAuth.userAuth,
            routeAuth.requireRole('admin'),
          ),
          groupsAdminGuard: composeAuthenticatedGuard(
            routeAuth.userAuth,
            routeAuth.requireRole(groupAdminRole),
          ),
        },
      });
      await innerPlugin.setupMiddleware?.(ctx);
    },

    async setupRoutes(ctx: PluginSetupContext) {
      await innerPlugin?.setupRoutes?.(ctx);
    },

    async setupPost(ctx: PluginSetupContext) {
      await innerPlugin?.setupPost?.(ctx);
      if (!orgAdapterRef || !memberAdapterRef) {
        return;
      }
      const orgAdapter = orgAdapterRef;
      const memberAdapter = memberAdapterRef;

      const orgService: OrganizationsOrgService = {
        async getOrgBySlug(slug) {
          const page = await orgAdapter.list({
            filter: { slug },
            limit: 1,
          });
          const org = page.items[0];
          return org && typeof org.id === 'string' ? { id: org.id } : null;
        },
        async createOrg(data) {
          const created = await orgAdapter.create({
            name: data.name,
            slug: data.slug,
            ...(data.tenantId !== undefined ? { tenantId: data.tenantId } : {}),
            ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
          });
          return { id: created.id };
        },
        async addOrgMember(orgId, userId, roles, invitedBy) {
          const role = roles?.find(
            (candidate): candidate is 'owner' | 'admin' | 'member' =>
              candidate === 'owner' || candidate === 'admin' || candidate === 'member',
          );
          return memberAdapter.create({
            orgId,
            userId,
            role: role ?? config.organizations?.defaultMemberRole ?? 'member',
            ...(invitedBy ? { invitedBy } : {}),
          });
        },
      };

      getPluginState(ctx.app).set(ORGANIZATIONS_ORG_SERVICE_STATE_KEY, orgService);
    },

    async teardown() {
      await innerPlugin?.teardown?.();
    },
  };
}
