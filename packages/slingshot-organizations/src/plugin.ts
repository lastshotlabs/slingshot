import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getContextOrNull,
  getRouteAuthOrNull,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import { getOrganizationsAuthRuntime } from './lib/authRuntime';
import { organizationsManifest } from './manifest/organizationsManifest';
import { createOrganizationsManifestRuntime } from './manifest/runtime';

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

      const slingshotCtx = getContextOrNull(ctx.app);
      const authRuntime = getOrganizationsAuthRuntime(slingshotCtx?.pluginState);
      const routeAuth = slingshotCtx ? getRouteAuthOrNull(slingshotCtx) : null;
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
    },

    async teardown() {
      await innerPlugin?.teardown?.();
    },
  };
}
