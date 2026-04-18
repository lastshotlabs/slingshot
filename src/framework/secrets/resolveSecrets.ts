/**
 * Secret resolution — validates a SecretSchema against an SecretRepository
 * and returns a frozen, typed object of resolved secret values.
 *
 * Called once at startup before database connections are established.
 */
import type { ResolvedSecrets, SecretRepository, SecretSchema } from '@lastshotlabs/slingshot-core';

/**
 * Resolve all secrets declared in a schema from the given repository.
 *
 * 1. Calls repository.initialize() if present (batch prefetch).
 * 2. Batch-fetches all declared paths via repository.getMany().
 * 3. Validates required secrets are present, applies defaults.
 * 4. Returns a frozen object keyed by schema field names.
 *
 * Throws at startup if a required secret is missing — fail-fast, not at first use.
 */
export async function resolveSecrets<S extends SecretSchema>(
  repository: SecretRepository,
  schema: S,
): Promise<ResolvedSecrets<S>> {
  await repository.initialize?.();

  const paths = Object.values(schema).map(def => def.path);
  const values = await repository.getMany(paths);

  const result: Record<string, string | undefined> = {};
  const missing: string[] = [];

  for (const [name, def] of Object.entries(schema)) {
    const value = values.get(def.path) ?? def.default;
    const isRequired = def.required !== false;

    if (value === undefined) {
      if (isRequired) {
        missing.push(`"${name}" (path: ${def.path})`);
      }
      result[name] = undefined;
    } else {
      result[name] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(`[secrets] Missing required secrets: ${missing.join(', ')}`);
  }

  return Object.freeze(result) as ResolvedSecrets<S>;
}
