/**
 * Secrets management — public API surface.
 *
 * Provides a pluggable secrets layer that resolves runtime credentials from one of
 * three built-in providers — environment variables, AWS SSM Parameter Store, or a
 * local JSON file — and exposes them as a typed `ResolvedSecretBundle`.
 *
 * **Resolution**
 * - {@link resolveSecrets} — resolve a set of named secret keys from a configured
 *   provider and return a plain `Record<string, string>`. Used internally by
 *   `createApp` to resolve the framework secret bundle at startup.
 * - {@link resolveSecretBundle} — resolve the full framework secret bundle
 *   (Redis, Mongo, etc.) from a `SecretStoreConfig`.
 * - {@link resolveSecretRepoFromInput} — resolve a `RegisteredSecretRepository`
 *   from a `SecretStoreInput` (config + optional infra).
 * - {@link resolveSecretRepo} — resolve a `RegisteredSecretRepository` directly
 *   from a `SecretStoreConfig`.
 * - {@link secretRepositoryFactories} — pre-built `RepoFactories` map for use
 *   with `resolveRepo` in custom secret storage scenarios.
 *
 * **Providers**
 * - {@link createEnvSecretRepository} — reads secrets from `process.env`.
 * - {@link createSsmSecretRepository} — reads secrets from AWS SSM Parameter Store.
 *   Requires `@aws-sdk/client-ssm` (`bun add @aws-sdk/client-ssm`).
 * - {@link createFileSecretRepository} — reads secrets from a local JSON file.
 *   Useful for local development and CI.
 *
 * **Schema**
 * - {@link frameworkSecretSchema} — Zod schema for the framework's own secret keys
 *   (Redis credentials, Mongo credentials, etc.). Used for validation at startup.
 *
 * **Types**
 * - `SecretStoreConfig` — discriminated union of all provider configs.
 * - `SecretStoreInput` — provider config plus optional resolved infra.
 * - `SecretStoreInfra` — infrastructure required by store-backed providers.
 * - `SecretRepoFactories` / `SecretRepositoryFactories` — factory maps.
 * - `ResolvedSecretBundle` — the fully resolved secret values object.
 * - `RegisteredSecretRepository` — a ready-to-use secret repository instance.
 * - `FrameworkSecretsLiteral` — literal union of all framework-defined secret keys.
 * - `EnvSecretStoreConfig`, `SsmSecretStoreConfig`, `FileSecretStoreConfig` —
 *   per-provider config shapes.
 *
 * @example
 * ```ts
 * import { resolveSecretBundle } from '@lastshotlabs/slingshot/secrets';
 *
 * const bundle = await resolveSecretBundle({ provider: 'env' });
 * // bundle.redisHost, bundle.mongoUser, etc.
 * ```
 */

export { resolveSecrets } from './resolveSecrets';
export { frameworkSecretSchema } from './frameworkSecretSchema';
export {
  resolveSecretBundle,
  resolveSecretRepoFromInput,
  resolveSecretRepo,
  secretRepositoryFactories,
} from './resolveSecretBundle';
export type {
  SecretStoreConfig,
  SecretRepositoryFactories,
  SecretStoreInput,
  SecretStoreInfra,
  SecretRepoFactories,
  ResolvedSecretBundle,
  RegisteredSecretRepository,
  FrameworkSecretsLiteral,
  EnvSecretStoreConfig,
  SsmSecretStoreConfig,
  FileSecretStoreConfig,
} from './resolveSecretBundle';
export { createEnvSecretRepository } from './providers/envProvider';
export { createSsmSecretRepository } from './providers/ssmProvider';
export type { SsmProviderOptions } from './providers/ssmProvider';
export { createFileSecretRepository } from './providers/fileProvider';
export type { FileProviderOptions } from './providers/fileProvider';
