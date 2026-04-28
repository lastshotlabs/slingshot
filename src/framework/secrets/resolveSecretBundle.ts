import type {
  ResolvedSecrets,
  SecretRepository,
  SecretSchema,
  SecretStoreType,
} from '@lastshotlabs/slingshot-core';
import { frameworkSecretSchema } from './frameworkSecretSchema';
import { createEnvSecretRepository } from './providers/envProvider';
import { resolveSecrets } from './resolveSecrets';

// ---------------------------------------------------------------------------
// Infrastructure for secret store resolution
// ---------------------------------------------------------------------------

/** Infrastructure options for secret store resolution — equivalent to StoreInfra */
export interface SecretStoreInfra {
  readonly prefix?: string; // env repository
  readonly pathPrefix?: string; // ssm repository
  readonly region?: string; // ssm repository
  readonly directory?: string; // file repository
  readonly extension?: string; // file repository
  readonly cacheTtlMs?: number; // ssm repository
  readonly withDecryption?: boolean; // ssm repository
}

export type SecretRepoFactories<T> = Record<
  SecretStoreType,
  (infra: SecretStoreInfra) => T | Promise<T>
>;

export function resolveSecretRepo<T>(
  factories: SecretRepoFactories<T>,
  storeType: SecretStoreType,
  infra: SecretStoreInfra,
): T | Promise<T> {
  return factories[storeType](infra);
}

// ---------------------------------------------------------------------------
// Config types for each store
// ---------------------------------------------------------------------------

export interface EnvSecretStoreConfig {
  provider: 'env';
  prefix?: string;
  schema?: SecretSchema;
}

export interface SsmSecretStoreConfig {
  provider: 'ssm';
  pathPrefix: string;
  region?: string;
  schema?: SecretSchema;
}

export interface FileSecretStoreConfig {
  provider: 'file';
  directory: string;
  schema?: SecretSchema;
}

export interface RegisteredSecretRepository {
  provider: SecretRepository;
  schema?: SecretSchema;
}

export type SecretStoreConfig = EnvSecretStoreConfig | SsmSecretStoreConfig | FileSecretStoreConfig;

/**
 * Plain object of secret values. The easiest way to pass secrets to the framework —
 * just provide the keys you need and TypeScript will guide you with autocomplete.
 *
 * Which keys are required depends on your `db` config:
 * - Always: `JWT_SECRET`, `SLINGSHOT_DATA_ENCRYPTION_KEY`
 * - `db.redis !== false` (default): `REDIS_HOST` required; `REDIS_USER`, `REDIS_PASSWORD` optional
 * - `db.mongo === 'single'` (default): `MONGO_URL`, or `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_HOST`, `MONGO_DB`
 * - `db.mongo === 'separate'`: above + `MONGO_AUTH_USER`, `MONGO_AUTH_PASSWORD`, `MONGO_AUTH_HOST`, `MONGO_AUTH_DB`
 *
 * You can also add any app-specific keys here — they'll be available via the secret provider at runtime.
 */
