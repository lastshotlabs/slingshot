import { describe, expect, it } from 'bun:test';
import { getOrganizationsAuthRuntime } from '../../src/lib/authRuntime';

function fakeAuthAdapter() {
  return {
    getUser: async (id: string) => ({ id, email: `${id}@test.com` }),
    getEmailVerified: async (id: string) => true,
  };
}

describe('getOrganizationsAuthRuntime', () => {
  it('returns runtime when PluginStateMap has a valid auth runtime', () => {
    const adapter = fakeAuthAdapter();
    const state = new Map([['slingshot-auth', { adapter }]]);
    const runtime = getOrganizationsAuthRuntime(state);
    expect(runtime.adapter).toBe(adapter);
  });

  it('throws when passed null', () => {
    expect(() => getOrganizationsAuthRuntime(null)).toThrow(
      'auth runtime context is not available',
    );
  });

  it('throws when passed undefined', () => {
    expect(() => getOrganizationsAuthRuntime(undefined)).toThrow(
      'auth runtime context is not available',
    );
  });

  it('throws when PluginStateMap lacks auth runtime entry', () => {
    const state = new Map([['other-plugin', {}]]);
    expect(() => getOrganizationsAuthRuntime(state)).toThrow(
      'auth runtime context is not available',
    );
  });

  it('throws when auth runtime value is missing adapter property', () => {
    const state = new Map([['slingshot-auth', { notAdapter: true }]]);
    expect(() => getOrganizationsAuthRuntime(state)).toThrow(
      'auth runtime context is not available',
    );
  });

  it('throws when auth runtime adapter is null', () => {
    const state = new Map([['slingshot-auth', { adapter: null }]]);
    expect(() => getOrganizationsAuthRuntime(state)).toThrow(
      'auth runtime context is not available',
    );
  });

  it('throws when auth runtime is not an object', () => {
    const state = new Map([['slingshot-auth', 'not-an-object']]);
    expect(() => getOrganizationsAuthRuntime(state)).toThrow(
      'auth runtime context is not available',
    );
  });

  it('passes through adapter that only has getUser and getEmailVerified', () => {
    const adapter = {
      getUser: async (id: string) => ({ id }),
      getEmailVerified: async (id: string) => true,
    };
    const state = new Map([['slingshot-auth', { adapter }]]);
    const runtime = getOrganizationsAuthRuntime(state);
    expect(runtime.adapter.getUser).toBe(adapter.getUser);
    expect(runtime.adapter.getEmailVerified).toBe(adapter.getEmailVerified);
  });

  it('accepts adapter with extra properties beyond getUser and getEmailVerified', () => {
    const adapter = {
      getUser: async (id: string) => ({ id }),
      getEmailVerified: async (id: string) => true,
      extraMethod: () => {},
      extraProp: 42,
    };
    const state = new Map([['slingshot-auth', { adapter }]]);
    const runtime = getOrganizationsAuthRuntime(state);
    expect(runtime.adapter.getUser).toBe(adapter.getUser);
  });

  it('accepts adapter missing getUser at runtime (type system enforces at compile time)', () => {
    const adapter = { getEmailVerified: async () => true };
    const state = new Map([['slingshot-auth', { adapter }]]);
    // The runtime guard only validates that adapter is a non-null object.
    // Callers rely on TypeScript to enforce the OrganizationsAuthAdapter shape.
    const runtime = getOrganizationsAuthRuntime(state);
    expect(runtime.adapter).toBe(adapter);
  });
});
