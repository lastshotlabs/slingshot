import { describe, expect, test } from 'bun:test';
import {
  ProductionReadinessError,
  assertProductionReadiness,
  auditProductionReadiness,
} from '../../src/prodReadiness';

const LONG_SECRET = 'prod-secret-prod-secret-prod-secret-1234';

function ids(report: ReturnType<typeof auditProductionReadiness>): string[] {
  return report.findings.map(f => f.id);
}

function cleanConfig() {
  return {
    port: 3000,
    hostname: '0.0.0.0',
    maxRequestBodySize: 1_048_576,
    security: {
      cors: { origin: ['https://app.example.com'], credentials: true },
      csrf: { enabled: true, exemptPaths: ['/webhooks/*'] },
      trustProxy: 1,
      signing: {
        secret: LONG_SECRET,
        cookies: true,
        sessionBinding: { fields: ['ip', 'ua'], onMismatch: 'reject' },
      },
      rateLimit: { windowMs: 60_000, max: 200, store: 'redis' },
    },
    db: {
      redis: true,
      postgres: 'postgres://slingshot:secret@db.example.com:5432/app',
      postgresMigrations: 'assume-ready',
      postgresPool: {
        connectionTimeoutMs: 2_000,
        queryTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
      },
      sessions: 'postgres',
      oauthState: 'postgres',
      cache: 'postgres',
      auth: 'postgres',
      mongo: false,
    },
    metrics: { enabled: true, auth: 'userAuth' },
    jobs: { statusEndpoint: true, auth: 'userAuth', scopeToUser: true },
  };
}

describe('production readiness audit', () => {
  test('passes a hardened production server config', () => {
    const report = auditProductionReadiness(cleanConfig(), {
      nodeEnv: 'production',
      env: { REDIS_HOST: 'cache.example.com:6379' },
    });

    expect(report.ok).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.findings).toEqual([]);
  });

  test('reports Redis-backed stores without REDIS_HOST', () => {
    const report = auditProductionReadiness(cleanConfig(), {
      nodeEnv: 'production',
      env: {},
    });

    expect(report.ok).toBe(false);
    expect(ids(report)).toContain('storage.redis_host_missing');
  });

  test('reports blocking security, storage, and observability findings', () => {
    const report = auditProductionReadiness(
      {
        security: {
          cors: { origin: '*', credentials: true },
          signing: { secret: 'short', cookies: true },
          rateLimit: false,
        },
        db: {
          redis: false,
          mongo: false,
          sessions: 'memory',
          auth: 'memory',
          cache: 'memory',
        },
        metrics: { enabled: true },
        jobs: { statusEndpoint: true, scopeToUser: true },
      },
      { nodeEnv: 'production', env: { REDIS_HOST: 'cache.example.com:6379' } },
    );

    expect(report.ok).toBe(false);
    expect(ids(report)).toContain('security.cors_wildcard_credentials');
    expect(ids(report)).toContain('security.trust_proxy_explicit');
    expect(ids(report)).toContain('security.signing_secret_short');
    expect(ids(report)).toContain('storage.default_memory');
    expect(ids(report)).toContain('storage.sessions_memory');
    expect(ids(report)).toContain('storage.auth_memory');
    expect(ids(report)).toContain('observability.metrics_auth');
    expect(ids(report)).toContain('observability.jobs_auth');
    expect(ids(report)).toContain('observability.jobs_scope_auth');
  });

  test('throws a structured error from assertProductionReadiness', () => {
    expect(() =>
      assertProductionReadiness(
        {
          security: { cors: '*', signing: { cookies: true } },
          db: { redis: false, mongo: false, sessions: 'memory', auth: 'memory' },
        },
        { nodeEnv: 'production', env: {} },
      ),
    ).toThrow(ProductionReadinessError);

    try {
      assertProductionReadiness(
        {
          security: { cors: '*', signing: { cookies: true } },
          db: { redis: false, mongo: false, sessions: 'memory', auth: 'memory' },
        },
        { nodeEnv: 'production', env: {} },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionReadinessError);
      expect((error as ProductionReadinessError).report.ok).toBe(false);
      expect(String(error)).toContain('security.cors_wildcard');
    }
  });

  test('enforces explicit session binding when the auth plugin is present', () => {
    const report = auditProductionReadiness(
      {
        ...cleanConfig(),
        plugins: [{ name: 'slingshot-auth' }],
        security: {
          ...cleanConfig().security,
          signing: {
            secret: LONG_SECRET,
            cookies: true,
          },
        },
      },
      { nodeEnv: 'production', env: {} },
    );

    expect(ids(report)).toContain('security.session_binding_explicit');
    expect(report.ok).toBe(false);
  });

  test('warns about realtime fanout only for multi-instance deployments', () => {
    const withRealtime = {
      ...cleanConfig(),
      ws: { endpoints: { '/ws': {} } },
      sse: { endpoints: { '/events': {} } },
    };

    const scaled = auditProductionReadiness(withRealtime, {
      nodeEnv: 'production',
      env: { REDIS_HOST: 'cache.example.com:6379' },
    });
    expect(ids(scaled)).toContain('realtime.ws_transport');
    expect(ids(scaled)).toContain('realtime.sse_event_bus');

    const single = auditProductionReadiness(withRealtime, {
      nodeEnv: 'production',
      env: { REDIS_HOST: 'cache.example.com:6379' },
      multiInstance: false,
    });
    expect(ids(single)).not.toContain('realtime.ws_transport');
    expect(ids(single)).not.toContain('realtime.sse_event_bus');
  });

  test('accepts JWT_SECRET from the audited environment for signing features', () => {
    const config = cleanConfig();
    config.security.signing = {
      cookies: true,
      sessionBinding: { fields: ['ip', 'ua'], onMismatch: 'reject' },
    } as typeof config.security.signing;

    const report = auditProductionReadiness(config, {
      nodeEnv: 'production',
      env: { JWT_SECRET: LONG_SECRET, REDIS_HOST: 'cache.example.com:6379' },
    });

    expect(ids(report)).not.toContain('security.signing_secret_missing');
    expect(ids(report)).not.toContain('security.signing_secret_short');
    expect(report.ok).toBe(true);
  });
});
