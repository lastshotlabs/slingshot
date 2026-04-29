import { validateServerConfig } from './framework/config/schema';
import type { CreateServerConfig } from './server';

export type ProductionReadinessSeverity = 'error' | 'warning' | 'info';

export type ProductionReadinessCategory =
  | 'config'
  | 'security'
  | 'storage'
  | 'observability'
  | 'runtime'
  | 'realtime';

export interface ProductionReadinessFinding {
  id: string;
  severity: ProductionReadinessSeverity;
  category: ProductionReadinessCategory;
  message: string;
  fix?: string;
  docs?: string;
}

export interface ProductionReadinessReport {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: ProductionReadinessFinding[];
}

export interface ProductionReadinessAuditOptions {
  /**
   * Runtime environment to audit against. Defaults to process.env.NODE_ENV.
   */
  nodeEnv?: string;
  /**
   * Whether this config is intended to run behind more than one process or instance.
   * Defaults to true because production deploys usually scale horizontally.
   */
  multiInstance?: boolean;
  /**
   * Secret environment values to consider during checks. Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
  /**
   * Require explicit session binding when the auth plugin is detected.
   * Defaults to true to mirror slingshot-auth's production startup guard.
   */
  requireSessionBinding?: boolean;
}

export type ProductionReadinessConfig<T extends object = object> =
  | Partial<CreateServerConfig<T>>
  | Record<string, unknown>;

export class ProductionReadinessError extends Error {
  readonly report: ProductionReadinessReport;

  constructor(report: ProductionReadinessReport) {
    super(formatProductionReadinessFailure(report));
    this.name = 'ProductionReadinessError';
    this.report = report;
  }
}

type AuditConfig = ProductionReadinessConfig;
type UnknownRecord = Record<string, unknown>;
type StoreName = 'redis' | 'mongo' | 'sqlite' | 'memory' | 'postgres';

const PROD_READINESS_DOCS = '/slingshot/guides/production-readiness/';

export function auditProductionReadiness(
  config: AuditConfig,
  options: ProductionReadinessAuditOptions = {},
): ProductionReadinessReport {
  const env = options.env ?? process.env;
  const multiInstance = options.multiInstance ?? true;
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV;
  const findings: ProductionReadinessFinding[] = [];

  const add = (finding: ProductionReadinessFinding) => {
    findings.push({ docs: PROD_READINESS_DOCS, ...finding });
  };

  try {
    validateServerConfig(config as Record<string, unknown>, { isProd: true });
  } catch (error) {
    add({
      id: 'config.invalid',
      severity: 'error',
      category: 'config',
      message: error instanceof Error ? error.message : 'Config validation failed.',
      fix: 'Fix unknown keys and schema/type errors before deploying.',
    });
  }

  if (nodeEnv !== 'production') {
    add({
      id: 'runtime.node_env',
      severity: 'warning',
      category: 'runtime',
      message: 'NODE_ENV is not production for this audit.',
      fix: 'Run the app and CI production preflight with NODE_ENV=production.',
    });
  }

  auditSecurity(config, add, env, options);
  auditStorage(config, add);
  auditObservability(config, add);
  auditRuntime(config, add);
  auditRealtime(config, add, multiInstance);

  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;

  return {
    ok: errors === 0,
    errors,
    warnings,
    findings,
  };
}

export function assertProductionReadiness(
  config: AuditConfig,
  options?: ProductionReadinessAuditOptions,
): ProductionReadinessReport {
  const report = auditProductionReadiness(config, options);
  if (!report.ok) throw new ProductionReadinessError(report);
  return report;
}

