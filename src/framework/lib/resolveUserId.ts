// src/framework/lib/resolveUserId.ts
import type { UserResolver } from '@lastshotlabs/slingshot-core';

export async function resolveUserId(
  req: Request,
  resolver: UserResolver | null,
): Promise<string | null> {
  if (!resolver) return null;
  return resolver.resolveUserId(req);
}
