/**
 * AWS Systems Manager Parameter Store secret repository.
 *
 * Batch-loads parameters by path prefix on initialize(), caches locally.
 * Lazy SDK import — @aws-sdk/client-ssm is only loaded when this repository is used.
 *
 * Factory pattern: closure-owned cache + client, no module-level state.
 */
import type { SecretRepository } from '@lastshotlabs/slingshot-core';

export interface SsmProviderOptions {
  /** SSM path prefix, e.g., '/myapp/prod/' — must end with '/' */
  pathPrefix: string;
  /** AWS region. Defaults to AWS_REGION env var or 'us-east-1'. */
  region?: string;
  /** Cache TTL in milliseconds. Default: 300_000 (5 min). */
  cacheTtlMs?: number;
  /** Whether to decrypt SecureString params. Default: true. */
  withDecryption?: boolean;
}

/**
 * Create a `SecretRepository` that reads parameters from AWS Systems Manager
 * Parameter Store.
 *
 * All parameters under `pathPrefix` are batch-loaded during `initialize()` and
 * stored in a closure-owned cache with a configurable TTL. After the cache
 * warms, individual `get()` / `getMany()` calls are served from memory.
 * Cache misses fall back to individual `GetParameter` / `GetParameters` SSM
 * API calls.
 *
 * The `@aws-sdk/client-ssm` package is imported lazily via a dynamic
 * `import()` expression so it is never loaded unless this repository is
 * actually used, keeping the framework's bundle lean.
 *
 * @param opts - Configuration options.
 * @param opts.pathPrefix - The SSM path prefix, e.g. `'/myapp/prod/'`. Must
 *   end with `/`. All parameters under this prefix are loaded on `initialize()`.
 * @param opts.region - AWS region. Defaults to the `AWS_REGION` environment
 *   variable, then `'us-east-1'`.
 * @param opts.cacheTtlMs - Cache TTL in milliseconds. Defaults to `300_000`
 *   (5 minutes). Setting to `0` disables caching (a new SDK call is made on
 *   every `get()` after the cache entry expires).
 * @param opts.withDecryption - Whether to decrypt `SecureString` parameters.
 *   Defaults to `true`.
 * @returns A `SecretRepository` named `'ssm'` with `initialize()`, `refresh()`,
 *   and `destroy()` lifecycle methods.
 * @throws `Error('SSM secret repository requires @aws-sdk/client-ssm to be installed')`
 *   if `@aws-sdk/client-ssm` is not available at runtime.
 *
 * @example
 * const repo = createSsmSecretRepository({
 *   pathPrefix: '/myapp/prod/',
 *   region: 'eu-west-1',
 * });
 * await repo.initialize?.();
 * const jwtSecret = await repo.get('JWT_SECRET'); // reads '/myapp/prod/JWT_SECRET'
 */
