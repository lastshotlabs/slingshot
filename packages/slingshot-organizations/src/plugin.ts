/**
 * Organizations package factory.
 *
 * Creates a `SlingshotPackageDefinition` that mounts the Organization,
 * OrganizationMember, OrganizationInvite, Group, and GroupMembership entities
 * (conditionally enabled by config), wires the invite rate-limit middleware
 * and admin-role guards, and publishes the org service + reconcile service
 * for cross-package consumers.
 *
 * Every adapter ref, middleware closure, and rate-limit backend is owned by
 * the factory's closure (Rule 3) — multiple package instances in the same
 * process do not share state.
 */
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type {
  PluginSeedContext,
  PluginSetupContext,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  assertMountPath,
  createConsoleLogger,
  deepFreeze,
  definePackage,
  getActorId,
  getPluginState,
  getPluginStateOrNull,
  getRouteAuthOrNull,
  provideCapability,
  publishPluginState,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { Logger } from '@lastshotlabs/slingshot-core';
import {
  type BuildOrganizationsEntityModulesArgs,
  buildOrganizationsEntityModules,
} from './entities/modules';
import { type OrganizationsAdapterRefs, reconcileOrphanedOrgRecords } from './entities/runtime';
import { getOrganizationsAuthRuntime } from './lib/authRuntime';
import {
  type OrganizationsRateLimitStore,
  createMemoryOrganizationsRateLimitStore,
} from './lib/rateLimit';
import { DEFAULT_RESERVED_ORG_SLUGS, createOrgSlugSchema } from './lib/slugValidation';
import { type OrganizationsOrgService, getOrganizationsOrgServiceOrNull } from './orgService';
import { OrganizationsOrgServiceCap } from './public';
import { ORGANIZATIONS_RECONCILE_STATE_KEY, type OrganizationsReconcileService } from './reconcile';

const memberRoleSchema = z.string().min(1);

const DEFAULT_KNOWN_ROLES = ['owner', 'admin', 'member'] as const;

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  assertMountPath('slingshot-organizations', trimmed);
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error("[slingshot-organizations] mountPath must not be '/'");
  }
  return normalized;
}

const inviteRateLimitSchema = z
  .object({
    create: z
      .object({
        limit: z
          .number()
          .int()
          .positive()
          .default(10)
          .describe('Maximum invitation-create requests per window. Default 10.'),
        windowMs: z
          .number()
          .int()
          .positive()
          .default(60_000)
          .describe(
            'Sliding window duration in milliseconds for create rate limiting. Default 60000.',
          ),
      })
      .partial()
      .optional()
      .describe('Rate limit for invitation creation endpoints.'),
    lookup: z
      .object({
        limit: z
          .number()
          .int()
          .positive()
          .default(30)
          .describe('Maximum invitation-lookup requests per window. Default 30.'),
        windowMs: z
          .number()
          .int()
          .positive()
          .default(60_000)
          .describe(
            'Sliding window duration in milliseconds for lookup rate limiting. Default 60000.',
          ),
      })
      .partial()
      .optional()
      .describe('Rate limit for invitation lookup endpoints.'),
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
      enabled: z
        .boolean()
        .default(true)
        .describe('Enable the organizations entity and its routes. Default true.'),
      invitationTtlSeconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Lifetime of an organization invitation in seconds before it expires. ' +
            'Defaults to 7 days (604800).',
        ),
      defaultMemberRole: memberRoleSchema
        .optional()
        .describe(
          "Role assigned to new members when no explicit role is provided. Must be present in 'knownRoles'. Defaults to 'member'.",
        ),
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
    .optional()
    .describe('Organization entity settings: invitations, roles, and slug rules.'),
  groups: z
    .object({
      managementRoutes: z
        .union([
          z.literal(true),
          z.object({
            adminRole: z
              .string()
              .optional()
              .describe("Role required to access group management routes. Defaults to 'admin'."),
          }),
        ])
        .optional()
        .describe(
          "Enable group management HTTP routes. Pass true for defaults or an object with 'adminRole' to customize the required role.",
        ),
    })
    .optional()
    .describe('Group entity settings and management route configuration.'),
});

