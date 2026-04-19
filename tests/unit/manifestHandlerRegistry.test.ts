import { describe, expect, it } from 'bun:test';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';

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

    it('throws on duplicate handler registration', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHandler('dup', () => null);
      expect(() => reg.registerHandler('dup', () => null)).toThrow(
        '[ManifestHandlerRegistry] Duplicate handler "dup" registration. Registry names must be unique.',
      );
    });
  });

  describe('plugin bucket', () => {
    it('registers and resolves a plugin', () => {
      const reg = createManifestHandlerRegistry();
      const plugin: never = { name: 'test-plugin' } as never;
      reg.registerPlugin('my-plugin', () => plugin);
      expect(reg.resolvePlugin('my-plugin')).toBe(plugin);
    });

    it('passes config to the factory', () => {
      const reg = createManifestHandlerRegistry();
      let received: Record<string, unknown> | undefined;
      reg.registerPlugin('p', config => {
        received = config;
        const p: never = {} as never;
        return p;
      });
      reg.resolvePlugin('p', { posture: 'web-saas' });
      expect(received).toEqual({ posture: 'web-saas' });
    });

    it('hasPlugin returns true when registered', () => {
      const reg = createManifestHandlerRegistry();
      const fakePlugin: never = {} as never;
      reg.registerPlugin('p', () => fakePlugin);
      expect(reg.hasPlugin('p')).toBe(true);
    });

    it('hasPlugin returns false when not registered', () => {
      const reg = createManifestHandlerRegistry();
      expect(reg.hasPlugin('p')).toBe(false);
    });

    it('throws with name and registered list for unknown plugin', () => {
      const reg = createManifestHandlerRegistry();
      const knownPlugin: never = {} as never;
      reg.registerPlugin('known-plugin', () => knownPlugin);
      expect(() => reg.resolvePlugin('unknown-plugin')).toThrow(
        '[ManifestHandlerRegistry] Unknown plugin "unknown-plugin". Registered: [known-plugin]',
      );
    });

    it('throws on duplicate plugin registration', () => {
      const reg = createManifestHandlerRegistry();
      const fakePlugin: never = {} as never;
      reg.registerPlugin('dup-plugin', () => fakePlugin);
      expect(() => reg.registerPlugin('dup-plugin', () => fakePlugin)).toThrow(
        '[ManifestHandlerRegistry] Duplicate plugin "dup-plugin" registration. Registry names must be unique.',
      );
    });
  });

  describe('event bus bucket', () => {
    it('registers and resolves an event bus', () => {
      const reg = createManifestHandlerRegistry();
      const bus: never = { on: () => {} } as never;
      reg.registerEventBus('redis', () => bus);
      expect(reg.resolveEventBus('redis')).toBe(bus);
    });

    it('hasEventBus returns true when registered', () => {
      const reg = createManifestHandlerRegistry();
      const fakeBus: never = {} as never;
      reg.registerEventBus('redis', () => fakeBus);
      expect(reg.hasEventBus('redis')).toBe(true);
    });

    it('hasEventBus returns false when not registered', () => {
      const reg = createManifestHandlerRegistry();
      expect(reg.hasEventBus('redis')).toBe(false);
    });

    it('throws with name and registered list for unknown bus', () => {
      const reg = createManifestHandlerRegistry();
      const fakeBus2: never = {} as never;
      reg.registerEventBus('redis', () => fakeBus2);
      expect(() => reg.resolveEventBus('unknown-bus')).toThrow(
        '[ManifestHandlerRegistry] Unknown event bus "unknown-bus". Registered: [redis]',
      );
    });

    it('throws on duplicate event bus registration', () => {
      const reg = createManifestHandlerRegistry();
      const fakeBus: never = {} as never;
      reg.registerEventBus('dup-bus', () => fakeBus);
      expect(() => reg.registerEventBus('dup-bus', () => fakeBus)).toThrow(
        '[ManifestHandlerRegistry] Duplicate event bus "dup-bus" registration. Registry names must be unique.',
      );
    });
  });

  describe('secret provider bucket', () => {
    it('registers and resolves a secret provider', () => {
      const reg = createManifestHandlerRegistry();
      const repo: never = { get: async () => null } as never;
      reg.registerSecretProvider('vault', () => repo);
      expect(reg.resolveSecretProvider('vault', {})).toBe(repo);
    });

    it('passes config to the factory', () => {
      const reg = createManifestHandlerRegistry();
      let received: Record<string, unknown> | undefined;
      reg.registerSecretProvider('custom', config => {
        received = config;
        const sp: never = {} as never;
        return sp;
      });
      reg.resolveSecretProvider('custom', { endpoint: 'https://vault.example.com' });
      expect(received).toEqual({ endpoint: 'https://vault.example.com' });
    });

    it('throws with name and registered list for unknown provider', () => {
      const reg = createManifestHandlerRegistry();
      const fakeRepo: never = {} as never;
      reg.registerSecretProvider('vault', () => fakeRepo);
      expect(() => reg.resolveSecretProvider('unknown-provider', {})).toThrow(
        '[ManifestHandlerRegistry] Unknown secret provider "unknown-provider". Registered: [vault]',
      );
    });

    it('throws on duplicate secret provider registration', () => {
      const reg = createManifestHandlerRegistry();
      const fakeRepo: never = {} as never;
      reg.registerSecretProvider('vault', () => fakeRepo);
      expect(() => reg.registerSecretProvider('vault', () => fakeRepo)).toThrow(
        '[ManifestHandlerRegistry] Duplicate secret provider "vault" registration. Registry names must be unique.',
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

    it('throws on duplicate hook registration', () => {
      const reg = createManifestHandlerRegistry();
      reg.registerHook('dup-hook', () => {});
      expect(() => reg.registerHook('dup-hook', () => {})).toThrow(
        '[ManifestHandlerRegistry] Duplicate hook "dup-hook" registration. Registry names must be unique.',
      );
    });
  });

  describe('isolation between instances', () => {
    it('two instances are fully independent', () => {
      const r1 = createManifestHandlerRegistry();
      const r2 = createManifestHandlerRegistry();

      const neverVal: never = {} as never;
      r1.registerHandler('h', () => 'r1');
      r1.registerPlugin('p', () => neverVal);
      r1.registerEventBus('bus', () => neverVal);
      r1.registerSecretProvider('sp', () => neverVal);
      r1.registerHook('hook', () => {});

      expect(r2.hasHandler('h')).toBe(false);
      expect(r2.hasPlugin('p')).toBe(false);
      expect(() => r2.resolveEventBus('bus')).toThrow();
      expect(() => r2.resolveSecretProvider('sp', {})).toThrow();
      expect(r2.hasHook('hook')).toBe(false);
    });
  });
});
