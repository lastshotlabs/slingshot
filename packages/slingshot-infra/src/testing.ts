// packages/slingshot-infra/src/testing.ts
/**
 * Test utilities for `@lastshotlabs/slingshot-infra`.
 *
 * Provides mock factories and helpers for unit testing infrastructure
 * configuration, provisioners, registries, and deploy pipelines without
 * requiring real cloud credentials or a live registry backend.
 *
 * @example
 * ```ts
 * import {
 *   createMockProvisioner,
 *   createMockRegistryProvider,
 *   createMockSecretsManager,
 * } from '@lastshotlabs/slingshot-infra/testing';
 *
 * const provisioner = createMockProvisioner('postgres');
 * const result = await provisioner.provision(mockContext);
 * ```
 */
import type { SecretsCheckResult, SecretsManager } from './secrets/secretsManager';
import type { DefinePlatformConfig, StageConfig } from './types/platform';
import type { RegistryDocument, RegistryLock, RegistryProvider } from './types/registry';
import { createEmptyRegistryDocument } from './types/registry';
import type {
  ResourceOutput,
  ResourceProvisioner,
  ResourceProvisionerContext,
} from './types/resource';

/**
 * Create a mock `ResourceProvisioner` for testing deploy and provisioning flows.
 *
 * The provisioner records all calls and returns configurable outputs.
 *
 * @param resourceType - The resource type identifier (e.g. `'postgres'`).
 * @param outputs - Optional custom outputs. Defaults to a basic `status: 'provisioned'` result.
 * @returns A mock provisioner with call tracking via `provisionCalls` and `destroyCalls`.
 */
export function createMockProvisioner(
  resourceType: string,
  outputs?: Partial<ResourceOutput>,
): ResourceProvisioner & {
  provisionCalls: ResourceProvisionerContext[];
  destroyCalls: ResourceProvisionerContext[];
} {
  const provisionCalls: ResourceProvisionerContext[] = [];
  const destroyCalls: ResourceProvisionerContext[] = [];

  const defaultOutput: ResourceOutput = {
    status: 'provisioned',
    outputs: { host: 'mock-host', port: '5432' },
    connectionEnv: { DATABASE_URL: 'postgres://mock-host:5432/db' },
    ...outputs,
  };

  return {
    resourceType,
    provisionCalls,
    destroyCalls,
    async provision(ctx: ResourceProvisionerContext): Promise<ResourceOutput> {
      provisionCalls.push(ctx);
      return { ...defaultOutput };
    },
    async destroy(ctx: ResourceProvisionerContext): Promise<void> {
      destroyCalls.push(ctx);
    },
    getConnectionEnv(out: ResourceOutput): Record<string, string> {
      return { ...out.connectionEnv };
    },
  };
}

/**
 * Create a mock `RegistryProvider` backed by an in-memory document.
 *
 * Useful for testing deploy pipelines, app registration, and registry
 * operations without S3 or filesystem access.
 *
 * @param initial - Optional initial registry document. Defaults to an empty document.
 * @returns A mock registry provider with a `document` property for inspection.
 */
export function createMockRegistryProvider(
  initial?: RegistryDocument,
): RegistryProvider & { document: RegistryDocument } {
  let etag = '1';
  const state = { document: initial ?? createEmptyRegistryDocument('test-org') };

  return {
    name: 'mock',
    get document() {
      return state.document;
    },
    async read(): Promise<RegistryDocument | null> {
      return JSON.parse(JSON.stringify(state.document)) as RegistryDocument;
    },
    async write(doc: RegistryDocument): Promise<{ etag: string }> {
      state.document = JSON.parse(JSON.stringify(doc)) as RegistryDocument;
      etag = String(Number(etag) + 1);
      return { etag };
    },
    async initialize(): Promise<void> {
      /* no-op in tests */
    },
    async lock(): Promise<RegistryLock> {
      return {
        etag,
        async release(): Promise<void> {
          /* no-op in tests */
        },
      };
    },
  };
}

/**
 * Create a mock `SecretsManager` for testing push/pull/check flows.
 *
 * The mock stores secrets in an in-memory map. No filesystem or cloud
 * calls are made.
 *
 * @param initialSecrets - Optional pre-populated secrets.
 * @returns A mock secrets manager with a `secrets` map for inspection.
 */
export function createMockSecretsManager(
  initialSecrets?: Record<string, string>,
): SecretsManager & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>(initialSecrets ? Object.entries(initialSecrets) : []);

  return {
    secrets,
    async push(_appRoot: string, requiredKeys: string[]): Promise<{ pushed: string[] }> {
      // Simulate pushing all required keys that exist in the map
      const pushed = requiredKeys.filter(k => secrets.has(k));
      return { pushed };
    },
    async pull(_appRoot: string, requiredKeys: string[]): Promise<{ pulled: string[] }> {
      const pulled = requiredKeys.filter(k => secrets.has(k));
      return { pulled };
    },
    async check(requiredKeys: string[]): Promise<SecretsCheckResult> {
      const found: string[] = [];
      const missing: string[] = [];
      for (const key of requiredKeys) {
        if (secrets.has(key)) {
          found.push(key);
        } else {
          missing.push(key);
        }
      }
      return { found, missing };
    },
  };
}

/**
 * Create a minimal valid `DefinePlatformConfig` for testing.
 *
 * Provides sensible defaults for all required fields. Override specific
 * fields via the `overrides` parameter.
 *
 * @param overrides - Optional partial config to merge over defaults.
 * @returns A complete `DefinePlatformConfig` suitable for test fixtures.
 */
export function createTestPlatformConfig(
  overrides?: Partial<DefinePlatformConfig>,
): DefinePlatformConfig {
  const defaultStages: Record<string, StageConfig> = {
    dev: { env: { NODE_ENV: 'development' } },
  };

  const config: DefinePlatformConfig = {
    org: 'test-org',
    provider: 'aws',
    region: 'us-east-1',
    registry: { provider: 'local', path: '.slingshot/registry.json' },
    stages: defaultStages,
    ...overrides,
  };
  return config;
}

/**
 * Create a mock `ResourceProvisionerContext` for testing provisioner implementations.
 *
 * @param resourceName - Logical resource name. Defaults to `'test-db'`.
 * @param overrides - Optional partial context to merge over defaults.
 * @returns A complete `ResourceProvisionerContext` for test calls.
 */
export function createTestProvisionerContext(
  resourceName?: string,
  overrides?: Partial<ResourceProvisionerContext>,
): ResourceProvisionerContext {
  const context: ResourceProvisionerContext = {
    resourceName: resourceName ?? 'test-db',
    config: { type: 'postgres', provision: true },
    stageName: 'dev',
    region: 'us-east-1',
    platform: 'test-org',
    ...overrides,
  };
  return context;
}