/**
 * Optional non-JSON dependencies the organizations package accepts at construction time.
 */
export interface OrganizationsPluginDeps {
  /**
   * Backing store for the invitation rate-limit middleware. Defaults to a
   * process-local in-memory store. Provide a Redis-backed implementation in
   * production for shared rate limiting.
   */
  rateLimitStore?: OrganizationsRateLimitStore;
}

/**
 * JSON-safe organizations package configuration.
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
    if (authResponse) return authResponse;
    return guard(c, next);
  };
}

function getClientIp(c: Parameters<MiddlewareHandler>[0]): string {
  const fwd = c.req.header('x-forwarded-for');
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? 'unknown';
  }
  return 'unknown';
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

const logger: Logger = createConsoleLogger({ base: { plugin: 'slingshot-organizations' } });

/**
 * Create the organizations package using the `definePackage` authoring path.
 *
 * The five organizations entities are mounted via the package's `entities: [...]`
 * declaration; their adapters are wrapped with per-entity transforms (slug
 * validation, cascade-delete, scoped membership ids, invite token lifecycle)
 * inside each entity module's `wiring.buildAdapter` callback. The package
 * factory captures the resolved adapters in a shared
 * {@link OrganizationsAdapterRefs} bag so the custom-op handlers, the org
 * service, and the reconcile service all use the same instance per entity.
 */