export interface FrameworkSecretsLiteral {
  /** Signs JWT access and refresh tokens. Required. */
  JWT_SECRET?: string;
  /** Encrypts sensitive data at rest (e.g. stored tokens). Required. */
  SLINGSHOT_DATA_ENCRYPTION_KEY?: string;
  /** Redis hostname. Required when `db.redis !== false` (default). */
  REDIS_HOST?: string;
  /** Redis username. Optional. */
  REDIS_USER?: string;
  /** Redis password. Optional. */
  REDIS_PASSWORD?: string;
  /** Comma-separated Kafka broker list. Optional. */
  KAFKA_BROKERS?: string;
  /** Kafka client identifier. Optional. */
  KAFKA_CLIENT_ID?: string;
  /** Kafka SASL username. Optional. */
  KAFKA_SASL_USERNAME?: string;
  /** Kafka SASL password. Optional. */
  KAFKA_SASL_PASSWORD?: string;
  /** Kafka SASL mechanism. Optional. */
  KAFKA_SASL_MECHANISM?: string;
  /** Whether default Kafka TLS is enabled. Optional. */
  KAFKA_SSL?: string;
  /** Full MongoDB connection URL. Can replace the individual single-mode MongoDB fields. */
  MONGO_URL?: string;
  /** MongoDB username. Required when `db.mongo !== false` (default). */
  MONGO_USER?: string;
  /** MongoDB password. Required when `db.mongo !== false` (default). */
  MONGO_PASSWORD?: string;
  /** MongoDB hostname. Required when `db.mongo !== false` (default). */
  MONGO_HOST?: string;
  /** MongoDB database name. Required when `db.mongo !== false` (default). */
  MONGO_DB?: string;
  /** MongoDB auth-db username. Required when `db.mongo === 'separate'`. */
  MONGO_AUTH_USER?: string;
  /** MongoDB auth-db password. Required when `db.mongo === 'separate'`. */
  MONGO_AUTH_PASSWORD?: string;
  /** MongoDB auth-db hostname. Required when `db.mongo === 'separate'`. */
  MONGO_AUTH_HOST?: string;
  /** MongoDB auth-db database name. Required when `db.mongo === 'separate'`. */
  MONGO_AUTH_DB?: string;
  /** Bearer token for machine-to-machine API access. Optional. */
  BEARER_TOKEN?: string;
  /** Any additional app-specific secret keys. */
  [key: string]: string | undefined;
}

export type SecretStoreInput =
  | SecretRepository
  | SecretStoreConfig
  | RegisteredSecretRepository
  | FrameworkSecretsLiteral
  | undefined;

type MergeSchemas<
  A extends SecretSchema,
  B extends SecretSchema | undefined,
> = B extends SecretSchema ? A & B : A;

type SecretRepoFactory<K extends SecretStoreType> = (
  config: Extract<SecretStoreConfig, { provider: K }>,
) => Promise<SecretRepository> | SecretRepository;

export type SecretRepositoryFactories = {
  [K in SecretStoreType]: SecretRepoFactory<K>;
};

export const secretRepositoryFactories: SecretRepositoryFactories = {
  env: config => createEnvSecretRepository({ prefix: config.prefix }),
  ssm: async config => {
    const { createSsmSecretRepository } = await import('./providers/ssmProvider');
    return createSsmSecretRepository({
      pathPrefix: config.pathPrefix,
      region: config.region,
    });
  },
  file: async config => {
    const { createFileSecretRepository } = await import('./providers/fileProvider');
    return createFileSecretRepository({ directory: config.directory });
  },
};

function createSecretRepositoryFromConfig(
  config: SecretStoreConfig,
): Promise<SecretRepository> | SecretRepository {
  switch (config.provider) {
    case 'env':
      return secretRepositoryFactories.env(config);
    case 'ssm':
      return secretRepositoryFactories.ssm(config);
    case 'file':
      return secretRepositoryFactories.file(config);
  }
}

export interface ResolvedSecretBundle<S extends SecretSchema | undefined = undefined> {
  readonly provider: SecretRepository;
  readonly framework: ResolvedSecrets<typeof frameworkSecretSchema>;
  readonly app: S extends SecretSchema ? ResolvedSecrets<S> : null;
  readonly merged: ResolvedSecrets<MergeSchemas<typeof frameworkSecretSchema, S>>;
}

function isSecretRepository(value: SecretStoreInput): value is SecretRepository {
  if (!value || typeof value !== 'object') return false;
  return 'name' in value && 'get' in value && 'getMany' in value;
}

function isRegisteredSecretRepository(
  value: SecretStoreInput,
): value is RegisteredSecretRepository {
  if (!value || typeof value !== 'object' || !('provider' in value)) return false;
  const provider = (value as { provider: unknown }).provider;
  return !!provider && isSecretRepository(provider as SecretRepository);
}

function isFrameworkSecretsLiteral(value: SecretStoreInput): value is FrameworkSecretsLiteral {
  if (!value || typeof value !== 'object') return false;
  if (isSecretRepository(value)) return false;
  if (isRegisteredSecretRepository(value)) return false;
  if ('provider' in value && typeof (value as { provider: unknown }).provider === 'string')
    return false;
  return true;
}

