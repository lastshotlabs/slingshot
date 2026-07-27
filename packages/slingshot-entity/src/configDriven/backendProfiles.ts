/**
 * Canonical semantic profiles and startup requirements for standard entity adapters.
 */
import {
  ENTITY_BACKEND_CAPABILITIES,
  type EntityBackendCapability,
  type EntityBackendProfile,
  type EntityBackendRequirement,
  type OperationConfig,
  type PipeOpConfig,
  type ResolvedEntityConfig,
  type StoreType,
  type TransactionOpConfig,
  deepFreeze,
} from '@lastshotlabs/slingshot-core';

type UnsupportedClaims = Readonly<Partial<Record<EntityBackendCapability, string>>>;

const BASE_ENTITY_REQUIREMENTS = [
  'crud.create',
  'crud.read',
  'crud.update',
  'crud.delete',
  'crud.list',
  'crud.clear',
  'defaults.apply',
  'mapping.fields',
  'query.sort',
  'query.cursor',
  'filter.eq',
  'filter.ne',
  'filter.gt',
  'filter.gte',
  'filter.lt',
  'filter.lte',
  'filter.in',
  'filter.nin',
  'filter.contains',
  'filter.and',
  'filter.or',
] as const satisfies readonly EntityBackendCapability[];

const BUILT_IN_PIPE_METHODS = new Set(['create', 'getById', 'update', 'delete', 'list', 'clear']);

function defineEntityBackendProfile(
  store: StoreType,
  production: boolean,
  unsupported: UnsupportedClaims,
): EntityBackendProfile {
  const entries = ENTITY_BACKEND_CAPABILITIES.map(capability => {
    const reason = unsupported[capability];
    if (reason !== undefined && reason.trim().length === 0) {
      throw new Error(`[slingshot-entity] Empty unsupported reason for ${store}:${capability}`);
    }
    return [
      capability,
      reason === undefined
        ? { status: 'supported' as const }
        : { status: 'unsupported' as const, reason },
    ] as const;
  });

  const capabilities = Object.fromEntries(entries) as Record<
    EntityBackendCapability,
    EntityBackendProfile['capabilities'][EntityBackendCapability]
  >;
  return deepFreeze({ store, production, capabilities });
}

/**
 * Exhaustive semantic profiles for Slingshot's five standard entity adapters.
 *
 * These objects are the sole support source for startup validation, conformance
 * selection, generated reports, and backend documentation.
 */
export const ENTITY_BACKEND_PROFILES = deepFreeze({
  memory: defineEntityBackendProfile('memory', false, {
    'transaction.rollback': 'Memory transactions do not restore earlier writes after failure.',
  }),
  sqlite: defineEntityBackendProfile('sqlite', true, {
    'atomic.array-mutation':
      'SQLite array mutation currently reads and writes in separate statements without a transaction.',
    'atomic.consume':
      'SQLite consume currently selects and deletes in separate statements without a transaction.',
    'atomic.computed-aggregate':
      'SQLite computed aggregate currently reads and writes in separate statements without a transaction.',
  }),
  postgres: defineEntityBackendProfile('postgres', true, {}),
  mongo: defineEntityBackendProfile('mongo', true, {
    'atomic.consume':
      'MongoDB consume currently finds and deletes in separate operations instead of findOneAndDelete.',
    'atomic.batch':
      'MongoDB batch writes are atomic per document, not across the matched document set.',
    'atomic.computed-aggregate':
      'MongoDB computed aggregate reads and writes without a session transaction.',
    'transaction.rollback': 'MongoDB composite operations do not use a session transaction.',
  }),
  redis: defineEntityBackendProfile('redis', true, {
    'constraint.unique':
      'Redis does not maintain atomic secondary or compound unique-index reservations.',
    'atomic.transition': 'Redis transition uses a non-atomic read-modify-write sequence.',
    'atomic.increment': 'Redis increment uses a non-atomic JSON read-modify-write sequence.',
    'atomic.array-mutation': 'Redis array mutation uses a non-atomic read-modify-write sequence.',
    'atomic.consume': 'Redis consume scans, reads, and deletes in separate commands.',
    'atomic.upsert': 'Redis upsert scans and writes without an atomic uniqueness reservation.',
    'atomic.batch': 'Redis batch mutates matching keys one at a time.',
    'atomic.computed-aggregate': 'Redis computed aggregate scans and writes in separate commands.',
    'transaction.rollback': 'Redis composite operations do not provide rollback.',
  }),
} satisfies Record<StoreType, EntityBackendProfile>);

/** One unsupported requirement reported by {@link UnsupportedEntityBackendError}. */
export interface MissingEntityBackendCapability {
  /** Capability missing from the selected backend. */
  readonly capability: EntityBackendCapability;
  /** Every sorted entity/operation source that required this capability. */
  readonly requiredBy: readonly string[];
  /** Backend profile explanation for the unsupported claim. */
  readonly reason: string;
}

