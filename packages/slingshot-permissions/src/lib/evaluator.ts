import type {
  EvaluationScope,
  GroupResolver,
  PermissionEvaluator,
  PermissionGrant,
  PermissionRegistry,
  PermissionsAdapter,
  SubjectRef,
} from '@lastshotlabs/slingshot-core';
import { SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';

/**
 * Health snapshot describing the evaluator's recent error and timeout activity.
 * Returned from `EvaluatorWithHealth.getHealth()`.
 *
 * All fields are cumulative counters since evaluator creation; consumers track
 * deltas to compute rates if needed.
 */
export interface EvaluatorHealth {
  /** Total `PermissionQueryTimeoutError` rejections observed since creation. */
  readonly queryTimeoutCount: number;
  /** Total group-expansion failures observed since creation. */
  readonly groupExpansionErrorCount: number;
  /** Wall-clock timestamp (ms) of the most recent timeout, or `null`. */
  readonly lastQueryTimeoutAt: number | null;
  /** Wall-clock timestamp (ms) of the most recent group-expansion error, or `null`. */
  readonly lastGroupExpansionErrorAt: number | null;
}

/** Evaluator augmented with a `getHealth()` snapshot accessor. */
export interface EvaluatorWithHealth extends PermissionEvaluator {
  /** Cheap, non-blocking observability snapshot. Safe to call from a health endpoint. */
  getHealth(): EvaluatorHealth;
}

/**
 * Minimal logger interface used by the evaluator for structured warn/error output.
 *
 * Defaults to `console`. Inject a custom logger (e.g. pino, bunyan, slog) to capture
 * evaluator diagnostics in your application's structured logging pipeline.
 */
export interface EvaluatorLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
}

/**
 * Structured error thrown when an adapter query exceeds `queryTimeoutMs`.
 *
 * Carries `adapter`, `scope`, and `subjectId` context so operators can identify
 * which call timed out without parsing log strings.
 */
export class PermissionQueryTimeoutError extends Error {
  readonly adapter: string;
  readonly scope: EvaluationScope | undefined;
  readonly subjectId: string | undefined;
  readonly timeoutMs: number;

  constructor(
    message: string,
    context: {
      adapter: string;
      scope?: EvaluationScope;
      subjectId?: string;
      timeoutMs: number;
    },
  ) {
    super(message);
    this.name = 'PermissionQueryTimeoutError';
    this.adapter = context.adapter;
    this.scope = context.scope;
    this.subjectId = context.subjectId;
    this.timeoutMs = context.timeoutMs;
  }
}

/**
 * One element of the failure list passed to `onGroupExpansionError`.
 */
export interface GroupExpansionFailure {
  groupId: string;
  userId: string;
  reason: unknown;
}

interface EvaluatorConfig {
  registry: PermissionRegistry;
  adapter: PermissionsAdapter;
  groupResolver?: GroupResolver;
  /**
   * Maximum number of groups to process per batch when expanding a user's groups.
   *
   * Group expansion is no longer truncated. When a user belongs to more groups than this
   * batch size, the evaluator processes them in chunks and emits a console.warn so the
   * operator can see that permission checks are doing a large amount of work. Defaults
   * to 50.
   *
   * Set this to a value appropriate for your group model. A lower batch size reduces
   * peak concurrency; a higher batch size reduces round trips.
   */
  maxGroups?: number;
  /**
   * Maximum time in milliseconds to wait for each adapter query before rejecting.
   *
   * When set, `can()` races each call to `adapter.getEffectiveGrantsForSubject` and
   * `groupResolver.getGroupsForUser` against a timeout promise. If the query does not
   * resolve within `queryTimeoutMs`, the call rejects with a `PermissionQueryTimeoutError`
   * that carries `{ adapter, scope, subjectId, timeoutMs }` context.
   *
   * Not set by default. The SQLite adapter runs synchronously via `Promise.resolve` and
   * will not actually hang, so this option primarily guards the Postgres adapter and any
   * custom async adapters. Set to a value such as `3000` (3 s) in production to prevent a
   * slow DB from blocking all permission checks indefinitely.
   */
  queryTimeoutMs?: number;
  /**
   * Injected logger for structured warn/error output. Defaults to `console`.
   */
  logger?: EvaluatorLogger;
  /**
   * Sample rate for non-critical `warn` output (range `(0, 1]`). Defaults to `0.01`
   * (1% of warnings are emitted) so that production environments do not flood logs
   * under high QPS. Set to `1` to emit every warning (useful for tests and
   * development). Group-expansion failure warnings are NOT controlled by this rate;
   * see `onGroupExpansionErrorSampleRate`. The unscoped-resourceType warning and the
   * large-group-batch warning are sampled by this rate.
   */
  warnSampleRate?: number;
  /**
   * Sample rate for the `onGroupExpansionError` callback and its corresponding warn
   * log (range `(0, 1]`). Defaults to `0.05` (5%). Group-expansion failures fire on
   * every adapter error during group fan-out, which under sustained adapter outage
   * can otherwise generate one callback invocation per request. The error counters
   * exposed via `getHealth()` are updated regardless of sampling so that operators
   * always see the true failure count.
   */
  onGroupExpansionErrorSampleRate?: number;
  /**
   * Optional callback invoked when one or more group-grant fetches fail during
   * group expansion. Receives the full list of failures for the call. The evaluator
   * still proceeds with whatever grants it managed to collect — this hook gives the
   * caller visibility, not control. The callback is sampled at
   * `onGroupExpansionErrorSampleRate` (default `0.05`).
   */
  onGroupExpansionError?: (failures: GroupExpansionFailure[]) => void;
}

