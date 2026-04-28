import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type {
  PluginSeedContext,
  PluginSetupContext,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  getPluginState,
  getPluginStateOrNull,
  getRouteAuthOrNull,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import { getOrganizationsAuthRuntime } from './lib/authRuntime';
import {
  type OrganizationsRateLimitStore,
  createMemoryOrganizationsRateLimitStore,
} from './lib/rateLimit';
import { DEFAULT_RESERVED_ORG_SLUGS, createOrgSlugSchema } from './lib/slugValidation';
import { organizationsManifest } from './manifest/organizationsManifest';
import { createOrganizationsManifestRuntime } from './manifest/runtime';
import { ORGANIZATIONS_ORG_SERVICE_STATE_KEY, type OrganizationsOrgService } from './orgService';

const memberRoleSchema = z.string().min(1);

const DEFAULT_KNOWN_ROLES = ['owner', 'admin', 'member'] as const;

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error("mountPath must start with '/'");
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error("mountPath must not be '/'");
  }

  return normalized;
}

const inviteRateLimitSchema = z
  .object({
    create: z
      .object({
        limit: z.number().int().positive().default(10),
        windowMs: z.number().int().positive().default(60_000),
      })
      .partial()
      .optional(),
    lookup: z
      .object({
        limit: z.number().int().positive().default(30),
        windowMs: z.number().int().positive().default(60_000),
      })
      .partial()
      .optional(),
  })
  .optional();

const organizationsPluginConfigSchema = z.object({
  mountPath: z
    .string()
    .transform(value => normalizeMountPath(value))
    .optional()
    .describe(
      "URL path prefix for organization routes. Must start with '/'. Trailing slashes are trimmed. Omit to mount routes at the app root.",
    ),
  organizations: z
    .object({
      enabled: z.boolean().default(true),
      invitationTtlSeconds: z.number().int().positive().optional(),
      defaultMemberRole: memberRoleSchema.optional(),
      knownRoles: z
        .array(z.string().min(1))
        .nonempty()
        .optional()
        .describe(
          "Allowed values for member, invite, and group-membership 'role' fields. " +
            "Roles outside this list are rejected with a 400. Defaults to ['owner', 'admin', 'member'].",
        ),
      reservedSlugs: z
        .array(z.string())
        .optional()
        .describe(
          'List of reserved slug values that organizations cannot use. Defaults to a small set of common conflict-prone words.',
        ),
      inviteRateLimit: inviteRateLimitSchema.describe(
        'Sliding-window rate limits for invitation create + lookup endpoints.',
      ),
    })
    .refine(
      value => {
        const known: ReadonlyArray<string> = value.knownRoles ?? DEFAULT_KNOWN_ROLES;
        const defaultRole = value.defaultMemberRole ?? 'member';
        return known.includes(defaultRole);
      },
      {
        message: 'organizations.defaultMemberRole must be present in organizations.knownRoles',
        path: ['defaultMemberRole'],
      },
    )
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
 * Optional non-JSON dependencies the organizations plugin accepts at construction time.
 *
 * These cannot be expressed in the manifest and so are passed via the second
 * argument of `createOrganizationsPlugin()`.
 */
export interface OrganizationsPluginDeps {
  /**
   * Backing store for the invitation rate-limit middleware.
   *
   * Defaults to a process-local in-memory store. Provide a Redis-backed
   * implementation in production for shared rate limiting.
   */
  rateLimitStore?: OrganizationsRateLimitStore;
}

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
    const authResponse = await userAuthMiddleware(c, async () => {});
    if (authResponse) {
      return authResponse;
    }
    return guard(c, next);
  };
}

function getActorId(c: Parameters<MiddlewareHandler>[0]): string | null {
  const actor = c.get('actor' as never) as { id?: unknown } | undefined;
  if (!actor || typeof actor.id !== 'string' || actor.id.length === 0) return null;
  return actor.id;
}

function getClientIp(c: Parameters<MiddlewareHandler>[0]): string {
  const fwd = c.req.header('x-forwarded-for');
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? 'unknown';
  }
  return c.req.header('x-real-ip') ?? c.req.header('cf-connecting-ip') ?? 'unknown';
}

function rateLimitResponse(c: Parameters<MiddlewareHandler>[0], retryAfterMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return c.json({ error: 'Too Many Requests' }, 429, {
    'retry-after': String(retryAfterSeconds),
  });
}

function createInviteCreateRateLimit(args: {
  store: OrganizationsRateLimitStore;
  limit: number;
  windowMs: number;
}): MiddlewareHandler {
  return async (c, next) => {
    const orgId = c.req.param('orgId') ?? 'unknown';
    const actorId = getActorId(c) ?? `anon:${getClientIp(c)}`;
    const key = `invite-create:${orgId}:${actorId}`;
    const decision = await args.store.hit(key, args.limit, args.windowMs);
    if (!decision.allowed) {
      return rateLimitResponse(c, decision.retryAfterMs);
    }
    return next();
  };
}

