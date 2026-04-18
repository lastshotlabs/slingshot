import { describe, expect, it } from 'bun:test';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import type { ManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';

describe('createManifestHandlerRegistry', () => {
  it('returns a fresh registry on each call', () => {
    const r1 = createManifestHandlerRegistry();
    const r2 = createManifestHandlerRegistry();
    r1.registerHandler('foo', () => 'from-r1');
    expect(r2.hasHandler('foo')).toBe(false);
  });

  describe('handler bucket', () => {
    it('registers and resolves a handler', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHandler('myFn', () => 'result');
      expect(reg.resolveHandler('myFn')).toBe('result');
    });

    it('passes params to the factory', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHandler('withParams', params => params?.['value']);
      expect(reg.resolveHandler('withParams', { value: 42 })).toBe(42);
    });

    it('hasHandler returns true when registered', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHandler('h', () => null);
      expect(reg.hasHandler('h')).toBe(true);
    });

    it('hasHandler returns false when not registered', () => {
      const reg = createManifestHandlerRegistry();
      expect(reg.hasHandler('missing')).toBe(false);
    });

    it('throws with name and registered list for unknown handler', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHandler('known', () => null);
      expect(() => reg.resolveHandler('unknown')).toThrow(
        '[ManifestHandlerRegistry] Unknown handler "unknown". Registered: [known]',
      );
    });
  });

  describe('plugin bucket', () => {
    it('registers and resolves a plugin', () => {
      const reg = createManifestHandlerRegistry();
      const plugin = { name: 'test-plugin' } as never;
      reg.registerPlugin('my-plugin', () => plugin);
      expect(reg.resolvePlugin('my-plugin')).toBe(plugin);
    });

    it('passes config to the factory', () => {
      const reg = createManifestHandlerRegistry();
      let received: Record<string, unknown> | undefined;
      reg.registerPlugin('p', config => {
        received = config;
        return {} as never;
      });
      reg.resolvePlugin('p', { posture: 'web-saas' });
      expect(received).toEqual({ posture: 'web-saas' });
    });

    it('hasPlugin returns true when registered', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerPlugin('p', () => ({}) as never);
      expect(reg.hasPlugin('p')).toBe(true);
    });

    it('hasPlugin returns false when not registered', () => {
      const reg = createManifestHandlerRegistry();
      expect(reg.hasPlugin('p')).toBe(false);
    });

    it('throws with name and registered list for unknown plugin', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerPlugin('known-plugin', () => ({}) as never);
      expect(() => reg.resolvePlugin('unknown-plugin')).toThrow(
        '[ManifestHandlerRegistry] Unknown plugin "unknown-plugin". Registered: [known-plugin]',
      );
    });
  });

  describe('event bus bucket', () => {
    it('registers and resolves an event bus', () => {
      const reg = createManifestHandlerRegistry();
      const bus = { on: () => {} } as never;
      reg.registerEventBus('redis', () => bus);
      expect(reg.resolveEventBus('redis')).toBe(bus);
    });

    it('hasEventBus returns true when registered', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerEventBus('redis', () => ({}) as never);
      expect(reg.hasEventBus('redis')).toBe(true);
    });

    it('hasEventBus returns false when not registered', () => {
      const reg = createManifestHandlerRegistry();
      expect(reg.hasEventBus('redis')).toBe(false);
    });

    it('throws with name and registered list for unknown bus', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerEventBus('redis', () => ({}) as never);
      expect(() => reg.resolveEventBus('unknown-bus')).toThrow(
        '[ManifestHandlerRegistry] Unknown event bus "unknown-bus". Registered: [redis]',
      );
    });
  });

  describe('secret provider bucket', () => {
    it('registers and resolves a secret provider', () => {
      const reg = createManifestHandlerRegistry();
      const repo = { get: async () => null } as never;
      reg.registerSecretProvider('vault', () => repo);
      expect(reg.resolveSecretProvider('vault', {})).toBe(repo);
    });

    it('passes config to the factory', () => {
      const reg = createManifestHandlerRegistry();
      let received: Record<string, unknown> | undefined;
      reg.registerSecretProvider('custom', config => {
        received = config;
        return {} as never;
      });
      reg.resolveSecretProvider('custom', { endpoint: 'https://vault.example.com' });
      expect(received).toEqual({ endpoint: 'https://vault.example.com' });
    });

    it('throws with name and registered list for unknown provider', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerSecretProvider('vault', () => ({}) as never);
      expect(() => reg.resolveSecretProvider('unknown-provider', {})).toThrow(
        '[ManifestHandlerRegistry] Unknown secret provider "unknown-provider". Registered: [vault]',
      );
    });
  });

  describe('hook bucket', () => {
    it('registers and resolves a hook', () => {
      const reg = createManifestHandlerRegistry();
      const hook = () => {};
      reg.registerHook('afterAdapters', hook);
      expect(reg.resolveHook('afterAdapters')).toBe(hook);
    });

    it('hasHook returns true when registered', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHook('myHook', () => {});
      expect(reg.hasHook('myHook')).toBe(true);
    });

    it('hasHook returns false when not registered', () => {
      const reg = createManifestHandlerRegistry();
      expect(reg.hasHook('missing')).toBe(false);
    });

    it('throws with name and registered list for unknown hook', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHook('known-hook', () => {});
      expect(() => reg.resolveHook('unknown-hook')).toThrow(
        '[ManifestHandlerRegistry] Unknown hook "unknown-hook". Registered: [known-hook]',
      );
    });
  });

  describe('isolation between instances', () => {
    it('two instances are fully independent', () => {
      const r1 = createManifestHandlerRegistry();
      const r2 = createManifestHandlerRegistry();

      r1.registerHandler('h', () => 'r1');
      r1.registerPlugin('p', () => ({}) as never);
      r1.registerEventBus('bus', () => ({}) as never);
      r1.registerSecretProvider('sp', () => ({}) as never);
      r1.registerHook('hook', () => {});

      expect(r2.hasHandler('h')).toBe(false);
      expect(r2.hasPlugin('p')).toBe(false);
      expect(() => r2.resolveEventBus('bus')).toThrow();
      expect(() => r2.resolveSecretProvider('sp', {})).toThrow();
      expect(r2.hasHook('hook')).toBe(false);
    });
  });
});