function grantMatchesScope(grant: PermissionGrant, scope?: EvaluationScope): boolean {
  // Global grant - always applies.
  if (grant.tenantId === null && grant.resourceType === null && grant.resourceId === null) {
    return true;
  }

  const tenantId = scope?.tenantId;
  if (tenantId === undefined || grant.tenantId !== tenantId) {
    return false;
  }

  // Tenant-wide grant.
  if (grant.resourceType === null && grant.resourceId === null) {
    return true;
  }

  const resourceType = scope?.resourceType;
  if (resourceType === undefined || grant.resourceType !== resourceType) {
    return false;
  }

  // Resource-type-wide grant.
  if (grant.resourceId === null) {
    return true;
  }

  const resourceId = scope?.resourceId;
  return resourceId !== undefined && grant.resourceId === resourceId;
}

interface TimeoutContext {
  adapter: string;
  scope?: EvaluationScope;
  subjectId?: string;
}

function withQueryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context: TimeoutContext,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const timedPromise = promise.finally(clear);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const scopeDesc =
        context.scope === undefined
          ? '(none)'
          : JSON.stringify({
              tenantId: context.scope.tenantId,
              resourceType: context.scope.resourceType,
              resourceId: context.scope.resourceId,
            });
      reject(
        new PermissionQueryTimeoutError(
          `[slingshot-permissions] Permission query timed out after ${timeoutMs}ms ` +
            `(adapter='${context.adapter}', subjectId='${context.subjectId ?? '(none)'}', scope=${scopeDesc})`,
          {
            adapter: context.adapter,
            scope: context.scope,
            subjectId: context.subjectId,
            timeoutMs,
          },
        ),
      );
    }, timeoutMs);
  }).finally(clear);

  return Promise.race([timedPromise, timeoutPromise]).finally(clear);
}

/**
 * Creates a `PermissionEvaluator` that resolves whether a subject can perform an action.
 *
 * The evaluator implements a deny-wins cascade model:
 * 1. Collect all active grants for the subject (and their groups if `groupResolver` is set).
 * 2. Apply scope matching — global → tenant → resource-type → specific resource.
 * 3. If any deny grant covers the action, return `false` immediately.
 * 4. If any allow grant covers the action, return `true`.
 * 5. Default-deny: return `false`.
 *
 * @param config - Registry, adapter, and optional group resolver.
 * @returns A `PermissionEvaluator` with a single `can()` method.
 *
 * @example
 * ```ts
 * import {
 *   createPermissionRegistry,
 *   createMemoryPermissionsAdapter,
 *   createPermissionEvaluator,
 * } from '@lastshotlabs/slingshot-permissions';
 *
 * const registry = createPermissionRegistry();
 * registry.register({ resourceType: 'posts', roles: { editor: ['read', 'write'] } });
 *
 * const adapter = createMemoryPermissionsAdapter();
 * const evaluator = createPermissionEvaluator({ registry, adapter });
 *
 * const allowed = await evaluator.can(
 *   { subjectId: 'user-1', subjectType: 'user' },
 *   'write',
 *   { tenantId: 'tenant-1', resourceType: 'posts' },
 * );
 * ```
 */