/** Startup error thrown when a standard entity backend cannot honor its resolved configuration. */
export class UnsupportedEntityBackendError extends Error {
  override readonly name = 'UnsupportedEntityBackendError';
  readonly code = 'SLINGSHOT_ENTITY_BACKEND_UNSUPPORTED';
  readonly store: StoreType;
  readonly entityName: string;
  readonly missing: readonly MissingEntityBackendCapability[];

  constructor(
    store: StoreType,
    entityName: string,
    missing: readonly MissingEntityBackendCapability[],
  ) {
    const lines = missing.map(
      item => `- ${item.capability} (required by ${item.requiredBy.join('; ')}): ${item.reason}`,
    );
    super(
      `[slingshot-entity] Entity "${entityName}" cannot use store "${store}".\n` +
        `Missing capabilities:\n${lines.join('\n')}\n` +
        'Choose a capable store or remove the requiring configuration.',
    );
    this.store = store;
    this.entityName = entityName;
    this.missing = deepFreeze(
      missing.map(item => ({
        capability: item.capability,
        requiredBy: [...item.requiredBy],
        reason: item.reason,
      })),
    );
  }
}

/** Return the immutable semantic profile for a standard entity store. */
export function getEntityBackendProfile(store: StoreType): EntityBackendProfile {
  return ENTITY_BACKEND_PROFILES[store];
}

function operationRequirements(
  operations: Readonly<Record<string, OperationConfig>> | undefined,
): EntityBackendRequirement[] {
  if (!operations) return [];

  const requirements: EntityBackendRequirement[] = [];
  for (const [operationName, operation] of Object.entries(operations).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const requiredBy = `operation: ${operationName}`;
    requirements.push({
      capability: `operation.${operation.kind}`,
      requiredBy,
    });

    switch (operation.kind) {
      case 'transition':
        requirements.push({ capability: 'atomic.transition', requiredBy });
        break;
      case 'increment':
        requirements.push({ capability: 'atomic.increment', requiredBy });
        break;
      case 'arrayPush':
      case 'arrayPull':
      case 'arraySet':
        requirements.push({ capability: 'atomic.array-mutation', requiredBy });
        break;
      case 'consume':
        requirements.push({ capability: 'atomic.consume', requiredBy });
        break;
      case 'upsert':
        requirements.push({ capability: 'atomic.upsert', requiredBy });
        break;
      case 'batch':
        if (operation.atomic) {
          requirements.push({ capability: 'atomic.batch', requiredBy });
        }
        break;
      case 'computedAggregate':
        if (operation.atomic) {
          requirements.push({ capability: 'atomic.computed-aggregate', requiredBy });
        }
        break;
      case 'transaction':
        requirements.push({ capability: 'transaction.rollback', requiredBy });
        break;
      default:
        break;
    }
  }
  return requirements;
}

/**
 * Resolve every backend capability required by a standard entity definition.
 *
 * The returned array is deterministic and may contain the same capability more
 * than once when several config surfaces require it. Startup errors group those
 * sources while preserving all of them.
 */
export function resolveEntityBackendRequirements(
  config: ResolvedEntityConfig,
  operations?: Readonly<Record<string, OperationConfig>>,
): readonly EntityBackendRequirement[] {
  const requirements: EntityBackendRequirement[] = BASE_ENTITY_REQUIREMENTS.map(capability => ({
    capability,
    requiredBy: 'entity adapter contract',
  }));

  for (const index of config.indexes ?? []) {
    if (index.unique) {
      requirements.push({
        capability: 'constraint.unique',
        requiredBy: `unique index: ${index.fields.join(',')}`,
      });
    }
  }
  for (const unique of config.uniques ?? []) {
    requirements.push({
      capability: 'constraint.unique',
      requiredBy: `unique constraint: ${unique.fields.join(',')}`,
    });
  }
  if (config.tenant) {
    requirements.push({ capability: 'scope.tenant', requiredBy: 'tenant configuration' });
  }
  if (config.softDelete) {
    requirements.push({
      capability: 'lifecycle.soft-delete',
      requiredBy: 'soft-delete configuration',
    });
  }
  if (config.ttl) {
    requirements.push({
      capability: 'lifecycle.ttl-visibility',
      requiredBy: 'TTL configuration',
    });
  }

  requirements.push(...operationRequirements(operations));
  return deepFreeze(
    requirements.sort(
      (a, b) =>
        a.capability.localeCompare(b.capability) || a.requiredBy.localeCompare(b.requiredBy),
    ),
  );
}

function assertSingleEntityOperationTopology(
  operations: Readonly<Record<string, OperationConfig>> | undefined,
): void {
  if (!operations) return;
  for (const [operationName, operation] of Object.entries(operations)) {
    if (operation.kind === 'transaction' || operation.kind === 'pipe') {
      throw new Error(
        `[slingshot-entity] Invalid entity operation configuration: operation '${operationName}' ` +
          `uses composite-only kind '${operation.kind}'; move it to createCompositeFactories().`,
      );
    }
  }
}

function hasCustomFactory(operation: OperationConfig, store: StoreType): boolean {
  if (operation.kind !== 'custom') return true;
  switch (store) {
    case 'memory':
      return typeof operation.memory === 'function';
    case 'sqlite':
      return typeof operation.sqlite === 'function';
    case 'postgres':
      return typeof operation.postgres === 'function';
    case 'mongo':
      return typeof operation.mongo === 'function';
    case 'redis':
      return typeof operation.redis === 'function';
  }
}

