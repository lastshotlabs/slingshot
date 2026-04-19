import type {
  EntityRouteDataScopeConfig,
  PolicyDecision,
  PolicyResolver,
} from './entityRouteConfig';
import { getAuthRuntimePeerOrNull } from './authPeer';
import { getEntityPolicyResolver } from './entityPolicy';
import type { EntityRuntimeAdapter } from './entityAdapter';
import { HandlerError, type AfterHook, IdempotencyCacheHit, type Guard } from './handler';
import { hmacSign, sha256 } from './crypto';
import { getPermissionsStateOrNull } from './permissions';
import { getRateLimitAdapter } from './rateLimit';

interface PermissionGuardOptions {
  ownerField?: string;
  or?: string;
  scope?: Record<string, string>;
  parentAuth?: { idParam: string; tenantField: string };
  adapter?: Pick<EntityRuntimeAdapter, 'getById'>;
  parentAdapter?: Pick<EntityRuntimeAdapter, 'getById'>;
}

interface IdempotencyState {
  cacheKey: string | null;
  fingerprint: string | null;
  ttl: number;
}

type AuthAdapterLike = {
  getSuspended?: (
    userId: string,
  ) => Promise<{ suspended: boolean; suspendedReason?: string } | null>;
  getEmailVerified?: (userId: string) => Promise<boolean | null | undefined>;
};

type AuthRuntimeLike = {
  adapter: AuthAdapterLike;
  config?: {
    primaryField?: string;
    emailVerification?: {
      required?: boolean;
    } | null;
  } | null;
};

function resolveDotPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveScopedValue(
  binding: string,
  input: Record<string, unknown>,
  record: Record<string, unknown> | null,
  meta: {
    tenantId: string | null;
    authUserId: string | null;
  },
): string | undefined {
  if (binding.startsWith('ctx:')) {
    const field = binding.slice(4);
    if (field === 'tenantId') return meta.tenantId ?? undefined;
    if (field === 'authUserId') return meta.authUserId ?? undefined;
    return undefined;
  }
  if (binding.startsWith('param:')) {
    const value = resolveDotPath(input, binding.slice(6));
    return value === undefined || value === null ? undefined : String(value);
  }
  if (binding.startsWith('body:')) {
    const value = resolveDotPath(input, binding.slice(5));
    return value === undefined || value === null ? undefined : String(value);
  }
  if (binding.startsWith('query:')) {
    const value = resolveDotPath(input, binding.slice(6));
    return value === undefined || value === null ? undefined : String(value);
  }
  if (binding.startsWith('record:')) {
    const value = resolveDotPath(record, binding.slice(7));
    return value === undefined || value === null ? undefined : String(value);
  }
  return binding;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function resolveEntityName(handlerName: string): string | null {
  const separator = handlerName.indexOf('.');
  return separator === -1 ? null : handlerName.slice(0, separator);
}

function resolveEntityAdapter(
  handlerName: string,
  ctxAdapters: Readonly<Record<string, EntityRuntimeAdapter>>,
): Pick<EntityRuntimeAdapter, 'getById'> | null {
  const entityName = resolveEntityName(handlerName);
  if (!entityName) return null;
  return ctxAdapters[entityName] ?? null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function derivePermissionSubject(meta: {
  authUserId: string | null;
  bearerClientId?: string | null;
  authClientId?: string | null;
}):
  | { subjectId: string; subjectType: 'user' | 'service-account' }
  | null {
  if (meta.authUserId) {
    return { subjectId: meta.authUserId, subjectType: 'user' };
  }
  const clientId = meta.bearerClientId ?? meta.authClientId ?? null;
  if (clientId) {
    return { subjectId: clientId, subjectType: 'service-account' };
  }
  return null;
}

function attachAuthMarker(guard: Guard, kind: 'userAuth' | 'bearer'): Guard {
  Object.defineProperty(guard, '_httpAuth', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: kind,
  });
  return guard;
}

/**
 * Require an authenticated user identity.
 */
export function requireAuth(): Guard {
  return async ({ meta }) => {
    if (!meta.authUserId) {
      throw new HandlerError('Unauthorized', { status: 401 });
    }
  };
}

/**
 * Require a full user-authenticated request and re-check account state.
 */
export function requireUserAuth(): Guard {
  const guard: Guard = async args => {
    await requireAuth()(args);

    const runtime = getAuthRuntimePeerOrNull(args.ctx.pluginState) as AuthRuntimeLike | null;
    if (!runtime?.adapter) {
      return;
    }

    const userId = args.meta.authUserId;
    if (!userId) {
      throw new HandlerError('Unauthorized', { status: 401 });
    }

    const suspension = runtime.adapter.getSuspended
      ? ((await runtime.adapter.getSuspended(userId)) ?? { suspended: false })
      : { suspended: false };
    if (suspension.suspended) {
      throw new HandlerError('Account suspended', { status: 403 });
    }

    const requiresVerifiedEmail =
      runtime.config?.primaryField === 'email' && runtime.config.emailVerification?.required === true;
    if (!requiresVerifiedEmail || !runtime.adapter.getEmailVerified) {
      return;
    }

    const verified = await runtime.adapter.getEmailVerified(userId);
    if (!verified) {
      throw new HandlerError('Email not verified', { status: 403 });
    }
  };

  return attachAuthMarker(guard, 'userAuth');
}

/**
 * Require a bearer-authenticated client identity.
 */
export function requireBearer(): Guard {
  const guard: Guard = async ({ meta }) => {
    if (!meta.bearerClientId && !meta.authClientId) {
      throw new HandlerError('Unauthorized', { status: 401 });
    }
  };

  return attachAuthMarker(guard, 'bearer');
}

/**
 * Require a resolved tenant.
 */
export function requireTenant(): Guard {
  return async ({ meta }) => {
    if (!meta.tenantId) {
      throw new HandlerError('Tenant required', { status: 400 });
    }
  };
}

/**
 * Enforce a permission check using the registered evaluator.
 */
export function requirePermission(action: string, opts: PermissionGuardOptions = {}): Guard {
  return async ({ ctx, meta, input, handlerName }) => {
    const permissions = getPermissionsStateOrNull(ctx.pluginState);
    if (!permissions) {
      throw new HandlerError('Permission evaluator not configured', { status: 500 });
    }

    const subject = derivePermissionSubject(meta);
    if (!subject) {
      throw new HandlerError('Forbidden', { status: 403 });
    }

    const inputRecord =
      input && typeof input === 'object' ? (input as Record<string, unknown>) : Object.create(null);
    const scopeFilter = normalizeRecord((inputRecord as { _scopeFilter?: unknown })._scopeFilter);
    const adapter =
      opts.adapter ??
      resolveEntityAdapter(handlerName, ctx.adapters) ??
      null;

    if (opts.parentAuth && opts.parentAdapter) {
      const parentId = resolveDotPath(inputRecord, opts.parentAuth.idParam);
      if (typeof parentId !== 'string' || parentId.length === 0) {
        throw new HandlerError('Not found', { status: 404 });
      }

      const parent = normalizeRecord(await opts.parentAdapter.getById(parentId));
      if (!parent || parent[opts.parentAuth.tenantField] !== meta.tenantId) {
        throw new HandlerError('Not found', { status: 404 });
      }
    }

    let record: Record<string, unknown> | null = null;
    const needsRecord =
      Boolean(opts.ownerField) ||
      Object.values(opts.scope ?? {}).some(binding => binding.startsWith('record:'));
    if (needsRecord && adapter) {
      const recordId = resolveDotPath(inputRecord, 'id');
      if (typeof recordId === 'string' && recordId.length > 0) {
        record = normalizeRecord(await adapter.getById(recordId, scopeFilter ?? undefined));
        if (!record) {
          throw new HandlerError('Not found', { status: 404 });
        }
      }
    }

    if (
      subject.subjectType === 'user' &&
      opts.ownerField &&
      record &&
      record[opts.ownerField] === subject.subjectId
    ) {
      return;
    }

    const scope: Record<string, string | undefined> = { tenantId: meta.tenantId ?? undefined };
    for (const [key, binding] of Object.entries(opts.scope ?? {})) {
      scope[key] = resolveScopedValue(binding, inputRecord, record, meta);
    }

    let allowed = await permissions.evaluator.can(subject, action, scope);
    if (!allowed && opts.or) {
      allowed = await permissions.evaluator.can(subject, opts.or, scope);
    }

    if (!allowed) {
      throw new HandlerError('Forbidden', { status: 403 });
    }
  };
}

/**
 * Enforce a rolling-window rate limit.
 */
export function rateLimit(config: { windowMs: number; max: number }): Guard {
  return async ({ ctx, meta, handlerName }) => {
    const adapter = getRateLimitAdapter(ctx);
    const key = meta.authUserId
      ? `handler:${handlerName}:user:${meta.authUserId}`
      : `handler:${handlerName}:ip:${meta.ip ?? 'unknown'}`;
    const exceeded = await adapter.trackAttempt(key, config);
    if (exceeded) {
      throw new HandlerError('Rate limited', {
        status: 429,
        details: { retryAfterMs: config.windowMs },
      });
    }
  };
}

/**
 * Enforce declarative data scopes.
 */
export function enforceDataScope(
  scopes: EntityRouteDataScopeConfig | readonly EntityRouteDataScopeConfig[],
  opts?: { op?: 'create' | 'list' | 'get' | 'update' | 'delete' },
): Guard {
  const normalized = Array.isArray(scopes) ? [...scopes] : [scopes];
  return async ({ input, meta }) => {
    if (!input || typeof input !== 'object') return;

    const inputRecord = input as Record<string, unknown>;
    const bindings: Record<string, unknown> = {};
    for (const scope of normalized) {
      const source = resolveScopedValue(scope.from, inputRecord, null, meta);
      if (source === undefined) {
        throw new HandlerError(`dataScope source '${scope.from}' not set on request context`, {
          status: 401,
        });
      }
      bindings[scope.field] = source;
    }

    if (opts?.op === 'create') {
      Object.assign(inputRecord, bindings);
      return;
    }

    if (opts?.op === 'list') {
      Object.assign(inputRecord, bindings);
      inputRecord._scopeFilter = bindings;
      return;
    }

    inputRecord._scopeFilter = bindings;
  };
}

/**
 * Prevent mutation of scoped fields during update operations.
 */
export function rejectScopedFields(fields: readonly string[]): Guard {
  return async ({ input }) => {
    if (!input || typeof input !== 'object') return;
    const record = input as Record<string, unknown>;
    for (const field of fields) {
      if (Object.hasOwn(record, field) && record[field] !== undefined) {
        throw new HandlerError('scoped_field_immutable', {
          status: 400,
          details: { field },
        });
      }
    }
  };
}

/**
 * Idempotency guard with an auto-paired cache after hook.
 */
export function idempotent(config?: {
  ttl?: number;
  scope?: 'user' | 'tenant' | 'global';
}): Guard {
  const state: IdempotencyState = {
    cacheKey: null,
    fingerprint: null,
    ttl: config?.ttl ?? 86400,
  };
  const scope = config?.scope ?? 'user';

  const guard: Guard = async ({ ctx, meta, input, handlerName }) => {
    const rawKey = meta.idempotencyKey;
    if (!rawKey) {
      state.cacheKey = null;
      state.fingerprint = null;
      return;
    }

    const signingSecret = ctx.signing?.idempotencyKeys ? ctx.signing.secret : undefined;
    const token = signingSecret ? hmacSign(rawKey, signingSecret) : rawKey;
    const parts = ['idempotency', handlerName];

    if (scope === 'user') {
      if (!meta.authUserId) {
        throw new HandlerError('Unauthorized', { status: 401 });
      }
      if (meta.tenantId) parts.push(`tenant:${meta.tenantId}`);
      parts.push(`user:${meta.authUserId}`);
    } else if (scope === 'tenant') {
      parts.push(`tenant:${meta.tenantId ?? 'none'}`);
    }

    parts.push(token);
    state.cacheKey = parts.join(':');
    state.fingerprint = sha256(stableStringify(input));

    const cached = await ctx.persistence.idempotency.get(state.cacheKey);
    if (!cached) {
      return;
    }
    if (cached.requestFingerprint && cached.requestFingerprint !== state.fingerprint) {
      throw new HandlerError('Idempotency-Key reuse with different request', {
        status: 409,
        code: 'idempotency_key_conflict',
      });
    }
    throw new IdempotencyCacheHit(JSON.parse(cached.response) as unknown);
  };

  const afterHook: AfterHook = async ({ ctx, output }) => {
    if (!state.cacheKey || !state.fingerprint) {
      return;
    }
    await ctx.persistence.idempotency.set(
      state.cacheKey,
      JSON.stringify(output),
      200,
      state.ttl,
      { requestFingerprint: state.fingerprint },
    );
  };

  Object.defineProperty(guard, '_afterHook', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: afterHook,
  });

  return guard;
}

