import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type {
  EntityRoutePolicyConfig,
  PolicyAction,
  PolicyDecision,
  PolicyResolver,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import { getActor } from '@lastshotlabs/slingshot-core';

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
 * @throws {HTTPException} 403 or 404 on deny, 500 on missing userId or resolver error.
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
      message: `policy resolver '${config.resolver}' threw: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const decision: PolicyDecision = typeof raw === 'boolean' ? { allow: raw } : raw;

  if (decision.allow) return;

  const status = decision.status ?? (config.leakSafe ? 404 : 403);

  // Emit denial event for audit — not awaited.
  if (bus) {
    (bus as unknown as { emit(key: string, payload: unknown): void }).emit('entity:policy.denied', {
      resolverKey: config.resolver,
      action,
      userId: actor.id,
      reason: decision.reason,
    });
  }

  throw new HTTPException(status, {
    message: status === 404 ? 'Not Found' : 'Forbidden',
  });
}

/** Standard CRUD operation names. */
const CRUD_OPS = new Set(['create', 'list', 'get', 'update', 'delete']);

/**
 * Check whether a policy config applies to a given operation.
 *
 * When `applyTo` is not set, the policy applies to all operations.
 * Otherwise, CRUD ops match directly and named ops match as `operation:<name>`.
 */
export function policyAppliesToOp(config: EntityRoutePolicyConfig, opName: string): boolean {
  const applyTo = config.applyTo;
  if (!applyTo) return true;
  const normalized = CRUD_OPS.has(opName) ? opName : `operation:${opName}`;
  return applyTo.includes(normalized);
}

/**
 * Map an operation name string to a structured `PolicyAction`.
 */
export function buildPolicyAction(opName: string): PolicyAction {
  switch (opName) {
    case 'create':
      return { kind: 'create' };
    case 'list':
      return { kind: 'list' };
    case 'get':
      return { kind: 'get' };
    case 'update':
      return { kind: 'update' };
    case 'delete':
      return { kind: 'delete' };
    default:
      return { kind: 'operation', name: opName };
  }
}