function createLiteralSecretRepository(literal: FrameworkSecretsLiteral): SecretRepository {
  return {
    name: 'literal',
    get(key) {
      return Promise.resolve(literal[key] ?? null);
    },
    getMany(keys) {
      const result = new Map<string, string>();
      for (const key of keys) {
        const val = literal[key];
        if (val !== undefined) result.set(key, val);
      }
      return Promise.resolve(result);
    },
  };
}

function getAppSecretSchema(input: SecretStoreInput): SecretSchema | undefined {
  if (!input || isSecretRepository(input)) return undefined;
  if (isRegisteredSecretRepository(input)) return input.schema;
  if (isFrameworkSecretsLiteral(input)) return undefined;
  return input.schema;
}

function mergeSecretSchemas<S extends SecretSchema | undefined>(
  frameworkSchema: typeof frameworkSecretSchema,
  appSchema: S,
): MergeSchemas<typeof frameworkSecretSchema, S> {
  if (!appSchema) {
    return frameworkSchema as unknown as MergeSchemas<typeof frameworkSecretSchema, S>;
  }
  return {
    ...frameworkSchema,
    ...appSchema,
  } as unknown as MergeSchemas<typeof frameworkSecretSchema, S>;
}

function pickResolvedSecrets<S extends SecretSchema>(
  resolved: Readonly<Record<string, string | undefined>>,
  schema: S,
): ResolvedSecrets<S> {
  const picked: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema)) {
    picked[key] = resolved[key];
  }
  return Object.freeze(picked) as ResolvedSecrets<S>;
}

export async function resolveSecretRepoFromInput(
  input: SecretStoreInput,
): Promise<SecretRepository> {
  if (!input) return createEnvSecretRepository();
  if (isSecretRepository(input)) return input;
  if (isRegisteredSecretRepository(input)) return input.provider;
  if (isFrameworkSecretsLiteral(input)) return createLiteralSecretRepository(input);

  return createSecretRepositoryFromConfig(input);
}

/**
 * Resolve a `SecretStoreInput` into a fully populated `ResolvedSecretBundle`.
 *
 * Performs the complete secret resolution pipeline:
 * 1. Resolves the input to a concrete `SecretRepository` via
 *    `resolveSecretRepoFromInput`.
 * 2. Extracts any app-specific `SecretSchema` from the input.
 * 3. Merges the framework schema and app schema into a combined schema.
 * 4. Calls `resolveSecrets(provider, mergedSchema)` to fetch all values.
 * 5. Returns a `ResolvedSecretBundle` with four properties:
 *    - `provider`: the concrete `SecretRepository` used for resolution.
 *    - `framework`: a frozen record of the framework's built-in secret values.
 *    - `app`: a frozen record of app-specific secret values, or `null` when no
 *      app schema was provided.
 *    - `merged`: a frozen record combining both framework and app secrets.
 *
 * @param input - Any `SecretStoreInput` value, or `undefined` for the default
 *   environment-variable provider.
 * @returns A `Promise<ResolvedSecretBundle<S>>` with all secrets resolved and
 *   segregated into framework, app, and merged views.
 * @throws If `resolveSecretRepoFromInput` throws (unsupported provider) or if
 *   the underlying provider's `getMany` / `get` rejects.
 */
export async function resolveSecretBundle<S extends SecretSchema | undefined = undefined>(
  input: SecretStoreInput,
): Promise<ResolvedSecretBundle<S>> {
  const provider = await resolveSecretRepoFromInput(input);
  const appSchema = getAppSecretSchema(input) as S;
  const mergedSchema = mergeSecretSchemas(frameworkSecretSchema, appSchema);
  const merged = await resolveSecrets(provider, mergedSchema);

  return {
    provider,
    framework: pickResolvedSecrets(merged, frameworkSecretSchema),
    app: (appSchema
      ? pickResolvedSecrets(merged, appSchema)
      : null) as ResolvedSecretBundle<S>['app'],
    merged,
  };
}