function coercePolicyDecision(
  decision: boolean | PolicyDecision,
  leakSafe: boolean | undefined,
): PolicyDecision {
  if (typeof decision === 'boolean') {
    return { allow: decision, status: leakSafe ? 404 : 403 };
  }
  return {
    ...decision,
    ...(decision.allow ? {} : { status: decision.status ?? (leakSafe ? 404 : 403) }),
  };
}

/**
 * Pre-handler policy enforcement for operations that do not require a fetched record.
 */
export function enforcePolicy(config: {
  resolver: string;
  action: string;
  leakSafe?: boolean;
}): Guard {
  return async ({ ctx, meta, input }) => {
    const resolver = getEntityPolicyResolver(
      ctx.app as import('hono').Hono<import('./context').AppEnv>,
      config.resolver,
    ) as PolicyResolver<Record<string, unknown>, Record<string, unknown> | null> | undefined;
    if (!resolver) {
      throw new HandlerError(`Unknown policy resolver '${config.resolver}'`, { status: 500 });
    }
    if (!meta.authUserId) {
      throw new HandlerError('policy: authUserId missing at enforcement time (bad config)', {
        status: 500,
      });
    }

    const decision = coercePolicyDecision(
      await resolver({
        action:
          config.action.startsWith('operation:')
            ? { kind: 'operation', name: config.action.slice('operation:'.length) }
            : ({ kind: config.action } as
                | { kind: 'create' }
                | { kind: 'list' }
                | { kind: 'get' }
                | { kind: 'update' }
                | { kind: 'delete' }),
        userId: meta.authUserId,
        tenantId: meta.tenantId,
        record: null,
        input:
          input && typeof input === 'object' ? (input as Record<string, unknown>) : (null as null),
      }),
      config.leakSafe,
    );

    if (decision.allow) return;

    (ctx.bus as unknown as { emit(key: string, payload: unknown): void }).emit(
      'entity:policy.denied',
      {
        resolverKey: config.resolver,
        action: config.action,
        userId: meta.authUserId,
        reason: decision.reason,
      },
    );
    throw new HandlerError(decision.status === 404 ? 'Not found' : 'Forbidden', {
      status: decision.status,
    });
  };
}

