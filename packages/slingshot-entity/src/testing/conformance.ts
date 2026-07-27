import {
  type EntityAdapter,
  type EntityBackendCapability,
  type EntityBackendProfile,
  type OperationConfig,
  type ResolvedEntityConfig,
  type StoreType,
  deepFreeze,
} from '@lastshotlabs/slingshot-core';
import { ENTITY_CONFORMANCE_CATALOG } from './catalog';
import { ENTITY_CONFORMANCE_DEFINITIONS } from './fixtures';

/** Infrastructure adapter used by the shared entity conformance runner. */
export interface EntityConformanceDriver {
  /** Stable standard-store identifier represented by this driver. */
  readonly name: StoreType;
  /** Immutable capability profile used as the sole case-selection source. */
  readonly profile: EntityBackendProfile;
  /** Create fresh, isolated infrastructure for one complete catalog run. */
  createHarness(
    definitions: readonly EntityConformanceDefinition[],
  ): Promise<EntityConformanceHarness>;
}

/** One entity definition installed into a conformance harness. */
export interface EntityConformanceDefinition {
  /** Stable key used to retrieve the adapter from the harness. */
  readonly key: string;
  /** Resolved entity configuration exercised by the catalog. */
  readonly config: ResolvedEntityConfig;
  /** Optional declarative operations exposed by the adapter. */
  readonly operations?: Readonly<Record<string, OperationConfig>>;
}

/** Fresh backend state exposed to one shared conformance run. */
export interface EntityConformanceHarness {
  /** Retrieve a typed adapter by fixture-definition key. */
  adapter<
    Entity = Record<string, unknown>,
    CreateInput = Record<string, unknown>,
    UpdateInput = Record<string, unknown>,
  >(
    key: string,
  ): EntityAdapter<Entity, CreateInput, UpdateInput>;
  /** Retrieve a named composite adapter installed by the driver. */
  composite(name: string): Readonly<Record<string, unknown>>;
  /** Clear every fixture entity and operation-owned collection. */
  reset(): Promise<void>;
  /** Idempotently close connections and remove temporary resources. */
  destroy(): Promise<void>;
}

/** One backend-independent behavior assertion in the public catalog. */
export interface EntityConformanceCase {
  /** Stable public artifact key. */
  readonly id: string;
  /** Human-readable behavior under test. */
  readonly description: string;
  /** Capabilities that must all be supported before this case is selected. */
  readonly requires: readonly EntityBackendCapability[];
  /** Execute the assertion against a freshly reset harness. */
  run(harness: EntityConformanceHarness): Promise<void>;
}

/** Serializable outcome for one store and catalog case. */
export interface EntityConformanceResult {
  /** Result schema version. */
  readonly schemaVersion: 1;
  /** Store exercised by the driver. */
  readonly store: StoreType;
  /** Stable catalog case identifier. */
  readonly caseId: string;
  /** Passed, profile-derived skipped, or captured failure. */
  readonly status: 'passed' | 'skipped' | 'failed';
  /** Capabilities declared by the catalog case. */
  readonly requiredCapabilities: readonly EntityBackendCapability[];
  /** Deterministic unsupported-capability explanation for skipped cases. */
  readonly reason?: string;
  /** Sanitized selected-case failure without a stack or infrastructure values. */
  readonly error?: {
    readonly name: string;
    readonly message: string;
  };
  /** Selected-case wall duration in milliseconds; skips are always zero. */
  readonly durationMs: number;
}

function serializeError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return {
    name: 'Error',
    message: typeof error === 'string' ? error : 'Unknown conformance error',
  };
}

/**
 * Run a conformance catalog in order against one fresh driver harness.
 *
 * Selection is derived exclusively from `driver.profile`. Selected failures
 * are captured so the caller receives a complete artifact; infrastructure is
 * destroyed exactly once in `finally`.
 */
export async function runEntityConformance(
  driver: EntityConformanceDriver,
  cases: readonly EntityConformanceCase[] = ENTITY_CONFORMANCE_CATALOG,
): Promise<readonly EntityConformanceResult[]> {
  const harness = await driver.createHarness(ENTITY_CONFORMANCE_DEFINITIONS);
  const results: EntityConformanceResult[] = [];

  try {
    for (const testCase of cases) {
      const unsupported = testCase.requires.filter(
        capability => driver.profile.capabilities[capability].status === 'unsupported',
      );
      if (unsupported.length > 0) {
        const details = unsupported.map(capability => {
          const claim = driver.profile.capabilities[capability];
          return `${capability}: ${claim.status === 'unsupported' ? claim.reason : ''}`;
        });
        results.push({
          schemaVersion: 1,
          store: driver.name,
          caseId: testCase.id,
          status: 'skipped',
          requiredCapabilities: [...testCase.requires],
          reason: `Unsupported capabilities: ${details.join('; ')}`,
          durationMs: 0,
        });
        continue;
      }

      const startedAt = performance.now();
      try {
        await harness.reset();
        await testCase.run(harness);
        results.push({
          schemaVersion: 1,
          store: driver.name,
          caseId: testCase.id,
          status: 'passed',
          requiredCapabilities: [...testCase.requires],
          durationMs: Math.max(0, performance.now() - startedAt),
        });
      } catch (error) {
        results.push({
          schemaVersion: 1,
          store: driver.name,
          caseId: testCase.id,
          status: 'failed',
          requiredCapabilities: [...testCase.requires],
          error: serializeError(error),
          durationMs: Math.max(0, performance.now() - startedAt),
        });
      }
    }
  } finally {
    await harness.destroy();
  }

  return deepFreeze(results);
}