export function createPermissionEvaluator(config: EvaluatorConfig): EvaluatorWithHealth {
  const { registry, adapter, groupResolver } = config;
  const maxGroups = config.maxGroups ?? 50;
  const { queryTimeoutMs } = config;
  const logger: EvaluatorLogger = config.logger ?? console;
  const warnSampleRate = config.warnSampleRate ?? 0.01;
  const onGroupExpansionErrorSampleRate = config.onGroupExpansionErrorSampleRate ?? 0.05;
  const { onGroupExpansionError } = config;

  // Health-only counters. Updated from existing operation paths so calling
  // getHealth() never performs I/O or blocks.
  let queryTimeoutCount = 0;
  let groupExpansionErrorCount = 0;
  let lastQueryTimeoutAt: number | null = null;
  let lastGroupExpansionErrorAt: number | null = null;

  if (maxGroups <= 0) {
    throw new Error('[slingshot-permissions] maxGroups must be a positive number');
  }
  if (queryTimeoutMs !== undefined && queryTimeoutMs <= 0) {
    throw new Error('[slingshot-permissions] queryTimeoutMs must be a positive number');
  }
  if (warnSampleRate <= 0 || warnSampleRate > 1) {
    throw new Error('[slingshot-permissions] warnSampleRate must be in the range (0, 1]');
  }
  if (onGroupExpansionErrorSampleRate <= 0 || onGroupExpansionErrorSampleRate > 1) {
    throw new Error(
      '[slingshot-permissions] onGroupExpansionErrorSampleRate must be in the range (0, 1]',
    );
  }

  // Best-effort identifier for the adapter implementation. Falls back to 'unknown'
  // when the adapter is created without a recognizable constructor name.
  const adapterName = (adapter as { name?: string }).name ?? adapter.constructor?.name ?? 'unknown';

  function shouldEmitSampledWarn(): boolean {
    if (warnSampleRate >= 1) return true;
    return Math.random() < warnSampleRate;
  }

  function shouldEmitSampledGroupExpansionError(): boolean {
    if (onGroupExpansionErrorSampleRate >= 1) return true;
    return Math.random() < onGroupExpansionErrorSampleRate;
  }

  function maybeWithTimeout<T>(
    promise: Promise<T>,
    operation: string,
    subject: SubjectRef,
    scope: EvaluationScope | undefined,
  ): Promise<T> {
    if (queryTimeoutMs === undefined) return promise;
    return withQueryTimeout(promise, queryTimeoutMs, {
      adapter: `${adapterName}.${operation}`,
      scope,
      subjectId: subject.subjectId,
    }).catch((err: unknown) => {
      if (err instanceof PermissionQueryTimeoutError) {
        queryTimeoutCount += 1;
        lastQueryTimeoutAt = Date.now();
      }
      throw err;
    });
  }

  async function collectGrantsForSubject(
    subject: SubjectRef,
    scope?: EvaluationScope,
  ): Promise<PermissionGrant[]> {
    return maybeWithTimeout(
      adapter.getEffectiveGrantsForSubject(subject.subjectId, subject.subjectType, scope),
      'getEffectiveGrantsForSubject',
      subject,
      scope,
    );
  }

  return {
    async can(subject: SubjectRef, action: string, scope?: EvaluationScope): Promise<boolean> {
      // Collect grants for the subject
      let grants = await collectGrantsForSubject(subject, scope);

      // Group expansion for users — fetch all groups concurrently
      if (subject.subjectType === 'user' && groupResolver) {
        const tenantId = scope?.tenantId ?? null;
        const allGroupIds = await maybeWithTimeout(
          groupResolver.getGroupsForUser(subject.subjectId, tenantId),
          'groupResolver.getGroupsForUser',
          subject,
          scope,
        );
        if (allGroupIds.length > maxGroups && shouldEmitSampledWarn()) {
          logger.warn(
            `[slingshot-permissions] evaluator.can() is expanding ${allGroupIds.length} groups for user '${subject.subjectId}' in batches of ${maxGroups}: ` +
              `action='${action}', tenantId=${scope?.tenantId ?? '(none)'}. ` +
              `Increase maxGroups in createPermissionEvaluator() config to raise the batch size if needed.`,
            {
              adapter: adapterName,
              event: 'group_expansion_batched',
              userId: subject.subjectId,
              action,
              groupCount: allGroupIds.length,
              maxGroups,
              scope,
            },
          );
        }
        const failures: GroupExpansionFailure[] = [];
        for (let i = 0; i < allGroupIds.length; i += maxGroups) {
          const groupIds = allGroupIds.slice(i, i + maxGroups);
          if (groupIds.length === 0) continue;
          const groupGrantResults = await Promise.allSettled(
            groupIds.map(groupId =>
              collectGrantsForSubject({ subjectId: groupId, subjectType: 'group' }, scope),
            ),
          );
          for (let j = 0; j < groupGrantResults.length; j++) {
            const result = groupGrantResults[j];
            if (result.status === 'fulfilled') {
              grants = grants.concat(result.value);
            } else {
              failures.push({
                groupId: groupIds[j],
                userId: subject.subjectId,
                reason: result.reason,
              });
            }
          }
        }
        if (failures.length > 0) {
          // Counters always update so `getHealth()` reflects the true failure rate
          // regardless of sampling. The warn log and callback are sampled at
          // `onGroupExpansionErrorSampleRate` (default 0.05) to avoid flooding
          // operators when an adapter is down and every request fails the same way.
          groupExpansionErrorCount += failures.length;
          lastGroupExpansionErrorAt = Date.now();
          if (shouldEmitSampledGroupExpansionError()) {
            const first = failures[0];
            const firstReasonMessage =
              first.reason instanceof Error ? first.reason.message : String(first.reason);
            logger.warn(
              `[slingshot-permissions] evaluator.can() failed to fetch grants for ${failures.length} group(s) ` +
                `(user '${subject.subjectId}', first failure on group '${first.groupId}': ${firstReasonMessage}). ` +
                `Proceeding with partial grants.`,
              {
                adapter: adapterName,
                event: 'group_expansion_error',
                userId: subject.subjectId,
                action,
                scope,
                failureCount: failures.length,
                failures: failures.map(f => ({
                  groupId: f.groupId,
                  reason: f.reason instanceof Error ? f.reason.message : String(f.reason),
                })),
              },
            );
            if (onGroupExpansionError) {
              try {
                onGroupExpansionError(failures);
              } catch (cbErr) {
                logger.warn(
                  `[slingshot-permissions] onGroupExpansionError callback threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
                  {
                    adapter: adapterName,
                    event: 'group_expansion_error_callback_threw',
                    userId: subject.subjectId,
                  },
                );
              }
            }
          }
        }
      }

      // Safety net: adapters already filter revoked/expired at query level,
      // but we guard here in case a caller passes grants from an external source.
      const now = new Date();
      const activeGrants = grants.filter(g => {
        if (g.revokedAt) return false;
        if (g.expiresAt && g.expiresAt < now) return false;
        if (!grantMatchesScope(g, scope)) return false;
        return true;
      });

      const resourceType = scope?.resourceType ?? '';

      if (!resourceType && activeGrants.length > 0 && shouldEmitSampledWarn()) {
        logger.warn(
          `[slingshot-permissions] evaluator.can('${action}') called without scope.resourceType — ` +
            "registry lookup uses '' which matches no registered type. " +
            "Add scope: { resourceType: 'your-type' } to the permission config or can() call.",
          {
            adapter: adapterName,
            event: 'missing_resource_type_scope',
            userId: subject.subjectId,
            action,
            scope,
          },
        );
      }

      // Separate allow and deny grants
      const denyGrants = activeGrants.filter(g => g.effect === 'deny');
      const allowGrants = activeGrants.filter(g => g.effect === 'allow');

      // Super-admin early exit — evaluated before deny so it cannot be blocked.
      // Super-admin is the system's ultimate authority; deny grants apply only to
      // named roles, not to the super-admin principal itself.
      for (const grant of allowGrants) {
        if (grant.roles.includes(SUPER_ADMIN_ROLE)) return true;
      }

      // CRITICAL: deny always wins for all non-super-admin roles
      for (const grant of denyGrants) {
        for (const role of grant.roles) {
          const actions = registry.getActionsForRole(resourceType, role);
          if (actions.includes('*') || actions.includes(action)) {
            return false;
          }
        }
      }

      // Check allow grants
      for (const grant of allowGrants) {
        for (const role of grant.roles) {
          const actions = registry.getActionsForRole(resourceType, role);
          if (actions.includes('*') || actions.includes(action)) {
            return true;
          }
        }
      }

      return false;
    },
    getHealth(): EvaluatorHealth {
      return {
        queryTimeoutCount,
        groupExpansionErrorCount,
        lastQueryTimeoutAt,
        lastGroupExpansionErrorAt,
      };
    },
  };
}
