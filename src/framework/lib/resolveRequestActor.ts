import {
  ANONYMOUS_ACTOR,
  type Actor,
  type RequestActorResolver,
} from '@lastshotlabs/slingshot-core';

export async function resolveRequestActor(
  req: Request,
  resolver: RequestActorResolver | null,
): Promise<Actor> {
  if (!resolver) return ANONYMOUS_ACTOR;
  return resolver.resolveActor(req);
}
