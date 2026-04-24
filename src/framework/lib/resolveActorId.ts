import type { RequestActorResolver } from '@lastshotlabs/slingshot-core';

export async function resolveActorId(
  req: Request,
  resolver: RequestActorResolver | null,
): Promise<string | null> {
  if (!resolver) return null;
  return resolver.resolveActorId(req);
}
