import { describe, expect, it } from 'bun:test';
import { validateAppConfig, validateServerConfig } from '../../src/framework/config/schema';

describe('config validation', () => {
  // -------------------------------------------------------------------
  // Valid configs
  // -------------------------------------------------------------------

  describe('valid configs', () => {
    it('accepts minimal app config (routesDir only)', () => {
      const result = validateAppConfig({ routesDir: '/some/path' });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full app config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        modelSchemas: '/schemas',
        meta: { name: 'Test', version: '1.0.0' },
        security: { cors: '*' },
        middleware: [],
        db: { redis: true },
        jobs: { statusEndpoint: true },
        tenancy: { resolution: 'header' },
        logging: { enabled: true },
        metrics: { enabled: false },
        validation: {},
        upload: { storage: {} },
        versioning: ['v1', 'v2'],
        plugins: [],
        eventBus: {},
        runtime: {},
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts modelSchemas as string array', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        modelSchemas: ['/schemas', '/models'],
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts modelSchemas as object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        modelSchemas: { paths: ['/schemas'], registration: 'auto' },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts ws drafts in app config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        ws: {
          endpoints: {
            '/chat': {
              heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 },
            },
          },
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts versioning as object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        versioning: { versions: ['v1', 'v2'], defaultVersion: 'v2' },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts minimal server config', () => {
      const result = validateServerConfig({
        routesDir: '/routes',
        port: 3000,
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full server config without warnings', () => {
      const result = validateServerConfig({
        routesDir: '/routes',
        port: 8080,
        hostname: '0.0.0.0',
        tls: { cert: '/path/to/cert' },
        workersDir: '/workers',
        enableWorkers: true,
        ws: { endpoints: {} },
        sse: { endpoints: {} },
        maxRequestBodySize: 1024 * 1024,
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts a comprehensive CreateServerConfig shape without warnings', () => {
      const result = validateServerConfig({
        routesDir: '/routes',
        modelSchemas: { paths: ['/schemas'], registration: 'auto' },
        meta: { name: 'Demo', version: '1.2.3' },
        security: {
          cors: '*',
          rateLimit: { windowMs: 60_000, max: 100 },
          botProtection: { blockList: ['198.51.100.0/24'], fingerprintRateLimit: true },
          trustProxy: 1,
          signing: {
            secret: 'secret',
            cookies: true,
            presignedUrls: { defaultExpiry: 3600 },
            requestSigning: { tolerance: 300 },
            sessionBinding: { fields: ['ip'], onMismatch: 'reject' },
          },
        },
        db: { mongo: 'single', redis: true, sessions: 'redis', cache: 'redis', auth: 'mongo' },
        jobs: { statusEndpoint: true },
        tenancy: { resolution: 'header' },
        logging: { enabled: true },
        metrics: { enabled: true },
        validation: {},
        upload: { storage: {} },
        versioning: ['v1'],
        plugins: [],
        eventBus: {},
        secrets: {},
        runtime: {},
        port: 8080,
        hostname: '0.0.0.0',
        tls: { cert: '/path/to/cert' },
        workersDir: '/workers',
        enableWorkers: true,
        ws: {
          endpoints: {
            '/chat': {
              heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 },
              presence: { broadcastEvents: true },
            },
          },
        },
        sse: { endpoints: { '/__sse/feed': { events: ['demo:event'] } } },
        maxRequestBodySize: 1024 * 1024,
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full security config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          cors: {
            origin: 'http://localhost',
            credentials: true,
            allowHeaders: ['X-Custom'],
            maxAge: 3600,
          },
          headers: true,
          rateLimit: {
            windowMs: 60000,
            max: 100,
            message: 'Too many requests',
            standardHeaders: true,
          },
          botProtection: { blockList: ['bad-bot'], fingerprintRateLimit: true },
          trustProxy: 1,
          signing: {
            secret: 's3cret',
            cookies: true,
            cursors: true,
            presignedUrls: { defaultExpiry: 3600 },
            requestSigning: { tolerance: 300, header: 'X-Sig', timestampHeader: 'X-TS' },
            idempotencyKeys: true,
            sessionBinding: { fields: ['ip', 'ua'], onMismatch: 'reject' },
          },
          captcha: { provider: 'recaptcha', secretKey: 'key123', minScore: 0.5 },
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full db config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        db: {
          sqlite: '/data/app.db',
          mongo: 'single',
          redis: { url: 'redis://localhost:6379', maxRetriesPerRequest: 3 },
          sessions: 'redis',
          oauthState: 'mongo',
          cache: 'memory',
          auth: 'mongo',
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full tenancy config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        tenancy: {
          resolution: 'subdomain',
          headerName: 'X-Tenant',
          pathSegment: 0,
          onResolve: () => {},
          cacheTtlMs: 60000,
          cacheMaxSize: 1000,
          exemptPaths: ['/health'],
          rejectionStatus: 404,
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full logging config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        logging: {
          enabled: true,
          onLog: () => {},
          level: 'debug',
          excludePaths: ['/health'],
          excludeMethods: ['OPTIONS'],
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full metrics config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        metrics: {
          enabled: true,
          auth: 'userAuth',
          excludePaths: ['/health'],
          normalizePath: () => '/normalized',
          queues: ['email', 'reports'],
          unsafePublic: false,
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full upload config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        upload: {
          storage: {},
          maxFileSize: 10 * 1024 * 1024,
          maxFiles: 5,
          allowedMimeTypes: ['image/png'],
          keyPrefix: 'uploads/',
          generateKey: () => 'key',
          tenantScopedKeys: true,
          presignedUrls: { expirySeconds: 3600, path: '/presign' },
          authorization: { authorize: () => true },
          allowExternalKeys: false,
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts full jobs config without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        jobs: {
          statusEndpoint: true,
          auth: 'userAuth',
          roles: ['admin'],
          allowedQueues: ['email', 'reports'],
          scopeToUser: true,
          unsafePublic: false,
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts rateLimit: false and botProtection: false', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          rateLimit: false,
          botProtection: false,
          captcha: false,
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts redis as boolean or string', () => {
      expect(
        validateAppConfig({ routesDir: '/routes', db: { redis: true } }).warnings,
      ).toHaveLength(0);
      expect(
        validateAppConfig({ routesDir: '/routes', db: { redis: 'redis://localhost' } }).warnings,
      ).toHaveLength(0);
    });

    it('accepts db.postgres and Postgres store selections without warnings', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        db: {
          postgres: 'postgres://slingshot:test@localhost:5432/app',
          sessions: 'postgres',
          oauthState: 'postgres',
          cache: 'postgres',
          auth: 'postgres',
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts signing.presignedUrls and sessionBinding as booleans', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          signing: {
            presignedUrls: true,
            requestSigning: false,
            sessionBinding: false,
          },
        },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('accepts tls config in server config without warnings', () => {
      const result = validateServerConfig({
        routesDir: '/routes',
        tls: {
          key: '/path/key.pem',
          cert: '/path/cert.pem',
          passphrase: 'secret',
          rejectUnauthorized: true,
          requestCert: false,
        },
      });
      expect(result.warnings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Unknown keys (warnings) — top level
  // -------------------------------------------------------------------

  describe('unknown keys', () => {
    it("warns on typo'd top-level key in app config", () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        seecurity: { cors: '*' }, // typo
      };
      const result = validateAppConfig(config);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"seecurity"');
      expect(result.warnings[0]).toContain('Check for typos');
    });

    it('warns on multiple unknown keys', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        databse: {},
        lgging: {},
      };
      const result = validateAppConfig(config);

      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain('"databse"');
      expect(result.warnings[1]).toContain('"lgging"');
    });

    it('warns on unknown server-level keys', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        prot: 3000, // typo for port
      };
      const result = validateServerConfig(config);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"prot"');
    });

    it('throws on unknown keys when production strictness is passed explicitly', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        seecurity: { cors: '*' },
      };
      expect(() => validateAppConfig(config, { isProd: true })).toThrow(
        'Config validation failed in production',
      );
    });
  });

  // -------------------------------------------------------------------
  // Unknown keys (warnings) — nested levels
  // -------------------------------------------------------------------

  describe('nested unknown keys', () => {
    it('warns on typo in security section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: { coors: '*' },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.coors"');
    });

    it('warns on typo in security.rateLimit', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          rateLimit: { widowMs: 60000 }, // typo: widowMs
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.rateLimit.widowMs"');
    });

    it('warns on typo in db section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        db: { sesions: 'redis' }, // typo: sesions
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"db.sesions"');
    });

    it('warns on typo in logging section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        logging: { ennabled: true },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"logging.ennabled"');
    });

    it('warns on typo in metrics section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        metrics: { enbled: true },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"metrics.enbled"');
    });

    it('warns on typo in tenancy section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        tenancy: { resolution: 'header', hedaerName: 'X-Tenant' },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"tenancy.hedaerName"');
    });

    it('warns on typo in jobs section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        jobs: { statussEndpoint: true },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"jobs.statussEndpoint"');
    });

    it('warns on typo in upload section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        upload: { storage: {}, maxFleSize: 1024 },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"upload.maxFleSize"');
    });

    it('warns on typo in validation section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        validation: { formattError: () => {} },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"validation.formattError"');
    });

    it('warns on typo in app section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        meta: { naem: 'Test' },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"meta.naem"');
    });

    it('warns on typo in security.signing section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          signing: { secrett: 'key' },
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.signing.secrett"');
    });

    it('warns on typo in security.botProtection section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          botProtection: { blocklist: ['bot'] }, // typo: blocklist vs blockList
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.botProtection.blocklist"');
    });

    it('warns on typo in security.captcha section', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          captcha: { provider: 'recaptcha', secretKey: 'key', minscore: 0.5 },
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.captcha.minscore"');
    });

    it('warns on typo in deeply nested signing.presignedUrls object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          signing: {
            presignedUrls: { defualtExpiry: 3600 },
          },
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.signing.presignedUrls.defualtExpiry"');
    });

    it('warns on typo in security.signing.requestSigning object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          signing: {
            requestSigning: { tolerence: 300 },
          },
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.signing.requestSigning.tolerence"');
    });

    it('warns on typo in security.signing.sessionBinding object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          signing: {
            sessionBinding: { feilds: ['ip'] },
          },
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.signing.sessionBinding.feilds"');
    });

    it('warns on typo in db.redis object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        db: { redis: { url: 'redis://localhost', maxRetriesPerReqest: 3 } },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"db.redis.maxRetriesPerReqest"');
    });

    it('warns on typo in upload.presignedUrls object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        upload: {
          storage: {},
          presignedUrls: { expirySecnods: 3600 },
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"upload.presignedUrls.expirySecnods"');
    });

    it('warns on typo in tls section of server config', () => {
      const result = validateServerConfig({
        routesDir: '/routes',
        tls: { cret: '/path/cert.pem' },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"tls.cret"');
    });

    it('warns on typo in security.cors object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: {
          cors: { origin: '*', credentails: true },
        },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"security.cors.credentails"');
    });

    it('warns on multiple nested typos across sections', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        security: { coors: '*' },
        db: { sesions: 'redis' },
        logging: { ennabled: true },
      });
      expect(result.warnings).toHaveLength(3);
    });

    it('does not warn on unknown keys in skipped sections (plugins, middleware, eventBus)', () => {
      const result = validateServerConfig({
        routesDir: '/routes',
        middleware: [() => {}],
        plugins: [{ name: 'test' }],
        eventBus: { custom: true },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('warns on unknown keys in ws and sse sections', () => {
      const result = validateServerConfig({
        routesDir: '/routes',
        ws: { endpoints: {}, unknownWsKey: true },
        sse: { endpoints: {}, unknownSseKey: 'x' },
      });
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain('"ws.unknownWsKey"');
      expect(result.warnings[1]).toContain('"sse.unknownSseKey"');
    });

    it('does not warn on versioning as string array', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        versioning: ['v1', 'v2'],
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('warns on typo in versioning object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        versioning: { versions: ['v1'], shredDir: '/shared' },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"versioning.shredDir"');
    });

    it('warns on typo in modelSchemas object', () => {
      const result = validateAppConfig({
        routesDir: '/routes',
        modelSchemas: { pathss: ['/schemas'] },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('"modelSchemas.pathss"');
    });
  });

  // -------------------------------------------------------------------
  // Nested type mismatches (throws)
  // -------------------------------------------------------------------

  describe('nested type mismatches', () => {
    it('throws when security.rateLimit.windowMs is not a number', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          security: { rateLimit: { windowMs: 'not a number' } },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when security.rateLimit.max is not a number', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          security: { rateLimit: { max: 'one hundred' } },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when db.sessions is an invalid enum value', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          db: { sessions: 'postgresql' },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when tenancy.resolution is an invalid enum value', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          tenancy: { resolution: 'cookie' },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when logging.level is an invalid enum value', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          logging: { level: 'verbose' },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when security.cors.maxAge is not a number', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          security: { cors: { origin: '*', maxAge: 'forever' } },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when upload.maxFileSize is not a number', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          upload: { storage: {}, maxFileSize: '10mb' },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when tenancy.cacheTtlMs is not a number', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          tenancy: { resolution: 'header', cacheTtlMs: '60000' },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when metrics.enabled is not a boolean', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          metrics: { enabled: 'yes' },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when db.mongo is an invalid value', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          db: { mongo: 'yes' },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('throws when signing.sessionBinding.onMismatch is invalid', () => {
      expect(() =>
        validateAppConfig({
          routesDir: '/routes',
          security: {
            signing: {
              sessionBinding: { onMismatch: 'ignore' },
            },
          },
        }),
      ).toThrow('[slingshot] Invalid config');
    });

    it('includes nested field path in error message', () => {
      try {
        validateAppConfig({
          routesDir: '/routes',
          security: { rateLimit: { windowMs: 'bad' } },
        });
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toContain('security');
      }
    });
  });

  // -------------------------------------------------------------------
  // Type mismatches (throws) — top level (original tests)
  // -------------------------------------------------------------------

  describe('type mismatches', () => {
    it('accepts config when routesDir is missing (routesDir is optional)', () => {
      const config: Record<string, unknown> = {};
      expect(() => validateAppConfig(config)).not.toThrow();
    });

    it('throws when routesDir is not a string', () => {
      const config: Record<string, unknown> = { routesDir: 123 };
      expect(() => validateAppConfig(config)).toThrow('[slingshot] Invalid config');
    });

    it('throws when port is not a number', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        port: '3000',
      };
      expect(() => validateServerConfig(config)).toThrow('[slingshot] Invalid config');
    });

    it('throws when enableWorkers is not a boolean', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        enableWorkers: 'yes',
      };
      expect(() => validateServerConfig(config)).toThrow('[slingshot] Invalid config');
    });

    it('throws when middleware is not an array', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        middleware: 'not-an-array',
      };
      expect(() => validateAppConfig(config)).toThrow('[slingshot] Invalid config');
    });

    it('throws when plugins is not an array', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        plugins: {},
      };
      expect(() => validateAppConfig(config)).toThrow('[slingshot] Invalid config');
    });

    it('includes field path in error message', () => {
      const config: Record<string, unknown> = { routesDir: 42 };
      try {
        validateAppConfig(config);
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toContain('routesDir');
      }
    });

    it('throws when maxRequestBodySize is not a number', () => {
      const config: Record<string, unknown> = {
        routesDir: '/routes',
        maxRequestBodySize: 'big',
      };
      expect(() => validateServerConfig(config)).toThrow('[slingshot] Invalid config');
    });
  });
});