function createInviteLookupRateLimit(args: {
  store: OrganizationsRateLimitStore;
  limit: number;
  windowMs: number;
}): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c);
    const key = `invite-lookup:${ip}`;
    const decision = await args.store.hit(key, args.limit, args.windowMs);
    if (!decision.allowed) {
      return rateLimitResponse(c, decision.retryAfterMs);
    }
    return next();
  };
}

/**
 * Create the organizations plugin using the manifest-driven entity system.
 */
export function createOrganizationsPlugin(
  rawConfig: OrganizationsPluginConfig = {},
  deps: OrganizationsPluginDeps = {},
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

  const reservedSlugs = config.organizations?.reservedSlugs ?? DEFAULT_RESERVED_ORG_SLUGS;
  const orgSlugSchema = createOrgSlugSchema(reservedSlugs);

  const rateLimitStore = deps.rateLimitStore ?? createMemoryOrganizationsRateLimitStore();
  const inviteCreateLimit = config.organizations?.inviteRateLimit?.create?.limit ?? 10;
  const inviteCreateWindow = config.organizations?.inviteRateLimit?.create?.windowMs ?? 60_000;
  const inviteLookupLimit = config.organizations?.inviteRateLimit?.lookup?.limit ?? 30;
  const inviteLookupWindow = config.organizations?.inviteRateLimit?.lookup?.windowMs ?? 60_000;

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
      const invitationTtlSeconds = config.organizations?.invitationTtlSeconds ?? 7 * 24 * 60 * 60;
      innerPlugin = createEntityPlugin({
        name: 'slingshot-organizations',
        mountPath,
        manifest,
        manifestRuntime: createOrganizationsManifestRuntime({
          authRuntime,
          invitationTtlSeconds,
          defaultMemberRole: config.organizations?.defaultMemberRole ?? 'member',
          knownRoles: config.organizations?.knownRoles ?? [...DEFAULT_KNOWN_ROLES],
          slugSchema: orgSlugSchema,
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
              new Date(Date.now() + invitationTtlSeconds * 1000).toISOString(),
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
          inviteCreateRateLimit: createInviteCreateRateLimit({
            store: rateLimitStore,
            limit: inviteCreateLimit,
            windowMs: inviteCreateWindow,
          }),
          inviteLookupRateLimit: createInviteLookupRateLimit({
            store: rateLimitStore,
            limit: inviteLookupLimit,
            windowMs: inviteLookupWindow,
          }),
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
        async getOrgBySlug(slug, tenantId) {
          const filter: Record<string, unknown> = { slug };
          if (tenantId !== undefined) filter.tenantId = tenantId;
          const page = await orgAdapter.list({ filter, limit: 1 });
          const org = page.items[0];
          return org && typeof org.id === 'string' ? { id: org.id } : null;
        },
        async createOrg(data) {
          const validatedSlug = orgSlugSchema.parse(data.slug);
          const created = await orgAdapter.create({
            name: data.name,
            slug: validatedSlug,
            ...(data.tenantId !== undefined ? { tenantId: data.tenantId } : {}),
            ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
          });
          return { id: created.id };
        },
        async addOrgMember(orgId, userId, roles, invitedBy) {
          const knownRoles = config.organizations?.knownRoles ?? [...DEFAULT_KNOWN_ROLES];
          const role = roles?.find(
            (candidate): candidate is string =>
              typeof candidate === 'string' && knownRoles.includes(candidate),
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

    async seed({ app, manifestSeed, seedState }: PluginSeedContext) {
      const orgService = getPluginState(app).get(ORGANIZATIONS_ORG_SERVICE_STATE_KEY) as
        | OrganizationsOrgService
        | undefined;
      if (!orgService) return;

      type SeedOrg = {
        name: string;
        slug: string;
        tenantId?: string;
        metadata?: Record<string, unknown>;
        members?: ReadonlyArray<{ email: string; roles?: string[] }>;
      };
      const orgs = manifestSeed.orgs as ReadonlyArray<SeedOrg> | undefined;
      if (!orgs?.length) return;

      for (const seedOrg of orgs) {
        const existing = await orgService.getOrgBySlug(seedOrg.slug, seedOrg.tenantId);
        if (existing) {
          console.log(
            `[slingshot-organizations seed] Org '${seedOrg.slug}' already exists — skipping.`,
          );
          continue;
        }

        const org = await orgService.createOrg({
          name: seedOrg.name,
          slug: seedOrg.slug,
          tenantId: seedOrg.tenantId,
          metadata: seedOrg.metadata,
        });
        console.log(
          `[slingshot-organizations seed] Created org '${seedOrg.slug}' (id: ${org.id}).`,
        );

        for (const member of seedOrg.members ?? []) {
          const userId = seedState.get(`user:${member.email}`) as string | undefined;
          if (!userId) {
            console.warn(
              `[slingshot-organizations seed] Member '${member.email}' for org '${seedOrg.slug}' not found in seedState — skipping.`,
            );
            continue;
          }
          await orgService.addOrgMember(org.id, userId, member.roles ?? [], 'manifest-seed');
          console.log(
            `[slingshot-organizations seed] Added '${member.email}' to org '${seedOrg.slug}'.`,
          );
        }
      }
    },

    async teardown() {
      await innerPlugin?.teardown?.();
    },
  };
}
