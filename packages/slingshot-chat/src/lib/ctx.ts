/**
 * Read the framework-injected actor ID from an operation's `params`
 * record. Throws if missing — the route layer is required to have run
 * `slingshot-auth`'s middleware before this point, so a missing value is
 * a programmer error, not a 4xx.
 */
export function getUserId(params: Record<string, unknown>): string {
  const id = params['actor.id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('actor.id missing from operation params — is slingshot-auth wired?');
  }
  return id;
}
