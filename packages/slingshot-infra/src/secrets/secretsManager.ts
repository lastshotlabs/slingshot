import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformSecretsConfig } from '../types/platform';

/**
 * Result of a secrets presence check.
 */
export interface SecretsCheckResult {
  /** Keys that were found in the configured store. */
  found: string[];
  /** Keys that were not found (need to be pushed). */
  missing: string[];
}

/**
 * Interface for pushing, pulling, and checking secrets across different
 * provider backends (SSM, env vars, or files).
 */
export interface SecretsManager {
  /**
   * Read secrets from the local `.env` or `.env.<stageName>` file and push
   * them to the configured secrets store.
   *
   * @param appRoot - Absolute path to the app root (used to locate `.env` files).
   * @param requiredKeys - Keys to push. Keys missing from the `.env` file are skipped.
   * @returns The list of keys that were successfully pushed.
   */
  push(appRoot: string, requiredKeys: string[]): Promise<{ pushed: string[] }>;

  /**
   * Pull secrets from the configured store and write them to the local
   * `.env` or `.env.<stageName>` file.
   *
   * @param appRoot - Absolute path to the app root (used to locate/create `.env` files).
   * @param requiredKeys - Keys to pull from the store.
   * @returns The list of keys that were successfully pulled.
   */
  pull(appRoot: string, requiredKeys: string[]): Promise<{ pulled: string[] }>;

  /**
   * Check whether the required keys exist in the configured store.
   *
   * @param requiredKeys - Keys to verify.
   * @returns A `SecretsCheckResult` with `found` and `missing` arrays.
   */
  check(requiredKeys: string[]): Promise<SecretsCheckResult>;
}

/**
 * Create a `SecretsManager` backed by SSM Parameter Store, env vars, or the
 * local filesystem.
 *
 * The `'ssm'` provider uses AWS SSM SecureString parameters stored at
 * `<pathPrefix><stageName>/<key>`. The `'env'` provider reads from
 * `process.env` (check-only; push/pull are no-ops). The `'file'` provider
 * reads and writes to `<directory>/<key>` files.
 *
 * @param config - Secrets provider config from `DefinePlatformConfig.secrets`.
 * @param stageName - Stage used to scope SSM parameter paths and `.env` filenames.
 * @returns A `SecretsManager` for the configured provider.
 *
 * @throws {Error} If `@aws-sdk/client-ssm` is not installed when provider is `'ssm'`.
 *
 * @example
 * ```ts
 * import { createSecretsManager } from '@lastshotlabs/slingshot-infra';
 *
 * const manager = createSecretsManager(platform.secrets!, 'production');
 * const { missing } = await manager.check(['DATABASE_URL', 'JWT_SECRET']);
 * if (missing.length > 0) console.error('Missing secrets:', missing);
 * ```
 */
