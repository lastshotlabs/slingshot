import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Signature for the process runner used by `provisionViaSst()` and
 * `destroyViaSst()`. Matches the `spawnSync` signature to allow test
 * overrides without spawning real child processes.
 */
export type ProcessRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; encoding: string; env: Record<string, string | undefined> },
) => SpawnSyncReturns<string>;

function toOutputText(value: string | Uint8Array | null | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value) {
    return '';
  }
  return Buffer.from(value).toString('utf-8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Options for `provisionViaSst()`.
 */
export interface SSTProvisionOptions {
  /** Logical resource name used in the temp-dir path for easier debugging. */
  resourceName: string;
  /** Deployment stage passed as `--stage` to `sst deploy`. */
  stageName: string;
  /** AWS region injected as `AWS_REGION` into the child process environment. */
  region: string;
  /** Organization/platform name used in the generated SST config. */
  platform: string;
  /** Full content of the `sst.config.ts` file to write into the temp dir. */
  sstConfig: string;
  /** App root to copy `package.json` / lockfiles from. Defaults to `process.cwd()`. */
  appRoot?: string;
  /** Override process runner for testing. Defaults to `spawnSync`. */
  processRunner?: ProcessRunner;
}

/**
 * Result returned by `provisionViaSst()`.
 */
export interface SSTProvisionResult {
  /** Whether `sst deploy` exited with code 0. */
  success: boolean;
  /**
   * Parsed key-value outputs from SST stdout.
   * Keys match the `return {}` block in the generated `sst.config.ts`.
   */
  outputs: Record<string, string>;
  /** Error message when `success` is `false`. */
  error?: string;
}

/**
 * Provision AWS resources by generating an SST config and running `sst deploy`.
 *
 * Creates a temporary directory, writes the `sst.config.ts`, copies relevant
 * package files for Bun dependency resolution, runs `bunx sst deploy`, then
 * parses `key = value` output lines and JSON output blocks from stdout.
 * The temp directory is always removed in the `finally` block.
 *
 * @param opts - Provisioning options including the SST config content and stage.
 * @returns A `SSTProvisionResult` with parsed outputs on success or an error
 *   message on failure.
 *
 * @example
 * ```ts
 * import { provisionViaSst } from '@lastshotlabs/slingshot-infra';
 *
 * const result = await provisionViaSst({
 *   resourceName: 'postgres',
 *   stageName: 'production',
 *   region: 'us-east-1',
 *   platform: 'acme',
 *   sstConfig,
 * });
 * if (result.success) console.log(result.outputs);
 * ```
 */
export function provisionViaSst(opts: SSTProvisionOptions): Promise<SSTProvisionResult> {
  const tempDir = join(tmpdir(), `slingshot-resource-${opts.resourceName}-${Date.now()}`);
  const run: ProcessRunner =
    opts.processRunner ??
    ((cmd, args, o) => spawnSync(cmd, args, { ...o, encoding: 'utf-8' as const }));

  try {
    mkdirSync(tempDir, { recursive: true });

    // Write the SST config
    writeFileSync(join(tempDir, 'sst.config.ts'), opts.sstConfig, 'utf-8');

    // Copy package files SST may need for dependency resolution
    const appRoot = opts.appRoot ?? process.cwd();
    for (const file of ['package.json', 'bun.lock', 'bun.lockb']) {
      const src = join(appRoot, file);
      if (existsSync(src)) {
        copyFileSync(src, join(tempDir, file));
      }
    }

    const result = run('bunx', ['sst', 'deploy', '--stage', opts.stageName], {
      cwd: tempDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        AWS_REGION: opts.region,
      },
    });

    if (result.status !== 0) {
      const stderr = toOutputText(result.stderr);
      const stdout = toOutputText(result.stdout);
      return Promise.resolve({
        success: false,
        outputs: {},
        error: `SST deploy exited with code ${result.status}: ${stderr || stdout}`.trim(),
      });
    }

    const outputs = parseSstOutputs(toOutputText(result.stdout));

    return Promise.resolve({
      success: true,
      outputs,
    });
  } catch (err) {
    return Promise.resolve({
      success: false,
      outputs: {},
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Options for `destroyViaSst()`. A subset of `SSTProvisionOptions`.
 */
export interface SSTDestroyOptions extends Pick<
  SSTProvisionOptions,
  'resourceName' | 'stageName' | 'appRoot' | 'sstConfig' | 'region'
> {
  /** Override process runner for testing. Defaults to `spawnSync`. */
  processRunner?: ProcessRunner;
}

/**
 * Destroy SST-managed AWS resources for a given resource and stage.
 *
 * Creates a temporary directory, writes the `sst.config.ts`, copies relevant
 * package files, and runs `bunx sst destroy --stage <stageName>`. The temp
 * directory is always removed in the `finally` block.
 *
 * @param opts - Destruction options including the SST config content and stage.
 *
 * @throws {Error} If `sst destroy` exits with a non-zero code.
 *
 * @example
 * ```ts
 * import { destroyViaSst } from '@lastshotlabs/slingshot-infra';
 *
 * await destroyViaSst({
 *   resourceName: 'postgres',
 *   stageName: 'staging',
 *   region: 'us-east-1',
 *   sstConfig,
 * });
 * ```
 */
export function destroyViaSst(opts: SSTDestroyOptions): Promise<void> {
  const tempDir = join(tmpdir(), `slingshot-destroy-${opts.resourceName}-${Date.now()}`);
  const run = opts.processRunner ?? spawnSync;

  try {
    mkdirSync(tempDir, { recursive: true });

    // Write the SST config so destroy knows what to tear down
    if (opts.sstConfig) {
      writeFileSync(join(tempDir, 'sst.config.ts'), opts.sstConfig, 'utf-8');
    }

    // Copy package files
    const appRoot = opts.appRoot ?? process.cwd();
    for (const file of ['package.json', 'bun.lock', 'bun.lockb']) {
      const src = join(appRoot, file);
      if (existsSync(src)) {
        copyFileSync(src, join(tempDir, file));
      }
    }

    const result = run('bunx', ['sst', 'destroy', '--stage', opts.stageName], {
      cwd: tempDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        AWS_REGION: opts.region,
      },
    });

    if (result.status !== 0) {
      const stderr = toOutputText(result.stderr);
      const stdout = toOutputText(result.stdout);
      throw new Error(`SST destroy exited with code ${result.status}: ${stderr || stdout}`.trim());
    }

    return Promise.resolve();
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Parse key-value resource outputs from `sst deploy` stdout.
 *
 * Attempts two parse strategies in order:
 * 1. **JSON block**: if stdout contains a JSON object with an `"outputs"` key,
 *    all entries in that object are returned as string values.
 * 2. **Line-based**: each line matching `\w+ = <value>` (SST v3 format) is
 *    collected as `{ key: value }`.
 *
 * @param raw - The full stdout string from the `sst deploy` child process.
 * @returns A flat `Record<string, string>` of output names to their string values.
 *   Returns an empty object if no outputs are found.
 *
 * @throws Never — parse errors silently fall through to the line-based strategy.
 *
 * @remarks
 * Output key names match the identifiers in the `return {}` block of the
 * generated `sst.config.ts` (e.g. `dbHost`, `dbPort`). Downstream provisioners
 * look up values by the sanitized resource name prefix (e.g. `${name}Host`).
 */
export function parseSstOutputs(raw: string): Record<string, string> {
  const outputs: Record<string, string> = {};

  // Try JSON output first (SST sometimes outputs JSON)
  try {
    const jsonMatch = raw.match(/\{[\s\S]*"outputs"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (isRecord(parsed) && isRecord(parsed.outputs)) {
        for (const [key, value] of Object.entries(parsed.outputs)) {
          outputs[key] = String(value);
        }
        return outputs;
      }
    }
  } catch {
    // Not JSON, try line-based parsing
  }

  // SST v3 outputs lines like: OutputName = value
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*(\w+)\s*=\s*(.+)$/);
    if (match) {
      outputs[match[1].trim()] = match[2].trim();
    }
  }

  return outputs;
}
