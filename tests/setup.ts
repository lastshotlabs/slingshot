import { registerAdminResourceTypes } from '@lastshotlabs/slingshot-admin';
import { createAuthPlugin, createMemoryAuthAdapter } from '@lastshotlabs/slingshot-auth';
import type { AuthPluginConfig } from '@lastshotlabs/slingshot-auth';
import { getAuthRuntimeFromRequest } from '@lastshotlabs/slingshot-auth';
import { createCommunityPlugin } from '@lastshotlabs/slingshot-community';
import type { CommunityPluginConfig } from '@lastshotlabs/slingshot-community';
import type { PluginSetupContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { PERMISSIONS_STATE_KEY, getContext } from '@lastshotlabs/slingshot-core';
import { createNotificationsPlugin } from '@lastshotlabs/slingshot-notifications';
import { createOAuthPlugin } from '@lastshotlabs/slingshot-oauth';
import {
  createMemoryPermissionsAdapter,
  createPermissionEvaluator,
  createPermissionRegistry,
  seedSuperAdmin,
} from '@lastshotlabs/slingshot-permissions';
import { createApp } from '../src/app';
import type { CreateAppConfig } from '../src/app';
import { createSlingshotAdminPlugin } from '../src/framework/admin';
import type { SlingshotAdminPluginConfig } from '../src/framework/admin';
import './setup-openapi';

// Preloaded by bunfig.toml — runs before any test module initialization.
// NOTE: process.env values are only set for non-secret config (NODE_ENV, logging).
// Secrets (JWT_SECRET, BEARER_TOKEN) are provided via SecretRepository / signing config
// to avoid singleton pollution between tests.
process.env.JWT_SECRET = 'test-secret-key-must-be-at-least-32-chars!!';
process.env.BEARER_TOKEN = 'test-bearer-token';
process.env.NODE_ENV = 'development';
process.env.LOGGING_VERBOSE = 'true';

export { createMemoryAuthAdapter };
export { seedSuperAdmin };

// ---------------------------------------------------------------------------
// Fresh fixtures per call — no shared module-scope state
// ---------------------------------------------------------------------------

export function createTestPermissions() {
  const adapter = createMemoryPermissionsAdapter();
  const registry = createPermissionRegistry();
  registerAdminResourceTypes(registry);
  // Community resource types are registered by createCommunityPlugin() via
  // entity config during setupPost -- no pre-registration needed.
  const evaluator = createPermissionEvaluator({ registry, adapter });
  return { evaluator, registry, adapter };
}

export function adminPlugin(overrides: Partial<SlingshotAdminPluginConfig> = {}): SlingshotPlugin {
  return createSlingshotAdminPlugin({ permissions: createTestPermissions(), ...overrides });
}

export function authPlugin(overrides: Partial<AuthPluginConfig> = {}): SlingshotPlugin {
  const { auth, db, security, ...restOverrides } = overrides;
  const adapter =
    auth?.adapter ??
    (db?.auth === undefined || db.auth === 'memory' ? createMemoryAuthAdapter() : undefined);
  const authConfig: NonNullable<AuthPluginConfig['auth']> = {
    roles: ['admin', 'user'],
    defaultRole: 'user',
    jwt: {
      issuer: 'http://localhost',
      audience: 'slingshot-tests',
      ...auth?.jwt,
    },
    rateLimit: {
      register: { windowMs: 60_000, max: 1000 },
      login: { windowMs: 60_000, max: 1000 },
      forgotPassword: { windowMs: 60_000, max: 1000 },
      resetPassword: { windowMs: 60_000, max: 1000 },
      verifyEmail: { windowMs: 60_000, max: 1000 },
      resendVerification: { windowMs: 60_000, max: 1000 },
      mfaVerify: { windowMs: 60_000, max: 1000 },
      mfaEmailOtpInitiate: { windowMs: 60_000, max: 1000 },
      mfaResend: { windowMs: 60_000, max: 1000 },
      setPassword: { windowMs: 60_000, max: 1000 },
      mfaDisable: { windowMs: 60_000, max: 1000 },
      oauthUnlink: { windowMs: 60_000, max: 1000 },
      deleteAccount: { windowMs: 60_000, max: 1000 },
      ...auth?.rateLimit,
    },
    ...auth,
  };
  if (adapter !== undefined) {
    authConfig.adapter = adapter;
  }
  return createAuthPlugin({
    auth: authConfig,
    db: {
      sessions: 'memory',
      oauthState: 'memory',
      ...db,
    },
    security: {
      bearerAuth: false,
      ...security,
    },
    ...restOverrides,
  });
}

const baseConfig: CreateAppConfig = {
  routesDir: import.meta.dir + '/fixtures/routes',
  meta: { name: 'Test App' },
  db: {
    mongo: false,
    redis: false,
    sessions: 'memory',
    cache: 'memory',
    auth: 'memory',
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false,
    },
  },
  logging: {
    onLog: () => {},
    verbose: false,
    auditWarnings: false,
  },
};