function auditSecurity(
  config: AuditConfig,
  add: (finding: ProductionReadinessFinding) => void,
  env: Record<string, string | undefined>,
  options: ProductionReadinessAuditOptions,
): void {
  const security = asRecord(config.security);
  const cors = security ? security.cors : undefined;
  const corsOrigins = getCorsOrigins(cors);

  if (corsOrigins.includes('*')) {
    const credentials = asRecord(cors)?.credentials === true;
    add({
      id: credentials ? 'security.cors_wildcard_credentials' : 'security.cors_wildcard',
      severity: 'error',
      category: 'security',
      message: credentials
        ? 'CORS allows wildcard origin with credentials enabled.'
        : 'CORS allows wildcard origin in production.',
      fix: 'Set security.cors to the exact production origin allowlist.',
    });
  }

  if (!security || security.trustProxy === undefined) {
    add({
      id: 'security.trust_proxy_explicit',
      severity: 'error',
      category: 'security',
      message: 'security.trustProxy is not explicitly configured.',
      fix: 'Set security.trustProxy to the trusted proxy hop count, or false if there is no trusted proxy.',
    });
  }

  const signing = asRecord(security?.signing);
  if (signing && signingFeatureEnabled(signing)) {
    const secrets = signingSecrets(signing, env);
    if (secrets.length === 0) {
      add({
        id: 'security.signing_secret_missing',
        severity: 'error',
        category: 'security',
        message: 'At least one signing feature is enabled but no signing secret is available.',
        fix: 'Set security.signing.secret or provide JWT_SECRET through the production secret provider.',
      });
    }

    for (const [index, secret] of secrets.entries()) {
      if (secret.length < 32) {
        add({
          id: 'security.signing_secret_short',
          severity: 'error',
          category: 'security',
          message: `Signing secret ${index + 1} is shorter than 32 characters.`,
          fix: 'Use randomly generated signing secrets with at least 32 characters.',
        });
      }
    }
  }

  const sessionBinding = signing?.sessionBinding;
  const requireSessionBinding = options.requireSessionBinding ?? true;
  if (
    requireSessionBinding &&
    hasNamedPlugin(config, 'slingshot-auth') &&
    sessionBinding === undefined
  ) {
    add({
      id: 'security.session_binding_explicit',
      severity: 'error',
      category: 'security',
      message:
        'The auth plugin is present but security.signing.sessionBinding is not explicitly configured.',
      fix: 'Set security.signing.sessionBinding to a binding policy, or false to make the production opt-out explicit.',
    });
  } else if (sessionBinding === undefined) {
    add({
      id: 'security.session_binding_review',
      severity: 'warning',
      category: 'security',
      message: 'Session binding is not configured.',
      fix: 'Enable security.signing.sessionBinding for cookie/session applications, or document why this service is token-only.',
    });
  } else if (isRecord(sessionBinding) && sessionBinding.onMismatch === 'log-only') {
    add({
      id: 'security.session_binding_log_only',
      severity: 'warning',
      category: 'security',
      message: 'Session binding is configured in log-only mode.',
      fix: 'Move to onMismatch: "reject" or "unauthenticate" before opening production traffic.',
    });
  }

  const rateLimit = security?.rateLimit;
  if (!rateLimit || rateLimit === false) {
    add({
      id: 'security.rate_limit_missing',
      severity: 'warning',
      category: 'security',
      message: 'Global rate limiting is not configured.',
      fix: 'Set security.rateLimit with production request budgets and a Redis store for multi-instance deploys.',
    });
  } else if (isRecord(rateLimit)) {
    const store = rateLimit.store;
    if (store !== 'redis') {
      add({
        id: 'security.rate_limit_store',
        severity: 'warning',
        category: 'security',
        message: 'Global rate limiting is not using Redis.',
        fix: 'Set security.rateLimit.store to "redis" for shared limits across instances.',
      });
    }
  }

  const csrf = asRecord(security?.csrf);
  if (asRecord(cors)?.credentials === true && csrf?.enabled !== true) {
    add({
      id: 'security.csrf_review',
      severity: 'warning',
      category: 'security',
      message: 'Credentialed CORS is enabled without an explicit CSRF policy.',
      fix: 'Enable CSRF protection or document why the credentialed routes are not browser-mutating endpoints.',
    });
  }
}

