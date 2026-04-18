import type { AuthAdapter, SlingshotContext } from '@lastshotlabs/slingshot-core';

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
  ctx: SlingshotContext | null | undefined,
): OrganizationsAuthRuntime {
  const runtime = ctx?.pluginState.get('slingshot-auth');
  if (!isOrganizationsAuthRuntime(runtime)) {
    throw new Error(
      '[slingshot-organizations] auth runtime context is not available on SlingshotContext',
    );
  }
  return runtime;
}
