import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ANONYMOUS_ACTOR, createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { SecretRepository, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import type { AppManifest } from '../../src/lib/manifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import { manifestToAppConfig } from '../../src/lib/manifestToAppConfig';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'entity:user.created': Record<string, unknown>;
  }
}

// Minimal valid manifest
const minimalManifest: AppManifest = {
  manifestVersion: 1,
  routesDir: '/app/src/routes',
};

function unsafeManifest(value: unknown): AppManifest {
  return value as AppManifest;
}

describe('manifestToAppConfig', () => {
  describe('direct field copies', () => {
    it('copies routesDir and resolves to an absolute path', () => {
      const config = manifestToAppConfig(minimalManifest);
      // path.resolve() makes it absolute (platform-dependent prefix)
      expect(config.routesDir).toContain('app');
      expect(config.routesDir).toContain('routes');
    });

    it('substitutes ${importMetaDir} in routesDir with baseDir', () => {
      const baseDir = process.platform === 'win32' ? 'C:\\myapp' : '/myapp';
      const manifest: AppManifest = { ...minimalManifest, routesDir: '${importMetaDir}/routes' };
      const config = manifestToAppConfig(manifest, undefined, { baseDir });
      expect(config.routesDir).toContain('myapp');
      expect(config.routesDir).toContain('routes');
    });

    it('substitutes ${importMetaDir} in workersDir with baseDir', () => {
      const baseDir = process.platform === 'win32' ? 'C:\\myapp' : '/myapp';
      const manifest: AppManifest = {
        ...minimalManifest,
        workersDir: '${importMetaDir}/workers',
      };
      const config = manifestToAppConfig(manifest, undefined, { baseDir });
      expect(config.workersDir).toContain('myapp');
      expect(config.workersDir).toContain('workers');
    });

    it('copies port, hostname, enableWorkers, maxRequestBodySize', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        port: 8080,
        hostname: '0.0.0.0',
        enableWorkers: false,
        maxRequestBodySize: 1024,
      };
      const config = manifestToAppConfig(manifest);
      expect(config.port).toBe(8080);
      expect(config.hostname).toBe('0.0.0.0');
      expect(config.enableWorkers).toBe(false);
      expect(config.maxRequestBodySize).toBe(1024);
    });

    it('copies meta section', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        meta: { name: 'my-app', version: '1.0.0' },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.meta).toEqual({ name: 'my-app', version: '1.0.0' });
    });

    it('copies db section', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        db: { mongo: 'single', redis: true },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.db).toEqual({ mongo: 'single', redis: true });
    });

    it('entities field is absent from output', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        entities: {
          User: {
            fields: { id: { type: 'string', primary: true } },
          },
        },
      };
      const config = manifestToAppConfig(manifest) as Record<string, unknown>;
      expect(config['entities']).toBeUndefined();
    });
  });

  describe('HandlerRef resolution', () => {
    it('resolves tenancy.onResolve via registry', () => {
      const reg = createManifestHandlerRegistry();
      const resolveFn = (id: string) => Promise.resolve({ id });
      reg.registerHandler('resolveTenant', () => resolveFn);

      const manifest: AppManifest = {
        ...minimalManifest,
        tenancy: {
          resolution: 'subdomain',
          onResolve: { handler: 'resolveTenant' },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.tenancy?.onResolve).toBe(resolveFn);
    });

    it('copies tenancy.listEndpoint through to the resolved config', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        tenancy: {
          resolution: 'header',
          headerName: 'x-ledger-id',
          listEndpoint: '/api/tenants',
        },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.tenancy?.listEndpoint).toBe('/api/tenants');
      expect(config.tenancy?.headerName).toBe('x-ledger-id');
    });

    it('resolves logging.onLog via registry', () => {
      const reg = createManifestHandlerRegistry();
      const onLog = (entry: unknown) => void entry;
      reg.registerHandler('onLog', () => onLog);

      const manifest: AppManifest = {
        ...minimalManifest,
        logging: { onLog: { handler: 'onLog' } },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.logging?.onLog).toBe(onLog);
    });

    it('resolves metrics.normalizePath via registry', () => {
      const reg = createManifestHandlerRegistry();
      const normalize = (p: string) => p;
      reg.registerHandler('normalizePath', () => normalize);

      const manifest: AppManifest = {
        ...minimalManifest,
        metrics: { normalizePath: { handler: 'normalizePath' } },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.metrics?.normalizePath).toBe(normalize);
    });

    it('resolves validation.formatError via registry', () => {
      const reg = createManifestHandlerRegistry();
      const formatter = (err: unknown) => ({ message: String(err) });
      reg.registerHandler('formatError', () => formatter);

      const manifest: AppManifest = {
        ...minimalManifest,
        validation: { formatError: { handler: 'formatError' } },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.validation?.formatError).toBe(formatter);
    });

    it('resolves upload.generateKey via registry', () => {
      const reg = createManifestHandlerRegistry();
      const generateKey = (file: File) => file.name;
      reg.registerHandler('generateKey', () => generateKey);

      const manifest: AppManifest = {
        ...minimalManifest,
        upload: {
          storage: { adapter: 'memory' },
          generateKey: { handler: 'generateKey' },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.upload?.generateKey).toBe(generateKey);
    });

    it('resolves upload.authorization.authorize via registry', () => {
      const reg = createManifestHandlerRegistry();
      const authorize = () => true;
      reg.registerHandler('authorize', () => authorize);

      const manifest: AppManifest = {
        ...minimalManifest,
        upload: {
          storage: { adapter: 'memory' },
          authorization: { authorize: { handler: 'authorize' } },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.upload?.authorization?.authorize).toBe(authorize);
    });

    it('throws with clear message when HandlerRef present but no registry', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        tenancy: { resolution: 'subdomain', onResolve: { handler: 'resolveTenant' } },
      };
      expect(() => manifestToAppConfig(manifest)).toThrow(
        '[manifestToAppConfig] HandlerRef "resolveTenant" at tenancy.onResolve requires a registry',
      );
    });
  });

  describe('auth field resolution', () => {
    it('copies jobs.auth "userAuth" string directly', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        jobs: { statusEndpoint: true, auth: 'userAuth' },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.jobs?.auth).toBe('userAuth');
    });

    it('copies jobs.auth "none" string directly', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        jobs: { statusEndpoint: true, auth: 'none' },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.jobs?.auth).toBe('none');
    });

    it('resolves jobs.auth HandlerRef array via registry', () => {
      const reg = createManifestHandlerRegistry();
      const mw = () => {};
      reg.registerHandler('adminMw', () => mw);

      const manifest: AppManifest = {
        ...minimalManifest,
        jobs: { auth: [{ handler: 'adminMw' }] },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(Array.isArray(config.jobs?.auth)).toBe(true);
      expect((config.jobs?.auth as unknown[])[0]).toBe(mw);
    });

    it('resolves metrics.auth HandlerRef array via registry', () => {
      const reg = createManifestHandlerRegistry();
      const mw = () => {};
      reg.registerHandler('metricsMw', () => mw);

      const manifest: AppManifest = {
        ...minimalManifest,
        metrics: { auth: [{ handler: 'metricsMw' }] },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(Array.isArray(config.metrics?.auth)).toBe(true);
      expect((config.metrics?.auth as unknown[])[0]).toBe(mw);
    });
  });

  describe('storage adapter resolution', () => {
    it('resolves memory storage adapter', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        upload: { storage: { adapter: 'memory' } },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.upload?.storage).toBeDefined();
    });

    it('throws for unknown storage adapter', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        upload: { storage: { adapter: 'unknown' } },
      });
      expect(() => manifestToAppConfig(manifest)).toThrow(
        '[manifestToAppConfig] Unknown storage adapter "unknown"',
      );
    });
  });

  describe('event bus resolution', () => {
    it('"in-process" eventBus creates InProcessAdapter', () => {
      const manifest: AppManifest = { ...minimalManifest, eventBus: 'in-process' };
      const config = manifestToAppConfig(manifest);
      expect(config.eventBus).toBeDefined();
      expect(typeof config.eventBus?.on).toBe('function');
    });

    it('"bullmq" eventBus uses registry resolution', () => {
      const reg = createManifestHandlerRegistry();
      const fakeBus = createInProcessAdapter();
      reg.registerEventBus('bullmq', () => fakeBus);

      const manifest: AppManifest = { ...minimalManifest, eventBus: 'bullmq' };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.eventBus).toBe(fakeBus);
    });

    it('"kafka" eventBus uses registry resolution', () => {
      const reg = createManifestHandlerRegistry();
      const fakeBus = createInProcessAdapter();
      reg.registerEventBus('kafka', () => fakeBus);

      const manifest: AppManifest = { ...minimalManifest, eventBus: 'kafka' };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.eventBus).toBe(fakeBus);
    });

    it('"kafka" eventBus without registry throws a built-in hint', () => {
      const manifest: AppManifest = { ...minimalManifest, eventBus: 'kafka' };
      expect(() => manifestToAppConfig(manifest)).toThrow(
        'Use createServerFromManifest() for built-in Kafka auto-registration',
      );
    });

    it('"bullmq" eventBus without registry throws a built-in hint', () => {
      const manifest: AppManifest = { ...minimalManifest, eventBus: 'bullmq' };
      expect(() => manifestToAppConfig(manifest)).toThrow(
        'Use createServerFromManifest() for built-in BullMQ auto-registration',
      );
    });

    it('custom eventBus type uses registry', () => {
      const reg = createManifestHandlerRegistry();
      const fakeBus = createInProcessAdapter();
      reg.registerEventBus('redis', () => fakeBus);

      const manifest: AppManifest = {
        ...minimalManifest,
        eventBus: { type: 'redis', config: { url: 'redis://localhost' } },
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.eventBus).toBe(fakeBus);
    });

    it('custom eventBus without registry throws', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        eventBus: { type: 'redis' },
      });
      expect(() => manifestToAppConfig(manifest)).toThrow(
        '[manifestToAppConfig] eventBus type "redis" requires a registry',
      );
    });
  });

  describe('secrets resolution', () => {
    it('env provider resolves without registry', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        secrets: { provider: 'env', prefix: 'APP_' },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.secrets).toBeDefined();
    });

    it('file provider resolves without registry', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        secrets: { provider: 'file', directory: '/run/secrets' },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.secrets).toBeDefined();
    });

    it('custom provider uses registry', () => {
      const reg = createManifestHandlerRegistry();
      const repo: SecretRepository = {
        name: 'vault',
        get: () => Promise.resolve(null),
        getMany: () => Promise.resolve(new Map()),
      };
      reg.registerSecretProvider('vault', () => repo);

      const manifest = unsafeManifest({
        ...minimalManifest,
        secrets: { provider: 'vault' },
      });
      const config = manifestToAppConfig(manifest, reg);
      expect(config.secrets).toBe(repo);
    });

    it('custom provider without registry throws', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        secrets: { provider: 'vault' },
      });
      expect(() => manifestToAppConfig(manifest)).toThrow(
        '[manifestToAppConfig] secrets.provider "vault" requires a registry',
      );
    });
  });

  describe('plugins resolution', () => {
    it('returns no plugins when manifest has no plugins', () => {
      const config = manifestToAppConfig(minimalManifest);
      expect(config.plugins).toBeUndefined();
    });

    it('resolves plugins via registry', () => {
      const reg = createManifestHandlerRegistry();
      const plugin: SlingshotPlugin = { name: 'auth' };
      reg.registerPlugin('slingshot-auth', () => plugin);

      const manifest: AppManifest = {
        ...minimalManifest,
        plugins: [{ plugin: 'slingshot-auth', config: { posture: 'web-saas' } }],
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(config.plugins).toHaveLength(1);
      expect(config.plugins?.[0]).toBe(plugin);
    });

    it('throws when plugins present but no registry', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        plugins: [{ plugin: 'slingshot-auth' }],
      };
      expect(() => manifestToAppConfig(manifest)).toThrow(
        '[manifestToAppConfig] manifest.plugins requires a registry',
      );
    });

    it('synthesizes the built-in SSR plugin from the top-level ssr section', () => {
      const reg = createManifestHandlerRegistry();
      let capturedConfig: Record<string, unknown> | undefined;
      const plugin: SlingshotPlugin = { name: 'slingshot-ssr' };
      reg.registerPlugin('slingshot-ssr', config => {
        capturedConfig = config;
        return plugin;
      });

      const manifest: AppManifest = {
        ...minimalManifest,
        ssr: {
          renderer: { handler: 'ssrRenderer' },
          serverRoutesDir: '${importMetaDir}/server/routes',
          assetsManifest: '${importMetaDir}/dist/.vite/manifest.json',
        },
        ssg: {
          outDir: '${importMetaDir}/dist/static',
        },
      };

      const config = manifestToAppConfig(manifest, reg);
      expect(config.plugins).toHaveLength(1);
      expect(capturedConfig).toEqual({
        renderer: { handler: 'ssrRenderer' },
        serverRoutesDir: '${importMetaDir}/server/routes',
        assetsManifest: '${importMetaDir}/dist/.vite/manifest.json',
        staticDir: '${importMetaDir}/dist/static',
      });
    });

    it('rejects duplicate SSR sources when manifest.ssr and plugins entry are both present', () => {
      const reg = createManifestHandlerRegistry();
      const plugin: SlingshotPlugin = { name: 'slingshot-ssr' };
      reg.registerPlugin('slingshot-ssr', () => plugin);

      const manifest: AppManifest = {
        ...minimalManifest,
        ssr: {
          renderer: { handler: 'ssrRenderer' },
          serverRoutesDir: '${importMetaDir}/server/routes',
          assetsManifest: '${importMetaDir}/dist/.vite/manifest.json',
        },
        plugins: [{ plugin: 'slingshot-ssr' }],
      };

      expect(() => manifestToAppConfig(manifest, reg)).toThrow(
        'manifest.ssr cannot be combined with manifest.plugins entry "slingshot-ssr"',
      );
    });
  });

  describe('WS endpoint handler resolution', () => {
    it('resolves ws endpoint handlers via registry', () => {
      const reg = createManifestHandlerRegistry();
      const onOpen = () => {};
      const onMessage = () => {};
      reg.registerHandler('wsOpen', () => onOpen);
      reg.registerHandler('wsMessage', () => onMessage);

      const manifest: AppManifest = {
        ...minimalManifest,
        ws: {
          endpoints: {
            '/ws/chat': {
              on: {
                open: { handler: 'wsOpen' },
                message: { handler: 'wsMessage' },
              },
            },
          },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      const ep = config.ws?.endpoints['/ws/chat'];
      expect(ep?.on?.open).toBe(onOpen);
      expect(ep?.on?.message).toBe(onMessage);
    });

    it('resolves redis ws.transport from manifest config', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        ws: {
          transport: {
            type: 'redis',
            options: {
              connection: 'redis://127.0.0.1:6379',
              channelPrefix: 'ws:test:',
            },
          },
          endpoints: {
            '/ws/chat': {},
          },
        },
      };

      const config = manifestToAppConfig(manifest);
      expect(config.ws?.transport).toBeDefined();
      expect(typeof config.ws?.transport?.publish).toBe('function');
      expect(typeof config.ws?.transport?.connect).toBe('function');
      expect(typeof config.ws?.transport?.disconnect).toBe('function');
    });

    it('throws when redis ws.transport is missing options.connection', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        ws: {
          transport: {
            type: 'redis',
            options: {
              channelPrefix: 'ws:test:',
            },
          },
          endpoints: {
            '/ws/chat': {},
          },
        },
      };

      expect(() => manifestToAppConfig(manifest)).toThrow(
        '[manifestToAppConfig] ws.transport.type "redis" requires options.connection.',
      );
    });

    it('resolves ws endpoint upgrade handler ref (lines 206-211)', () => {
      const reg = createManifestHandlerRegistry();
      const upgradeFn = async () => undefined;
      reg.registerHandler('wsUpgrade', () => upgradeFn);

      const manifest: AppManifest = {
        ...minimalManifest,
        ws: {
          endpoints: {
            '/ws/chat': {
              upgrade: { handler: 'wsUpgrade' },
            },
          },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      const ep = config.ws?.endpoints['/ws/chat'];
      expect(ep?.upgrade).toBe(upgradeFn);
    });

    it('resolves ws endpoint onRoomSubscribe handler ref (lines 216-221)', () => {
      const reg = createManifestHandlerRegistry();
      const onRoomSubscribeFn = () => true;
      reg.registerHandler('wsRoomSub', () => onRoomSubscribeFn);

      const manifest: AppManifest = {
        ...minimalManifest,
        ws: {
          endpoints: {
            '/ws/chat': {
              onRoomSubscribe: { handler: 'wsRoomSub' },
            },
          },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      const ep = config.ws?.endpoints['/ws/chat'];
      expect(ep?.onRoomSubscribe).toBe(onRoomSubscribeFn);
    });
  });

  describe('SSE endpoint handler resolution', () => {
    it('resolves sse endpoint handlers via registry', () => {
      const reg = createManifestHandlerRegistry();
      const upgradeHandler = (req: Request) => {
        void req;
        return Promise.resolve({
          id: '1',
          actor: ANONYMOUS_ACTOR,
          requestTenantId: null,
          endpoint: '/sse/events',
        });
      };
      reg.registerHandler('sseUpgrade', () => upgradeHandler);

      const manifest: AppManifest = {
        ...minimalManifest,
        sse: {
          endpoints: {
            '/__sse/events': {
              events: ['entity:user.created'],
              upgrade: { handler: 'sseUpgrade' },
            },
          },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      const ep = config.sse?.endpoints['/__sse/events'];
      expect(ep?.upgrade).toBe(upgradeHandler);
      expect(ep?.events).toEqual(['entity:user.created']);
    });

    it('resolves sse endpoint filter handler via registry', () => {
      const reg = createManifestHandlerRegistry();
      const filterFn = () => true;
      reg.registerHandler('sseFilter', () => filterFn);

      const manifest: AppManifest = {
        ...minimalManifest,
        sse: {
          endpoints: {
            '/__sse/events': {
              events: ['entity:user.created'],
              filter: { handler: 'sseFilter' },
            },
          },
        },
      };
      const config = manifestToAppConfig(manifest, reg);
      const ep = config.sse?.endpoints['/__sse/events'];
      expect(ep?.filter).toBe(filterFn);
    });
  });

  describe('TLS resolution (lines 93-101)', () => {
    it('resolves tls with keyPath and certPath from files', () => {
      const tmpDir = tmpdir();
      const keyPath = join(tmpDir, 'test-tls.key');
      const certPath = join(tmpDir, 'test-tls.cert');
      writeFileSync(keyPath, 'fake-key-content');
      writeFileSync(certPath, 'fake-cert-content');

      const manifest = unsafeManifest({
        ...minimalManifest,
        tls: { keyPath, certPath },
      });
      const config = manifestToAppConfig(manifest);
      expect((config.tls as Record<string, unknown>)?.key).toBe('fake-key-content');
      expect((config.tls as Record<string, unknown>)?.cert).toBe('fake-cert-content');
    });

    it('resolves tls with caPath from file', () => {
      const tmpDir = tmpdir();
      const caPath = join(tmpDir, 'test-tls.ca');
      writeFileSync(caPath, 'fake-ca-content');

      const manifest = unsafeManifest({
        ...minimalManifest,
        tls: { caPath },
      });
      const config = manifestToAppConfig(manifest);
      expect((config.tls as Record<string, unknown>)?.ca).toBe('fake-ca-content');
    });
  });

  describe('SSM secrets provider (lines 159-161)', () => {
    it('ssm provider resolves without registry', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        secrets: { provider: 'ssm', pathPrefix: '/myapp/', region: 'us-east-1' },
      });
      const config = manifestToAppConfig(manifest);
      expect(config.secrets).toBeDefined();
    });
  });

  describe('local and s3 storage adapters (lines 206-221)', () => {
    it('resolves local storage adapter', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        upload: {
          storage: { adapter: 'local', config: { directory: '/tmp/uploads' } },
        },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.upload?.storage).toBeDefined();
    });

    it('resolves s3 storage adapter', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        upload: {
          storage: { adapter: 's3', config: { bucket: 'my-bucket', region: 'us-east-1' } },
        },
      };
      const config = manifestToAppConfig(manifest);
      expect(config.upload?.storage).toBeDefined();
    });
  });

  describe('upload.authorization.authorize string strategy (lines 484-487)', () => {
    it('resolves authorize string strategy "owner"', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        upload: {
          storage: { adapter: 'memory' },
          authorization: { authorize: 'owner' },
        },
      };
      const config = manifestToAppConfig(manifest);
      expect(typeof config.upload?.authorization?.authorize).toBe('function');
    });

    it('resolves authorize string strategy "authenticated"', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        upload: {
          storage: { adapter: 'memory' },
          authorization: { authorize: 'authenticated' },
        },
      };
      const config = manifestToAppConfig(manifest);
      expect(typeof config.upload?.authorization?.authorize).toBe('function');
    });

    it('resolves authorize string strategy "public"', () => {
      const manifest: AppManifest = {
        ...minimalManifest,
        upload: {
          storage: { adapter: 'memory' },
          authorization: { authorize: 'public' },
        },
      };
      const config = manifestToAppConfig(manifest);
      expect(typeof config.upload?.authorization?.authorize).toBe('function');
    });
  });

  describe('ws.transport missing options object (line 243)', () => {
    it('throws when ws.transport has type redis but options is not an object', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        ws: {
          transport: { type: 'redis', options: null },
          endpoints: { '/ws': {} },
        },
      });
      expect(() => manifestToAppConfig(manifest)).toThrow(
        '[manifestToAppConfig] ws.transport.type "redis" requires an options object.',
      );
    });
  });

  describe('security.rateLimit handler ref paths (lines 331-366)', () => {
    it('resolves rateLimit = false (line 331)', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        security: { rateLimit: false },
      });
      const config = manifestToAppConfig(manifest);
      expect((config.security as Record<string, unknown>)?.rateLimit).toBe(false);
    });

    it('resolves rateLimit.keyGenerator as string strategy (line 346-349)', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        security: { rateLimit: { windowMs: 60000, max: 100, keyGenerator: 'ip' } },
      });
      const config = manifestToAppConfig(manifest);
      const rl = (config.security as Record<string, unknown>)?.rateLimit as Record<string, unknown>;
      expect(typeof rl?.keyGenerator).toBe('function');
    });

    it('resolves rateLimit.keyGenerator as HandlerRef (lines 350-355)', () => {
      const reg = createManifestHandlerRegistry();
      const keyFn = () => 'key';
      reg.registerHandler('myKeyGen', () => keyFn);

      const manifest = unsafeManifest({
        ...minimalManifest,
        security: {
          rateLimit: {
            windowMs: 60000,
            max: 100,
            keyGenerator: { handler: 'myKeyGen' },
          },
        },
      });
      const config = manifestToAppConfig(manifest, reg);
      const rl = (config.security as Record<string, unknown>)?.rateLimit as Record<string, unknown>;
      expect(rl?.keyGenerator).toBe(keyFn);
    });

    it('resolves rateLimit.skip as string strategy (lines 358-359)', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        security: { rateLimit: { windowMs: 60000, max: 100, skip: 'authenticated' } },
      });
      const config = manifestToAppConfig(manifest);
      const rl = (config.security as Record<string, unknown>)?.rateLimit as Record<string, unknown>;
      expect(typeof rl?.skip).toBe('function');
    });

    it('resolves rateLimit.skip as HandlerRef (lines 360-361)', () => {
      const reg = createManifestHandlerRegistry();
      const skipFn = () => false;
      reg.registerHandler('mySkip', () => skipFn);

      const manifest = unsafeManifest({
        ...minimalManifest,
        security: {
          rateLimit: {
            windowMs: 60000,
            max: 100,
            skip: { handler: 'mySkip' },
          },
        },
      });
      const config = manifestToAppConfig(manifest, reg);
      const rl = (config.security as Record<string, unknown>)?.rateLimit as Record<string, unknown>;
      expect(rl?.skip).toBe(skipFn);
    });

    it('resolves rateLimit.handler as HandlerRef (lines 364-366)', () => {
      const reg = createManifestHandlerRegistry();
      const handlerFn = () => {};
      reg.registerHandler('myRlHandler', () => handlerFn);

      const manifest = unsafeManifest({
        ...minimalManifest,
        security: {
          rateLimit: {
            windowMs: 60000,
            max: 100,
            handler: { handler: 'myRlHandler' },
          },
        },
      });
      const config = manifestToAppConfig(manifest, reg);
      const rl = (config.security as Record<string, unknown>)?.rateLimit as Record<string, unknown>;
      expect(rl?.handler).toBe(handlerFn);
    });
  });

  describe('middleware array resolution (lines 376-379)', () => {
    it('resolves middleware array of HandlerRefs', () => {
      const reg = createManifestHandlerRegistry();
      const mw1 = () => {};
      const mw2 = () => {};
      reg.registerHandler('mw1', () => mw1);
      reg.registerHandler('mw2', () => mw2);

      const manifest: AppManifest = {
        ...minimalManifest,
        middleware: [{ handler: 'mw1' }, { handler: 'mw2' }],
      };
      const config = manifestToAppConfig(manifest, reg);
      expect(Array.isArray(config.middleware)).toBe(true);
      expect((config.middleware as unknown[])?.[0]).toBe(mw1);
      expect((config.middleware as unknown[])?.[1]).toBe(mw2);
    });
  });

  describe('observability tracing (lines 555-562)', () => {
    it('maps observability.tracing to config', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        observability: {
          tracing: { enabled: true, serviceName: 'my-service' },
        },
      });
      const config = manifestToAppConfig(manifest);
      expect((config as Record<string, unknown>).observability).toEqual({
        tracing: { enabled: true, serviceName: 'my-service' },
      });
    });

    it('maps observability without tracing to empty tracing', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        observability: {},
      });
      const config = manifestToAppConfig(manifest);
      expect((config as Record<string, unknown>).observability).toEqual({
        tracing: undefined,
      });
    });
  });

  describe('permissions field copy', () => {
    it('copies permissions section directly', () => {
      const manifest = unsafeManifest({
        ...minimalManifest,
        permissions: { roles: ['admin', 'user'] },
      });
      const config = manifestToAppConfig(manifest);
      expect((config as Record<string, unknown>).permissions).toEqual({ roles: ['admin', 'user'] });
    });
  });
});
