import { describe, expect, test } from 'bun:test';
import {
  capabilityProviderKey,
  definePackageContract,
  provideCapability,
  registerPluginCapabilities,
  resolveCapabilityValue,
} from '../src/index';

describe('capabilityProviderKey — contract-scoped namespacing', () => {
  test('two contracts that pick the same capability name do not collide in capabilityProviders', async () => {
    const Assets = definePackageContract('slingshot-assets');
    const AssetsRuntimeCap = Assets.capability<{ kind: 'assets' }>('runtime');
    const Search = definePackageContract('slingshot-search');
    const SearchRuntimeCap = Search.capability<{ kind: 'search' }>('runtime');

    expect(capabilityProviderKey(AssetsRuntimeCap)).toBe('slingshot-assets:runtime');
    expect(capabilityProviderKey(SearchRuntimeCap)).toBe('slingshot-search:runtime');

    const pluginState = new Map<string, unknown>();
    const capabilityProviders = new Map<string, string>();

    await registerPluginCapabilities(
      { pluginState, capabilityProviders },
      'slingshot-assets',
      [provideCapability(AssetsRuntimeCap, () => ({ kind: 'assets' as const }))],
    );
    await registerPluginCapabilities(
      { pluginState, capabilityProviders },
      'slingshot-search',
      [provideCapability(SearchRuntimeCap, () => ({ kind: 'search' as const }))],
    );

    expect(resolveCapabilityValue({ pluginState, capabilityProviders }, AssetsRuntimeCap)).toEqual({
      kind: 'assets',
    });
    expect(resolveCapabilityValue({ pluginState, capabilityProviders }, SearchRuntimeCap)).toEqual({
      kind: 'search',
    });
  });
});