export function createOrganizationsPackage(
  rawConfig: OrganizationsPluginConfig = {},
  deps: OrganizationsPluginDeps = {},
): SlingshotPackageDefinition {
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
  const knownRoles = config.organizations?.knownRoles ?? [...DEFAULT_KNOWN_ROLES];
  const defaultMemberRole = config.organizations?.defaultMemberRole ?? 'member';
  const invitationTtlSeconds = config.organizations?.invitationTtlSeconds ?? 7 * 24 * 60 * 60;

  // Closure-owned adapter refs populated by the entity modules' `wiring.buildAdapter`
  // callbacks during bootstrap. Custom-op handlers, the org service, and the
  // reconcile service all read through these refs.
  const refs: OrganizationsAdapterRefs = {};

  const rateLimitStore = deps.rateLimitStore ?? createMemoryOrganizationsRateLimitStore();
  if (
    !deps.rateLimitStore &&
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV === 'production'
  ) {
    logger.warn(
      '[slingshot-organizations] No rateLimitStore configured — using in-memory store. ' +
        'Rate-limit state will not be shared across instances. Provide a Redis-backed ' +
        'store via deps.rateLimitStore for multi-instance production deployments.',
    );
  }
  const inviteCreateLimit = config.organizations?.inviteRateLimit?.create?.limit ?? 10;
  const inviteCreateWindow = config.organizations?.inviteRateLimit?.create?.windowMs ?? 60_000;
  const inviteLookupLimit = config.organizations?.inviteRateLimit?.lookup?.limit ?? 30;
  const inviteLookupWindow = config.organizations?.inviteRateLimit?.lookup?.windowMs ?? 60_000;

  // Auth-runtime-derived guards are resolved during `setupMiddleware`. The
  // framework copies the middleware bundle at entity-plugin construction
  // time (`{ ...pkg.middleware }`), so each entry must close over a mutable
  // ref the framework re-reads at request time. The thunks below do exactly
  // that — the entity plugin captures the thunk reference, and the thunk
  // delegates to the resolved guard once `setupMiddleware` populates it.
  const orgAdminGuardRef: { current: MiddlewareHandler } = {
    current: async (_c, next) => next(),
  };
  const groupAdminGuardRef: { current: MiddlewareHandler } = {
    current: async (_c, next) => next(),
  };

  const middleware: Record<string, MiddlewareHandler> = {
    inviteCreateDefaults: async (c, next) => {
      const setContextValue = c.set as (key: string, value: string) => void;
      setContextValue(
        'inviteExpiresAt',
        new Date(Date.now() + invitationTtlSeconds * 1000).toISOString(),
      );
      await next();
    },
    organizationsAdminGuard: (c, next) => orgAdminGuardRef.current(c, next),
    groupsAdminGuard: (c, next) => groupAdminGuardRef.current(c, next),
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
  };

  // Resolve auth-runtime-derived middleware. The entity routes capture the
  // thunk above at boot; this just swaps the inner handler in place.
  function resolveAuthGuards(ctx: PluginSetupContext): void {
    const routeAuth = getRouteAuthOrNull(ctx.app);
    if (!routeAuth) {
      throw new Error(
        '[slingshot-organizations] RouteAuthRegistry is not available. Ensure slingshot-auth setupMiddleware runs before slingshot-organizations.',
      );
    }
    orgAdminGuardRef.current = composeAuthenticatedGuard(
      routeAuth.userAuth,
      routeAuth.requireRole('admin'),
    );
    groupAdminGuardRef.current = composeAuthenticatedGuard(
      routeAuth.userAuth,
      routeAuth.requireRole(groupAdminRole),
    );
  }

  // Build the entity modules eagerly so the framework can declare them on
  // `definePackage({ entities })`. The auth runtime isn't resolvable yet (it
  // lives on the framework context that's wired during `setupMiddleware`),
  // so we expose a delegating Proxy whose targets are filled in at
  // `setupMiddleware` time. Routes never run before `setupMiddleware`
  // completes, so the redeem handler always sees a resolved runtime by the
  // time it dereferences `authRuntime.adapter.*` at request time.
  const authRuntimeRef: { current?: BuildOrganizationsEntityModulesArgs['authRuntime'] } = {};
  const emptyTarget = Object.create(null) as BuildOrganizationsEntityModulesArgs['authRuntime'];
  const authRuntimeProxy = new Proxy(emptyTarget, {
    get(_target, prop) {
      if (!authRuntimeRef.current) {
        throw new Error(
          '[slingshot-organizations] auth runtime accessed before setupMiddleware resolved it',
        );
      }
      return Reflect.get(authRuntimeRef.current as object, prop);
    },
  });

  const {
    organizationModule,
    organizationMemberModule,
    organizationInviteModule,
    groupModule,
    groupMembershipModule,
  } = buildOrganizationsEntityModules({
    refs,
    invitationTtlSeconds,
    defaultMemberRole,
    knownRoles,
    slugSchema: orgSlugSchema,
    authRuntime: authRuntimeProxy,
    organizationsEnabled,
    groupsEnabled,
  });

  const entities = [
    organizationModule,
    organizationMemberModule,
    organizationInviteModule,
    groupModule,
    groupMembershipModule,
  ].filter((m): m is NonNullable<typeof m> => m !== null);

  // Build the org service once per package instance. The methods read
  // `refs.organizations` / `refs.members` lazily, so the service is safe to
  // construct before `setupMiddleware` populates the refs. The framework
  // calls `provider.resolve()` twice and republishes the cap slot each time;
  // returning the same reference from both calls keeps cross-phase identity
  // stable (===). `createOrgService` is a hoisted function declaration in
  // this same closure.
  const orgServiceView = createOrgService();

  return definePackage({
    name: 'slingshot-organizations',
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth'],
    entities,
    middleware,
    tenantExemptPaths,
    capabilities: {
      // Construct the org service once per package instance and return the
      // same reference from every resolve. The framework calls
      // `provider.resolve()` twice (setupMiddleware + setupPost) and
      // republishes the cap slot each time — returning a single stable
      // reference means consumers reading the cap at any lifecycle phase
      // observe `===` identity. The service methods read `refs.organizations`
      // / `refs.members` lazily, so deferring still works the same way.
      provides: [provideCapability(OrganizationsOrgServiceCap, () => orgServiceView)],
    },

    setupMiddleware(ctx: PluginSetupContext) {
      // Resolve auth runtime + route-auth so middleware closures point at the
      // real guards before any route is mounted in `setupRoutes`.
      authRuntimeRef.current = getOrganizationsAuthRuntime(getPluginStateOrNull(ctx.app));
      resolveAuthGuards(ctx);
    },

    setupPost(ctx: PluginSetupContext) {
      if (organizationsEnabled && (!refs.organizations || !refs.members)) {
        // The package's entities all use manual wiring and populate `refs`
        // inside `buildAdapter`. If we reach `setupPost` without them
        // populated, the entity routes never mounted — surface that as an
        // error rather than silently no-op.
        throw new Error(
          '[slingshot-organizations] organization adapters were not captured during entity setup',
        );
      }

      // Reconcile service for operator tooling (CLI, admin route). Published
      // through plugin state because it's a non-cross-package recovery hook
      // rather than a typed cross-package capability.
      const reconcileService: OrganizationsReconcileService = {
        reconcileOrphanedOrgRecords: orgId => reconcileOrphanedOrgRecords(refs, orgId),
      };
      publishPluginState(
        getPluginState(ctx.app),
        ORGANIZATIONS_RECONCILE_STATE_KEY,
        reconcileService,
      );
    },

    async seed({ app, seedInput, seedState }: PluginSeedContext) {
      const orgService = getOrganizationsOrgServiceOrNull(getPluginState(app));
      if (!orgService) return;

      type SeedOrg = {
        name: string;
        slug: string;
        tenantId?: string;
        metadata?: Record<string, unknown>;
        members?: ReadonlyArray<{ email: string; roles?: string[] }>;
      };
      const orgs = seedInput.orgs as ReadonlyArray<SeedOrg> | undefined;
      if (!orgs?.length) return;

      for (const seedOrg of orgs) {
        const existing = await orgService.getOrgBySlug(seedOrg.slug, seedOrg.tenantId);
        if (existing) {
          logger.info(
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
        logger.info(
          `[slingshot-organizations seed] Created org '${seedOrg.slug}' (id: ${org.id}).`,
        );

        for (const member of seedOrg.members ?? []) {
          const userId = seedState.get(`user:${member.email}`) as string | undefined;
          if (!userId) {
            logger.warn(
              `[slingshot-organizations seed] Member '${member.email}' for org '${seedOrg.slug}' not found in seedState — skipping.`,
            );
            continue;
          }
          await orgService.addOrgMember(org.id, userId, member.roles ?? [], 'seed');
          logger.info(
            `[slingshot-organizations seed] Added '${member.email}' to org '${seedOrg.slug}'.`,
          );
        }
      }
    },
  });

  /**
   * Build the org service from the captured adapters. Called from the
   * capability factory; safe to call multiple times — each invocation closes
   * over the same `refs` bag.
   */
  function createOrgService(): OrganizationsOrgService {
    return {
      async getOrgBySlug(slug, tenantId) {
        const orgAdapter = refs.organizations;
        if (!orgAdapter) {
          throw new Error(
            '[slingshot-organizations] orgService.getOrgBySlug called before adapters were captured',
          );
        }
        const filter: Record<string, unknown> = { slug };
        if (tenantId !== undefined) filter.tenantId = tenantId;
        const page = await orgAdapter.list({ filter, limit: 1 });
        const org = page.items[0] as { id?: unknown } | undefined;
        return org && typeof org.id === 'string' ? { id: org.id } : null;
      },
      async createOrg(data) {
        const orgAdapter = refs.organizations;
        if (!orgAdapter) {
          throw new Error(
            '[slingshot-organizations] orgService.createOrg called before adapters were captured',
          );
        }
        const validatedSlug = orgSlugSchema.parse(data.slug);
        const created = (await orgAdapter.create({
          name: data.name,
          slug: validatedSlug,
          ...(data.tenantId !== undefined ? { tenantId: data.tenantId } : {}),
          ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        })) as { id: string };
        return { id: created.id };
      },
      async addOrgMember(orgId, userId, roles, invitedBy) {
        const memberAdapter = refs.members;
        if (!memberAdapter) {
          throw new Error(
            '[slingshot-organizations] orgService.addOrgMember called before adapters were captured',
          );
        }
        const role = roles?.find(
          (candidate): candidate is string =>
            typeof candidate === 'string' && knownRoles.includes(candidate),
        );
        return memberAdapter.create({
          orgId,
          userId,
          role: role ?? defaultMemberRole,
          ...(invitedBy ? { invitedBy } : {}),
        });
      },
    };
  }
}
