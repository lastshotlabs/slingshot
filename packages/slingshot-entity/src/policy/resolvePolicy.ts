import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {
  EntityRoutePolicyConfig,
  PolicyAction,
  PolicyDecision,
  PolicyResolver,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import { getActor, getPolicyResolverKey } from '@lastshotlabs/slingshot-core';

/**
 * Arguments for `resolvePolicy`.
 */
export interface ResolvePolicyArgs<TRecord, TInput> {
  /** Active Hono request context. */
  c: Context;
  /** The policy config from the entity route config. */
  config: EntityRoutePolicyConfig;
  /** The resolved policy resolver function. */
  resolver: PolicyResolver<TRecord, TInput>;
  /** The discriminated action being authorized. */
  action: PolicyAction;
  /** Fetched record (null for pre-handler pass and create). */
  record: TRecord | null;
  /** Request payload (null for read-only ops). */
  input: TInput | null;
  /**
   * Event bus captured at `setupRoutes` time. Used to emit denial events
   * for audit. NOT looked up at request time.
   */
  bus?: SlingshotEventBus;
}

/**
 * Invoke a policy resolver and throw an HTTPException on deny.
 *
 * Normalizes:
 * - `true` / `false` → `{ allow: boolean, status: 403 }`
 * - `leakSafe: true` on the config OR an explicit `status: 404` on the
 *   decision → 404 instead of 403
 * - A thrown error from the resolver → 500 (resolvers must not throw for
 *   policy decisions; throwing is reserved for programmer errors)
 *
 * @param args - The policy resolution arguments including the request context,
 *   policy config, resolver function, action, fetched record, and input payload.
 *   See {@link ResolvePolicyArgs} for details.
 * @returns Resolves with no value when the policy allows the action.
 * @throws {HTTPException} 403 or 404 on deny, 500 on missing actor identity or resolver error.
 */
export async function resolvePolicy<TRecord, TInput>(
  args: ResolvePolicyArgs<TRecord, TInput>,
): Promise<void> {
  const { c, config, resolver, action, record, input, bus } = args;

  const actor = getActor(c as Context<import('@lastshotlabs/slingshot-core').AppEnv>);
  if (!actor.id) {
    throw new HTTPException(500, {
      message: 'policy: actor identity missing at enforcement time (bad config)',
    });
  }

  let raw: boolean | PolicyDecision;
  try {
    raw = await resolver({ action, userId: actor.id, tenantId: actor.tenantId, record, input, c });
  } catch (err) {
    // Resolver threw — surface as 500. Throwing is a programmer/config
    // error, not a deny decision.
    throw new HTTPException(500, {
      message: `policy resolver '${getPolicyResolverKey(config.resolver)}' threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const decision: PolicyDecision = typeof raw === 'boolean' ? { allow: raw } : raw;

  if (decision.allow) return;

  const status = decision.status ?? (config.leakSafe ? 404 : 403);

  // Emit denial event for audit — not awaited.
  if (bus) {
    (bus as unknown as { emit(key: string, payload: unknown): void }).emit('entity:policy.denied', {
      resolverKey: getPolicyResolverKey(config.resolver),
      action,
      userId: actor.id,
      reason: decision.reason,
    });
  }

  throw new HTTPException(status, {
    message: status === 404 ? 'Not Found' : 'Forbidden',
  });
}

// ---------------------------------------------------------------------------
// Operation Kind Registry
// ---------------------------------------------------------------------------

/**
 * Describes how a single operation name maps to policy concerns.
 *
 * The registry pre-populates entries for the five built-in CRUD operations
 * (`create`, `list`, `get`, `update`, `delete`). Named operations that are
 * not in the registry are resolved on-the-fly as `{ kind: 'operation' }`.
 */
interface OperationKindEntry {
  /** The {@link PolicyAction} `kind` discriminant for this operation. */
  readonly kind: PolicyAction['kind'];
  /**
   * The normalized name used for `applyTo` matching in policy configs.
   *
   * CRUD operations use their kind directly (e.g. `'create'`).
   * Named operations use the `operation:` prefix (e.g. `'operation:publish'`).
   */
  readonly policyName: string;
}

/**
 * Module-scoped registry mapping operation names to their policy action kind
 * and normalized `applyTo` name.
 *
 * Seeded with the five built-in CRUD operations at module load time.
 * Named operations that are not registered resolve through
 * {@link resolveOperationKind} as `{ kind: 'operation' }` on the fly.
 */
const operationKindRegistry = new Map<string, OperationKindEntry>();

/**
 * Register a built-in CRUD operation in the operation kind registry.
 *
 * @param name - One of the five CRUD operation names.
 */
function registerCrudOp(name: 'create' | 'list' | 'get' | 'update' | 'delete'): void {
  operationKindRegistry.set(name, { kind: name, policyName: name });
}

registerCrudOp('create');
registerCrudOp('list');
registerCrudOp('get');
registerCrudOp('update');
registerCrudOp('delete');

/**
 * Look up or derive the operation kind entry for a given operation name.
 *
 * Returns a pre-registered entry for CRUD operations, or constructs an
 * ad-hoc `{ kind: 'operation' }` entry for named operations.
 *
 * @param opName - The operation name to resolve.
 * @returns The resolved operation kind entry.
 */
function resolveOperationKind(opName: string): OperationKindEntry {
  const entry = operationKindRegistry.get(opName);
  if (entry) return entry;
  return { kind: 'operation', policyName: `operation:${opName}` };
}

/**
 * Check whether a policy config applies to a given operation.
 *
 * Resolution uses the operation kind registry to normalize the operation name:
 * - CRUD operations match their kind directly (e.g. `'create'`)
 * - Named operations match with the `operation:` prefix (e.g. `'operation:publish'`)
 *
 * When `config.applyTo` is not set, the policy applies to all operations.
 *
 * @param config - The entity route policy config to check.
 * @param opName - The operation name being evaluated.
 * @returns `true` if the policy applies to the given operation.
 *
 * @example
 * ```ts
 * const config = { resolver: 'myPolicy', applyTo: ['create', 'operation:publish'] };
 * policyAppliesToOp(config, 'create');   // true
 * policyAppliesToOp(config, 'publish');  // true
 * policyAppliesToOp(config, 'delete');   // false
 * ```
 */
export function policyAppliesToOp(config: EntityRoutePolicyConfig, opName: string): boolean {
  const applyTo = config.applyTo;
  if (!applyTo) return true;
  return applyTo.includes(resolveOperationKind(opName).policyName);
}

/**
 * Map an operation name string to a structured {@link PolicyAction}.
 *
 * Uses the operation kind registry to determine the action kind:
 * - CRUD operations return `{ kind: '<crud>' }` (e.g. `{ kind: 'create' }`)
 * - Named operations return `{ kind: 'operation', name: '<opName>' }`
 *
 * @param opName - The operation name to map.
 * @returns A discriminated {@link PolicyAction} union member.
 *
 * @example
 * ```ts
 * buildPolicyAction('create');   // { kind: 'create' }
 * buildPolicyAction('publish');  // { kind: 'operation', name: 'publish' }
 * ```
 */
export function buildPolicyAction(opName: string): PolicyAction {
  const entry = resolveOperationKind(opName);
  if (entry.kind === 'operation') {
    return { kind: 'operation', name: opName };
  }
  return { kind: entry.kind };
}
