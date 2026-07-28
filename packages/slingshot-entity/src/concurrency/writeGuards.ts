import {
  EntityConcurrencyPreconditionError,
  type EntityWriteOptions,
  type ResolvedEntityConfig,
  SlingshotError,
} from '@lastshotlabs/slingshot-core';

/** Validate write options and return the expected version, if one was supplied. */
export function resolveExpectedVersion(
  config: ResolvedEntityConfig,
  operation: 'update' | 'delete',
  options: EntityWriteOptions | undefined,
): number | undefined {
  const concurrency = config._concurrency;
  if (!concurrency) return undefined;

  const expectedVersion = options?.expectedVersion;
  if (expectedVersion === undefined) {
    if (concurrency.requiredOnWrite) {
      throw new EntityConcurrencyPreconditionError(config.name, operation);
    }
    return undefined;
  }

  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new SlingshotError(
      'ENTITY_CONCURRENCY_EXPECTED_VERSION_INVALID',
      `Expected version for ${operation} on "${config.name}" must be a positive safe integer`,
    );
  }
  return expectedVersion;
}
