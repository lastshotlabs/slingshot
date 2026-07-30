/** First-party transport and persistence surfaces that must preserve tenant identity. */
export type TenantBoundaryKind =
  | 'http'
  | 'websocket'
  | 'sse'
  | 'entity'
  | 'event'
  | 'job'
  | 'queue'
  | 'orchestration'
  | 'cache'
  | 'search'
  | 'asset'
  | 'notification'
  | 'mail'
  | 'push'
  | 'billing'
  | 'ai';

/** Declarative tenant-isolation contract for one named application boundary. */
export interface TenantBoundaryDefinition {
  readonly id: string;
  readonly kind: TenantBoundaryKind;
  readonly requiredIn: readonly ('single' | 'multi')[];
  readonly serialization: 'envelope' | 'scope' | 'key' | 'row' | 'argument';
  readonly missing: 'reject' | 'system-only';
  readonly mismatch: 'reject';
}

/** Instance-scoped registrar used to inventory and finalize tenant boundaries. */
export interface TenantBoundaryRegistry {
  register(definition: TenantBoundaryDefinition): void;
  finalize(): readonly TenantBoundaryDefinition[];
  list(): readonly TenantBoundaryDefinition[];
  readonly finalized: boolean;
}

/** Create an isolated, duplicate-safe boundary registry for one app instance. */
export function createTenantBoundaryRegistry(): TenantBoundaryRegistry {
  const definitions = new Map<string, TenantBoundaryDefinition>();
  let finalized = false;
  let snapshot: readonly TenantBoundaryDefinition[] = Object.freeze([]);
  return Object.freeze({
    register(definition: TenantBoundaryDefinition): void {
      if (finalized) throw new Error('Tenant boundary registry is finalized.');
      if (!definition.id.trim()) throw new Error('Tenant boundary id must be non-empty.');
      if (definitions.has(definition.id)) {
        throw new Error(`Duplicate tenant boundary '${definition.id}'.`);
      }
      definitions.set(
        definition.id,
        Object.freeze({
          ...definition,
          requiredIn: Object.freeze([...definition.requiredIn]),
        }),
      );
    },
    finalize(): readonly TenantBoundaryDefinition[] {
      if (!finalized) {
        snapshot = Object.freeze(
          [...definitions.values()].sort((left, right) => left.id.localeCompare(right.id)),
        );
        finalized = true;
      }
      return snapshot;
    },
    list(): readonly TenantBoundaryDefinition[] {
      return finalized
        ? snapshot
        : Object.freeze(
            [...definitions.values()].sort((left, right) => left.id.localeCompare(right.id)),
          );
    },
    get finalized(): boolean {
      return finalized;
    },
  });
}