export function createSecretsManager(
  config: PlatformSecretsConfig,
  stageName: string,
): SecretsManager {
  return {
    async push(appRoot: string, requiredKeys: string[]): Promise<{ pushed: string[] }> {
      const envFile = resolveEnvFile(appRoot, stageName);
      if (!existsSync(envFile)) {
        throw new Error(
          `[slingshot-infra] No .env file found at ${envFile}. ` +
            'Create one with the required secrets.',
        );
      }

      const envVars = parseEnvFile(readFileSync(envFile, 'utf-8'));
      const pushed: string[] = [];

      if (config.provider === 'ssm') {
        const ssm = await getSsmClient(config.region);
        const prefix = config.pathPrefix ?? '/slingshot/';

        for (const key of requiredKeys) {
          const value = envVars[key];
          if (!value) continue;

          const paramName = `${prefix}${stageName}/${key}`;
          await ssm.send(
            new (await getSsmCommands()).PutParameterCommand({
              Name: paramName,
              Value: value,
              Type: 'SecureString',
              Overwrite: true,
            }),
          );
          pushed.push(key);
        }
      } else if (config.provider === 'file') {
        const dir = config.directory ?? `/run/secrets/${stageName}`;
        const { mkdirSync } = await import('node:fs');
        mkdirSync(dir, { recursive: true });

        for (const key of requiredKeys) {
          const value = envVars[key];
          if (!value) continue;
          writeFileSync(join(dir, key), value, 'utf-8');
          pushed.push(key);
        }
      }

      return { pushed };
    },

    async pull(appRoot: string, requiredKeys: string[]): Promise<{ pulled: string[] }> {
      const envFile = resolveEnvFile(appRoot, stageName);
      const existingVars = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf-8')) : {};
      const pulled: string[] = [];

      if (config.provider === 'ssm') {
        const ssm = await getSsmClient(config.region);
        const prefix = config.pathPrefix ?? '/slingshot/';

        for (const key of requiredKeys) {
          const paramName = `${prefix}${stageName}/${key}`;
          try {
            const res = await ssm.send(
              new (await getSsmCommands()).GetParameterCommand({
                Name: paramName,
                WithDecryption: true,
              }),
            );
            if (res.Parameter?.Value) {
              existingVars[key] = res.Parameter.Value;
              pulled.push(key);
            }
          } catch (err: unknown) {
            console.warn(
              `[slingshot-infra] SSM parameter '${paramName}' not found during pull — skipping key '${key}'.`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      } else if (config.provider === 'file') {
        const dir = config.directory ?? `/run/secrets/${stageName}`;
        for (const key of requiredKeys) {
          const filePath = join(dir, key);
          if (existsSync(filePath)) {
            existingVars[key] = readFileSync(filePath, 'utf-8').trim();
            pulled.push(key);
          }
        }
      }

      // Write back to .env file
      const envContent = Object.entries(existingVars)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      writeFileSync(envFile, envContent + '\n', 'utf-8');

      return { pulled };
    },

    async check(requiredKeys: string[]): Promise<SecretsCheckResult> {
      const found: string[] = [];
      const missing: string[] = [];

      if (config.provider === 'ssm') {
        const ssm = await getSsmClient(config.region);
        const prefix = config.pathPrefix ?? '/slingshot/';

        for (const key of requiredKeys) {
          const paramName = `${prefix}${stageName}/${key}`;
          try {
            await ssm.send(
              new (await getSsmCommands()).GetParameterCommand({
                Name: paramName,
              }),
            );
            found.push(key);
          } catch (err: unknown) {
            console.warn(
              `[slingshot-infra] SSM parameter '${paramName}' not found during check — marking key '${key}' as missing.`,
              err instanceof Error ? err.message : err,
            );
            missing.push(key);
          }
        }
      } else if (config.provider === 'env') {
        for (const key of requiredKeys) {
          if (process.env[key]) {
            found.push(key);
          } else {
            missing.push(key);
          }
        }
      } else {
        const dir = config.directory ?? `/run/secrets/${stageName}`;
        for (const key of requiredKeys) {
          if (existsSync(join(dir, key))) {
            found.push(key);
          } else {
            missing.push(key);
          }
        }
      }

      return { found, missing };
    },
  };
}

/**
 * Resolve the path to the `.env` file for the given app root and stage.
 *
 * Prefers a stage-specific file (`.env.<stageName>`) if it exists, falling back
 * to the generic `.env` file. This mirrors the convention used by most Node/Bun
 * projects (e.g. Vite, Next.js).
 *
 * @param appRoot - Absolute path to the application root directory.
 * @param stageName - Deployment stage name (e.g. `'production'`, `'staging'`).
 * @returns The absolute path to the resolved `.env` file. The file may or may not
 *   exist at the returned path — callers are responsible for checking.
 */
function resolveEnvFile(appRoot: string, stageName: string): string {
  const stageFile = join(appRoot, `.env.${stageName}`);
  if (existsSync(stageFile)) return stageFile;
  return join(appRoot, '.env');
}

/**
 * Parse the content of a `.env` file into a key-value map.
 *
 * @param content - The raw text content of the `.env` file.
 * @returns A `Record<string, string>` of environment variable names to their values.
 *
 * @remarks
 * Parsing rules:
 * - Blank lines are skipped (unless inside a multi-line quoted value).
 * - Lines whose first non-whitespace character is `#` are treated as comments
 *   and skipped.
 * - Lines without an `=` character are skipped.
 * - The key is the substring before the first `=`, trimmed of whitespace.
 * - The value is the substring after the first `=`, trimmed of whitespace.
 * - Values wrapped in matching double or single quotes have the quotes stripped.
 * - Multi-line values: if a value starts with `"` or `'` but the closing quote
 *   is not on the same line, subsequent lines are accumulated until the matching
 *   closing quote is found. Newlines within the value are preserved.
 * - Duplicate keys: the last occurrence wins (standard `.env` behaviour).
 */
function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const lines = content.split('\n');

  let multiLineKey: string | null = null;
  let multiLineQuote: string | null = null;
  let multiLineBuffer: string[] = [];

  for (const line of lines) {
    // If we're in a multi-line value, accumulate until the closing quote.
    if (multiLineKey !== null && multiLineQuote !== null) {
      if (line.endsWith(multiLineQuote)) {
        // Found the closing quote — finish the multi-line value.
        multiLineBuffer.push(line.slice(0, -1));
        vars[multiLineKey] = multiLineBuffer.join('\n');
        multiLineKey = null;
        multiLineQuote = null;
        multiLineBuffer = [];
      } else {
        multiLineBuffer.push(line);
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Check for multi-line quoted values: starts with quote but doesn't end with it.
    if (
      (value.startsWith('"') && !value.endsWith('"')) ||
      (value.startsWith("'") && !value.endsWith("'"))
    ) {
      multiLineKey = key;
      multiLineQuote = value[0];
      multiLineBuffer = [value.slice(1)];
      continue;
    }

    // Strip surrounding quotes for single-line values.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }

  return vars;
}

/**
 * Lazily create an AWS SSM Parameter Store client.
 *
 * @param region - AWS region for the SSM client. Defaults to `'us-east-1'` if
 *   not provided.
 * @returns An initialized `SSMClient` instance from `@aws-sdk/client-ssm`.
 *
 * @throws {Error} If `@aws-sdk/client-ssm` is not installed
 *   (`bun add @aws-sdk/client-ssm` to resolve).
 */
async function getSsmClient(region?: string) {
  try {
    const { SSMClient } = await import('@aws-sdk/client-ssm');
    return new SSMClient({ region: region ?? 'us-east-1' });
  } catch {
    throw new Error('@aws-sdk/client-ssm is not installed. Run: bun add @aws-sdk/client-ssm');
  }
}

/**
 * Lazily import the SSM command constructors used for parameter operations.
 *
 * Imported separately from `getSsmClient()` so that the command classes are
 * only resolved when a `push()` or `pull()` operation is actually performed.
 *
 * @returns An object with `PutParameterCommand` and `GetParameterCommand`
 *   constructor references from `@aws-sdk/client-ssm`.
 *
 * @throws {Error} If `@aws-sdk/client-ssm` is not installed.
 */
async function getSsmCommands() {
  const mod = await import('@aws-sdk/client-ssm');
  return {
    PutParameterCommand: mod.PutParameterCommand,
    GetParameterCommand: mod.GetParameterCommand,
  };
}