export function createSsmSecretRepository(opts: SsmProviderOptions): SecretRepository {
  const { pathPrefix, region, withDecryption = true } = opts;
  const cacheTtl = opts.cacheTtlMs ?? 300_000;

  interface SsmModule {
    SSMClient: new (config: { region: string }) => SsmClient;
    GetParametersByPathCommand: new (input: object) => unknown;
    GetParameterCommand: new (input: object) => unknown;
    GetParametersCommand: new (input: object) => unknown;
  }

  interface SsmClient {
    send(command: unknown): Promise<SsmResponse>;
  }

  interface SsmResponse {
    Parameters?: Array<{ Name?: string; Value?: string }>;
    Parameter?: { Value?: string };
    NextToken?: string;
  }

  // Closure-owned state — no module globals
  const cache = new Map<string, { value: string; expiresAt: number }>();
  let ssmClient: SsmClient | null = null;

  /**
   * Dynamically import `@aws-sdk/client-ssm`, throwing a descriptive error if
   * the package is not installed.
   *
   * @returns The `@aws-sdk/client-ssm` module exports.
   * @throws `Error` if `@aws-sdk/client-ssm` is not installed.
   */
  async function requireSsm(): Promise<SsmModule> {
    try {
      return (await import('@aws-sdk/client-ssm')) as unknown as SsmModule;
    } catch {
      throw new Error('SSM secret repository requires @aws-sdk/client-ssm to be installed');
    }
  }

  async function getClient(): Promise<SsmClient> {
    if (ssmClient) return ssmClient;
    const { SSMClient } = await requireSsm();
    ssmClient = new SSMClient({ region: region ?? process.env.AWS_REGION ?? 'us-east-1' });
    return ssmClient;
  }

  /**
   * Strip the SSM path prefix from a full parameter name to produce the
   * logical secret key.
   *
   * @param name - The full SSM parameter name (e.g. `'/myapp/prod/JWT_SECRET'`).
   * @returns The logical key (`'JWT_SECRET'`), or `name` unchanged if it does
   *   not start with `pathPrefix`.
   */
  function stripPrefix(name: string): string {
    return name.startsWith(pathPrefix) ? name.slice(pathPrefix.length) : name;
  }

  /**
   * Retrieve a cached secret value, evicting the entry if it has expired.
   *
   * @param key - The logical secret key.
   * @returns The cached value string if present and unexpired, or `null` if
   *   absent or expired (the entry is deleted on expiry).
   */
  function getCached(key: string): string | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Store a secret value in the cache with an expiry timestamp derived from
   * the configured `cacheTtlMs`.
   *
   * @param key - The logical secret key.
   * @param value - The secret value to cache.
   */
  function setCache(key: string, value: string): void {
    cache.set(key, { value, expiresAt: Date.now() + cacheTtl });
  }

  return {
    name: 'ssm',

    async initialize() {
      const client = await getClient();
      const { GetParametersByPathCommand } = await requireSsm();

      let nextToken: string | undefined;
      do {
        const cmd = new GetParametersByPathCommand({
          Path: pathPrefix,
          Recursive: true,
          WithDecryption: withDecryption,
          NextToken: nextToken,
        });
        const resp = await client.send(cmd);
        for (const param of resp.Parameters ?? []) {
          if (param.Name && param.Value) {
            setCache(stripPrefix(param.Name), param.Value);
          }
        }
        nextToken = resp.NextToken;
      } while (nextToken);
    },

    async get(key) {
      const cached = getCached(key);
      if (cached !== null) return cached;

      const client = await getClient();
      const { GetParameterCommand } = await requireSsm();
      try {
        const cmd = new GetParameterCommand({
          Name: pathPrefix + key,
          WithDecryption: withDecryption,
        });
        const resp = await client.send(cmd);
        const value = resp.Parameter?.Value ?? null;
        if (value !== null) setCache(key, value);
        return value;
      } catch (err: unknown) {
        if ((err as { name?: string }).name === 'ParameterNotFound') return null;
        throw err;
      }
    },

    async getMany(keys) {
      const result = new Map<string, string>();
      const uncached: string[] = [];

      for (const key of keys) {
        const cached = getCached(key);
        if (cached !== null) {
          result.set(key, cached);
        } else {
          uncached.push(key);
        }
      }

      if (uncached.length > 0) {
        const client = await getClient();
        const { GetParametersCommand } = await requireSsm();

        // GetParameters supports max 10 names per call
        for (let i = 0; i < uncached.length; i += 10) {
          const batch = uncached.slice(i, i + 10);
          const cmd = new GetParametersCommand({
            Names: batch.map(k => pathPrefix + k),
            WithDecryption: withDecryption,
          });
          const resp = await client.send(cmd);
          for (const param of resp.Parameters ?? []) {
            if (param.Name && param.Value) {
              const key = stripPrefix(param.Name);
              setCache(key, param.Value);
              result.set(key, param.Value);
            }
          }
        }
      }

      return result;
    },

    async refresh() {
      cache.clear();
      await this.initialize?.();
    },

    destroy() {
      cache.clear();
      ssmClient = null;
      return Promise.resolve();
    },
  };
}