export async function createTestApp(
  overrides?: Partial<CreateAppConfig>,
  authOverrides?: Partial<AuthPluginConfig>,
) {
  const mergedDb = { ...baseConfig.db, ...overrides?.db };
  const explicitAuthAdapter = authOverrides?.auth?.adapter !== undefined;
  const inheritedAuthDb = explicitAuthAdapter
    ? {
        sqlite: mergedDb.sqlite,
        mongo: mergedDb.mongo,
        redis: mergedDb.redis,
        postgres: mergedDb.postgres,
        auth: 'memory' as const,
        sessions: 'memory' as const,
        oauthState: 'memory' as const,
      }
    : {
        sqlite: mergedDb.sqlite,
        mongo: mergedDb.mongo,
        redis: mergedDb.redis,
        postgres: mergedDb.postgres,
        sessions: mergedDb.sessions,
        auth: mergedDb.auth,
      };
  const oauthPlugin = authOverrides?.auth?.oauth?.providers != null ? [createOAuthPlugin()] : [];
  const mergedAuthOverrides: Partial<AuthPluginConfig> = {
    ...authOverrides,
    db: {
      ...inheritedAuthDb,
      ...authOverrides?.db,
    },
  };
  const config: CreateAppConfig = {
    ...baseConfig,
    ...overrides,
    meta: { ...baseConfig.meta, ...overrides?.meta },
    db: mergedDb,
    security: { ...baseConfig.security, ...overrides?.security },
    logging: { ...baseConfig.logging, ...overrides?.logging },
    plugins: [authPlugin(mergedAuthOverrides), ...oauthPlugin, ...(overrides?.plugins ?? [])],
  };
  const { app, ctx } = await createApp(config);
  (app as any).ctx = ctx;
  return app;
}

export function authHeader(token: string): Record<string, string> {
  return { 'x-user-token': token };
}

// ---------------------------------------------------------------------------
// Community plugin helpers
// ---------------------------------------------------------------------------

export function communityPlugin(overrides: Partial<CommunityPluginConfig> = {}): SlingshotPlugin {
  const permissionsState = createTestPermissions();
  const plugin = createCommunityPlugin({
    containerCreation: 'admin',
    ...overrides,
  });

  return {
    ...plugin,
    dependencies: ['slingshot-auth', 'slingshot-notifications'],
    async setupMiddleware(ctx: PluginSetupContext) {
      getContext(ctx.app).pluginState.set(PERMISSIONS_STATE_KEY, permissionsState);
      await plugin.setupMiddleware?.(ctx);
    },
  };
}

export function notificationsPlugin(): SlingshotPlugin {
  return createNotificationsPlugin({
    dispatcher: { enabled: false, intervalMs: 30_000, maxPerTick: 500 },
  });
}

/**
 * Middleware that bridges the slingshot-auth identity context (authUserId + roles)
 * to the communityPrincipal context variable expected by community routes.
 * Must be registered after identify runs.
 */
export const communityAuthBridge = async (c: any, next: () => Promise<void>) => {
  const userId = c.get('authUserId');
  if (userId) {
    let roles: string[] = c.get('roles') ?? [];
    if (!roles.length) {
      try {
        const adapter = getAuthRuntimeFromRequest(c).adapter;
        roles = adapter.getEffectiveRoles ? await adapter.getEffectiveRoles(userId, null) : [];
      } catch {
        roles = [];
      }
    }
    c.set('communityPrincipal', { subject: userId, roles });
  }
  await next();
};