function missingRequirements(
  store: StoreType,
  operations: Readonly<Record<string, OperationConfig>> | undefined,
  requirements: readonly EntityBackendRequirement[],
): readonly MissingEntityBackendCapability[] {
  const profile = getEntityBackendProfile(store);
  const grouped = new Map<EntityBackendCapability, Set<string>>();

  for (const requirement of requirements) {
    if (profile.capabilities[requirement.capability].status === 'unsupported') {
      const sources = grouped.get(requirement.capability) ?? new Set<string>();
      sources.add(requirement.requiredBy);
      grouped.set(requirement.capability, sources);
    }
  }

  for (const [operationName, operation] of Object.entries(operations ?? {})) {
    if (operation.kind === 'custom' && !hasCustomFactory(operation, store)) {
      const capability: EntityBackendCapability = 'operation.custom';
      const sources = grouped.get(capability) ?? new Set<string>();
      sources.add(`operation: ${operationName}`);
      grouped.set(capability, sources);
    }
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capability, sources]) => {
      const claim = profile.capabilities[capability];
      const reason =
        claim.status === 'unsupported'
          ? claim.reason
          : `Custom operation has no ${store} factory under standard entity wiring.`;
      return {
        capability,
        requiredBy: [...sources].sort(),
        reason,
      };
    });
}

/**
 * Assert that a standard store can satisfy one resolved entity configuration.
 *
 * Validation runs before adapter construction and throws a typed, deterministic
 * error containing every missing capability.
 */
export function assertEntityBackendRequirements(
  store: StoreType,
  config: ResolvedEntityConfig,
  operations?: Readonly<Record<string, OperationConfig>>,
): void {
  assertSingleEntityOperationTopology(operations);
  const missing = missingRequirements(
    store,
    operations,
    resolveEntityBackendRequirements(config, operations),
  );
  if (missing.length > 0) {
    throw new UnsupportedEntityBackendError(store, config.name, missing);
  }
}

interface CompositeEntityEntry {
  readonly config: ResolvedEntityConfig;
  readonly operations?: Readonly<Record<string, OperationConfig>>;
}

function assertTransactionTopology(
  operationName: string,
  operation: TransactionOpConfig,
  entities: Readonly<Record<string, CompositeEntityEntry>>,
): void {
  for (const [index, step] of operation.steps.entries()) {
    const entry = entities[step.entity];
    if (!entry) {
      throw new Error(
        `[slingshot-entity] Invalid entity operation configuration: transaction '${operationName}' ` +
          `step ${index} references unknown entity '${step.entity}'.`,
      );
    }
    if (step.op === 'fieldUpdate' || step.op === 'batch') {
      const named = entry.operations?.[step.op];
      if (!named || named.kind !== step.op) {
        throw new Error(
          `[slingshot-entity] Invalid entity operation configuration: transaction '${operationName}' ` +
            `step ${index} requires named ${step.op} operation '${step.op}' on entity '${step.entity}'.`,
        );
      }
    }
  }
}

function assertPipeTopology(
  operationName: string,
  operation: PipeOpConfig,
  firstEntry: CompositeEntityEntry | undefined,
): void {
  if (!firstEntry) {
    throw new Error(
      `[slingshot-entity] Invalid entity operation configuration: pipe '${operationName}' requires at least one entity.`,
    );
  }
  for (const [index, step] of operation.steps.entries()) {
    if (BUILT_IN_PIPE_METHODS.has(step.op)) continue;
    const named = firstEntry.operations?.[step.op];
    if (!named || named.kind !== step.config.kind) {
      throw new Error(
        `[slingshot-entity] Invalid entity operation configuration: pipe '${operationName}' step ${index} ` +
          `references missing or mismatched operation '${step.op}' on the first composite entity.`,
      );
    }
  }
}

/**
 * Preflight a complete composite before any child adapter is constructed.
 *
 * @internal Used by `createCompositeFactories`; not part of the package root API.
 */
export function assertCompositeEntityBackendRequirements(
  store: StoreType,
  entities: Readonly<Record<string, CompositeEntityEntry>>,
  operations?: Readonly<Record<string, TransactionOpConfig | PipeOpConfig>>,
): void {
  const entries = Object.entries(entities);
  for (const [, entry] of entries) {
    assertEntityBackendRequirements(store, entry.config, entry.operations);
  }

  if (!operations) return;
  for (const [operationName, operation] of Object.entries(operations)) {
    if (operation.kind === 'transaction') {
      assertTransactionTopology(operationName, operation, entities);
    } else {
      assertPipeTopology(operationName, operation, entries[0]?.[1]);
    }
  }

  const requirements = operationRequirements(operations);
  const missing = missingRequirements(store, operations, requirements);
  if (missing.length > 0) {
    throw new UnsupportedEntityBackendError(
      store,
      `composite(${entries.map(([key]) => key).join(',')})`,
      missing,
    );
  }
}