/**
 * Post-fetch policy enforcement helper.
 */
export async function checkPolicy(
  ctx: import('./context/slingshotContext').SlingshotContext,
  meta: import('./handler').HandlerMeta,
  config: {
    resolver: string;
    action: string;
    record: Record<string, unknown>;
    input?: Record<string, unknown> | null;
    leakSafe?: boolean;
  },
): Promise<void> {
  const resolver = getEntityPolicyResolver(
    ctx.app as import('hono').Hono<import('./context').AppEnv>,
    config.resolver,
  ) as PolicyResolver<Record<string, unknown>, Record<string, unknown> | null> | undefined;
  if (!resolver) {
    throw new HandlerError(`Unknown policy resolver '${config.resolver}'`, { status: 500 });
  }
  if (!meta.authUserId) {
    throw new HandlerError('policy: authUserId missing at enforcement time (bad config)', {
      status: 500,
    });
  }

  const decision = coercePolicyDecision(
    await resolver({
      action:
        config.action.startsWith('operation:')
          ? { kind: 'operation', name: config.action.slice('operation:'.length) }
          : ({ kind: config.action } as
              | { kind: 'create' }
              | { kind: 'list' }
              | { kind: 'get' }
              | { kind: 'update' }
              | { kind: 'delete' }),
      userId: meta.authUserId,
      tenantId: meta.tenantId,
      record: config.record,
      input: config.input ?? null,
    }),
    config.leakSafe,
  );

  if (decision.allow) return;

  (ctx.bus as unknown as { emit(key: string, payload: unknown): void }).emit('entity:policy.denied', {
    resolverKey: config.resolver,
    action: config.action,
    userId: meta.authUserId,
    reason: decision.reason,
  });
  throw new HandlerError(decision.status === 404 ? 'Not found' : 'Forbidden', {
    status: decision.status,
  });
}
