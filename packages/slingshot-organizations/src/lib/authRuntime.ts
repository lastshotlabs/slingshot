import type { AuthAdapter, PluginStateCarrier, PluginStateMap } from '@lastshotlabs/slingshot-core';
import { resolvePluginState } from '@lastshotlabs/slingshot-core';

type OrganizationsAuthAdapter = Pick<AuthAdapter, 'getUser' | 'getEmailVerified'>;

export interface OrganizationsAuthRuntime {
  readonly adapter: OrganizationsAuthAdapter;
}

function isOrganizationsAuthRuntime(value: unknown): value is OrganizationsAuthRuntime {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return 'adapter' in value && typeof value.adapter === 'object' && value.adapter !== null;
}

export function getOrganizationsAuthRuntime(
  input: PluginStateMap | PluginStateCarrier | null | undefined,
): OrganizationsAuthRuntime {
  const pluginState = resolvePluginState(input);
  const runtime = pluginState?.get('slingshot-auth');
  if (!isOrganizationsAuthRuntime(runtime)) {
    throw new Error(
      '[slingshot-organizations] auth runtime context is not available in pluginState',
    );
  }
  return runtime;
}