function auditStorage(
  config: AuditConfig,
  add: (finding: ProductionReadinessFinding) => void,
): void {
  const db = asRecord(config.db) ?? {};
  const effective = resolveEffectiveStores(db);

  if (effective.defaultStore === 'memory') {
    add({
      id: 'storage.default_memory',
      severity: 'error',
      category: 'storage',
      message: 'The effective default store is memory.',
      fix: 'Configure Postgres, Redis, SQLite, or Mongo for production stores.',
    });
  }

  for (const [name, store] of Object.entries(effective.stores) as Array<[string, StoreName]>) {
    if ((name === 'sessions' || name === 'auth') && store === 'memory') {
      add({
        id: `storage.${name}_memory`,
        severity: 'error',
        category: 'storage',
        message: `${name} uses the in-memory store.`,
        fix: `Set db.${name} to a durable backend such as "postgres", "redis", "sqlite", or "mongo" as supported by that store.`,
      });
    } else if (store === 'memory') {
      add({
        id: `storage.${name}_memory`,
        severity: 'warning',
        category: 'storage',
        message: `${name} uses the in-memory store.`,
        fix: `Set db.${name} to a shared backend for multi-instance production deployments.`,
      });
    }
  }

  const stores = new Set(Object.values(effective.stores));
  if (stores.has('postgres') && !isNonEmptyString(db.postgres)) {
    add({
      id: 'storage.postgres_missing',
      severity: 'error',
      category: 'storage',
      message: 'A store selects Postgres but db.postgres is not configured.',
      fix: 'Set db.postgres to the production connection string.',
    });
  }

  if (stores.has('redis') && db.redis === false) {
    add({
      id: 'storage.redis_disabled',
      severity: 'error',
      category: 'storage',
      message: 'A store selects Redis but db.redis is false.',
      fix: 'Enable db.redis or move the store to another configured backend.',
    });
  }

  if (stores.has('sqlite') && !isNonEmptyString(db.sqlite)) {
    add({
      id: 'storage.sqlite_missing',
      severity: 'error',
      category: 'storage',
      message: 'A store selects SQLite but db.sqlite is not configured.',
      fix: 'Set db.sqlite to an absolute database path, or use a networked production database.',
    });
  }

  if (stores.has('mongo') && effective.mongoMode === false) {
    add({
      id: 'storage.mongo_disabled',
      severity: 'error',
      category: 'storage',
      message: 'A store selects Mongo but db.mongo is false.',
      fix: 'Enable db.mongo or move the store to another configured backend.',
    });
  }

  if (isNonEmptyString(db.postgres)) {
    if (db.postgresMigrations === undefined) {
      add({
        id: 'storage.postgres_migrations',
        severity: 'warning',
        category: 'storage',
        message: 'db.postgres is configured without an explicit postgresMigrations mode.',
        fix: 'Set db.postgresMigrations to "assume-ready" for externally managed migrations or "apply" for runtime-owned migrations.',
      });
    }

    const pool = asRecord(db.postgresPool);
    if (!pool?.connectionTimeoutMs || !pool?.queryTimeoutMs || !pool?.statementTimeoutMs) {
      add({
        id: 'storage.postgres_pool_timeouts',
        severity: 'warning',
        category: 'storage',
        message: 'Postgres pool connection, query, or statement timeouts are not fully configured.',
        fix: 'Set postgresPool.connectionTimeoutMs, queryTimeoutMs, and statementTimeoutMs to bounded production values.',
      });
    }
  }
}

function auditObservability(
  config: AuditConfig,
  add: (finding: ProductionReadinessFinding) => void,
): void {
  const metrics = asRecord(config.metrics);
  if (metrics?.enabled === true && isPublicEndpoint(metrics.auth, metrics.unsafePublic)) {
    add({
      id: 'observability.metrics_auth',
      severity: 'error',
      category: 'observability',
      message: '/metrics is enabled without production auth.',
      fix: 'Set metrics.auth to "userAuth" or a custom middleware stack, or explicitly set unsafePublic only behind a network guard.',
    });
  }

  const jobs = asRecord(config.jobs);
  if (jobs?.statusEndpoint === true && isPublicEndpoint(jobs.auth, jobs.unsafePublic)) {
    add({
      id: 'observability.jobs_auth',
      severity: 'error',
      category: 'observability',
      message: 'The jobs status endpoint is enabled without production auth.',
      fix: 'Set jobs.auth to "userAuth" or a custom middleware stack, or explicitly set unsafePublic only behind a network guard.',
    });
  }

  if (jobs?.scopeToUser === true && jobs.auth !== 'userAuth') {
    add({
      id: 'observability.jobs_scope_auth',
      severity: 'error',
      category: 'observability',
      message: 'jobs.scopeToUser requires jobs.auth: "userAuth".',
      fix: 'Set jobs.auth to "userAuth" when using per-user job visibility.',
    });
  }

  const logging = asRecord(config.logging);
  if (logging?.enabled === false) {
    add({
      id: 'observability.logging_disabled',
      severity: 'warning',
      category: 'observability',
      message: 'Structured request logging is disabled.',
      fix: 'Enable request logging or document the external middleware that provides equivalent request logs.',
    });
  }
}

function auditRuntime(
  config: AuditConfig,
  add: (finding: ProductionReadinessFinding) => void,
): void {
  if (config.hostname === '127.0.0.1' || config.hostname === 'localhost') {
    add({
      id: 'runtime.loopback_bind',
      severity: 'warning',
      category: 'runtime',
      message: `Server hostname is bound to ${config.hostname}.`,
      fix: 'Bind to 0.0.0.0 in containers unless a local reverse proxy intentionally owns the public socket.',
    });
  }

  if (config.maxRequestBodySize === undefined && config.upload === undefined) {
    add({
      id: 'runtime.body_size_limit',
      severity: 'warning',
      category: 'runtime',
      message: 'No explicit max request body size or upload limit is configured.',
      fix: 'Set maxRequestBodySize or upload limits to bound memory pressure from large requests.',
    });
  }
}

function auditRealtime(
  config: AuditConfig,
  add: (finding: ProductionReadinessFinding) => void,
  multiInstance: boolean,
): void {
  if (!multiInstance) return;

  const ws = asRecord(config.ws);
  if (ws && asRecord(ws.endpoints) && !ws.transport) {
    add({
      id: 'realtime.ws_transport',
      severity: 'warning',
      category: 'realtime',
      message: 'WebSocket endpoints are configured without a cross-instance transport.',
      fix: 'Provide ws.transport, such as the Redis transport, before running multiple instances.',
    });
  }

  const endpoints = asRecord(ws?.endpoints);
  if (endpoints) {
    for (const [name, endpoint] of Object.entries(endpoints)) {
      const persistence = asRecord(asRecord(endpoint)?.persistence);
      if (persistence?.store === 'memory') {
        add({
          id: 'realtime.ws_persistence_memory',
          severity: 'warning',
          category: 'realtime',
          message: `WebSocket endpoint "${name}" uses memory persistence.`,
          fix: 'Use Redis, Postgres, Mongo, or SQLite persistence for recovery/history that must survive restarts.',
        });
      }
    }
  }

  const sse = asRecord(config.sse);
  if (sse && asRecord(sse.endpoints) && !config.eventBus) {
    add({
      id: 'realtime.sse_event_bus',
      severity: 'warning',
      category: 'realtime',
      message: 'SSE endpoints use the default in-process event bus.',
      fix: 'Provide a shared eventBus adapter when SSE events must fan out across instances.',
    });
  }
}

function formatProductionReadinessFailure(report: ProductionReadinessReport): string {
  const errors = report.findings.filter(f => f.severity === 'error');
  const lines = errors.map(f => {
    const fix = f.fix ? ` Fix: ${f.fix}` : '';
    return `- ${f.id}: ${f.message}${fix}`;
  });
  return `[slingshot] Production readiness failed:\n${lines.join('\n')}`;
}

function signingFeatureEnabled(signing: UnknownRecord): boolean {
  return [
    signing.cookies,
    signing.cursors,
    signing.presignedUrls,
    signing.requestSigning,
    signing.idempotencyKeys,
    signing.sessionBinding,
  ].some(value => value !== undefined && value !== false);
}

function signingSecrets(signing: UnknownRecord, env: Record<string, string | undefined>): string[] {
  const configured = signing.secret;
  if (typeof configured === 'string') return configured.trim() ? [configured] : [];
  if (Array.isArray(configured)) {
    return configured.filter((value): value is string => typeof value === 'string');
  }
  const envSecret = env.JWT_SECRET;
  return envSecret ? [envSecret] : [];
}

function getCorsOrigins(cors: unknown): string[] {
  if (typeof cors === 'string') return [cors];
  if (Array.isArray(cors))
    return cors.filter((origin): origin is string => typeof origin === 'string');
  const record = asRecord(cors);
  const origin = record?.origin;
  if (typeof origin === 'string') return [origin];
  if (Array.isArray(origin))
    return origin.filter((value): value is string => typeof value === 'string');
  return [];
}

function resolveEffectiveStores(db: UnknownRecord): {
  defaultStore: StoreName;
  mongoMode: 'single' | 'separate' | false;
  stores: {
    sessions: StoreName;
    oauthState: StoreName;
    cache: StoreName;
    auth: StoreName;
  };
} {
  const mongoMode = resolveMongoMode(db);
  const defaultStore: StoreName =
    db.redis !== false
      ? 'redis'
      : isNonEmptyString(db.postgres)
        ? 'postgres'
        : isNonEmptyString(db.sqlite)
          ? 'sqlite'
          : mongoMode !== false
            ? 'mongo'
            : 'memory';

  const sessions = asStore(db.sessions) ?? defaultStore;
  const oauthState = asStore(db.oauthState) ?? sessions;
  const cache = asStore(db.cache) ?? defaultStore;
  const auth = asStore(db.auth) ?? (mongoMode !== false ? 'mongo' : sessions);

  return {
    defaultStore,
    mongoMode,
    stores: { sessions, oauthState, cache, auth },
  };
}

function resolveMongoMode(db: UnknownRecord): 'single' | 'separate' | false {
  if (db.mongo === 'single' || db.mongo === 'separate' || db.mongo === false) return db.mongo;
  if ([db.sessions, db.oauthState, db.cache, db.auth].includes('mongo')) return 'single';
  if (isNonEmptyString(db.sqlite) || isNonEmptyString(db.postgres)) return false;
  if (db.auth && db.auth !== 'mongo') return false;
  return 'single';
}

function isPublicEndpoint(auth: unknown, unsafePublic: unknown): boolean {
  return (auth === undefined || auth === 'none') && unsafePublic !== true;
}

function hasNamedPlugin(config: AuditConfig, name: string): boolean {
  if (!Array.isArray(config.plugins)) return false;
  return config.plugins.some(plugin => asRecord(plugin)?.name === name);
}

function asStore(value: unknown): StoreName | null {
  if (
    value === 'redis' ||
    value === 'mongo' ||
    value === 'sqlite' ||
    value === 'memory' ||
    value === 'postgres'
  ) {
    return value;
  }
  return null;
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
