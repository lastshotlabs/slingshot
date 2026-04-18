/**
 * WebSocket scaling diagnostics — pure helper that inspects a runtime app
 * config and returns scaling-related warnings/infos.
 *
 * Designed to be merged into the output of `slingshot infra check`. The function
 * is stateless and has no side effects.
 */
import { deepFreeze } from './deepFreeze';

// ---------------------------------------------------------------------------
// Input types — minimal shape of the app config fields we inspect
// ---------------------------------------------------------------------------

interface WsEndpointShape {
  presence?: boolean | { broadcastEvents?: boolean };
}

interface WsConfigShape {
  endpoints?: Record<string, WsEndpointShape>;
  transport?: unknown;
}

interface DbConfigShape {
  cache?: string;
  sessions?: string;
}

interface AppConfigShape {
  ws?: WsConfigShape;
  db?: DbConfigShape;
}

// ---------------------------------------------------------------------------
// Diagnostic types
// ---------------------------------------------------------------------------

/**
 * Severity level of a WebSocket scaling diagnostic.
 *
 * - `'info'`: the configuration will work but will not scale beyond a single
 *   instance without changes.
 * - `'warning'`: the configuration is likely incorrect at any scale
 *   (e.g. memory cache with a cross-instance transport).
 */
export type WsDiagnosticSeverity = 'info' | 'warning';

/**
 * A single WebSocket scaling diagnostic entry.
 *
 * Each diagnostic is frozen on creation (see rule 12 — freeze at the boundary).
 */
export interface WsDiagnostic {
  /**
   * Stable machine-readable identifier for the diagnostic rule.
   *
   * Used by consumers to suppress or highlight specific checks. Current values:
   * - `'ws:no-transport'` — WebSocket endpoints configured but no cross-instance transport.
   * - `'ws:presence-no-transport'` — Presence enabled without a transport.
   * - `'ws:memory-cache-multi-instance'` — Memory cache with a transport (multi-instance intent).
   * - `'ws:memory-sessions-multi-instance'` — Memory sessions with a transport.
   */
  readonly id: string;
  /**
   * Severity level of this diagnostic.
   * See {@link WsDiagnosticSeverity} for semantics.
   */
  readonly severity: WsDiagnosticSeverity;
  /**
   * Human-readable description of the detected issue.
   * Suitable for direct display in CLI output without further formatting.
   */
  readonly message: string;
  /**
   * Actionable suggestion for resolving the issue.
   * Includes the specific config change or API call needed to fix the problem.
   */
  readonly suggestion: string;
}

/**
 * The result of a WebSocket scaling audit, as returned by
 * `auditWebsocketScaling()`.
 *
 * The entire result object is deep-frozen before being returned.
 */
export interface WsScalingAuditResult {
  /**
   * Ordered list of WebSocket scaling diagnostics.
   *
   * Empty (`[]`) when no issues are detected. Diagnostics are ordered by
   * the rule that emitted them (see `auditWebsocketScaling` detection rules).
   * The array and each element are deep-frozen before being returned.
   */
  readonly diagnostics: readonly WsDiagnostic[];
}

// ---------------------------------------------------------------------------
// Audit implementation
// ---------------------------------------------------------------------------

/**
 * Inspect a runtime app config and return WebSocket scaling diagnostics.
 *
 * This is a pure function with no side effects. It is designed to be merged
 * into the output of `slingshot infra check`.
 *
 * Detection rules:
 * - WS endpoints configured but no transport → `info` (instance-local delivery).
 * - Presence enabled without a transport → `info` (instance-local presence).
 * - Transport configured but `db.cache === 'memory'` → `warning`.
 * - Transport configured but `db.sessions === 'memory'` → `warning`.
 *
 * @param config - A runtime app config object. Only `ws` and `db` sub-keys are
 *   inspected; all other keys are ignored.
 * @returns A deep-frozen `WsScalingAuditResult`.
 *
 * @example
 * ```ts
 * import { auditWebsocketScaling } from '@lastshotlabs/slingshot-infra';
 *
 * const result = auditWebsocketScaling(appConfig);
 * for (const diag of result.diagnostics) {
 *   console.log(`[${diag.severity}] ${diag.message}`);
 * }
 * ```
 */
export function auditWebsocketScaling(config: AppConfigShape): WsScalingAuditResult {
  const diagnostics: WsDiagnostic[] = [];

  const ws = config.ws;
  if (!ws?.endpoints) {
    return deepFreeze({ diagnostics: [] });
  }

  const endpointNames = Object.keys(ws.endpoints);
  if (endpointNames.length === 0) {
    return deepFreeze({ diagnostics: [] });
  }

  const hasTransport = ws.transport != null;

  // Rule 1: WS endpoints without cross-instance transport
  if (!hasTransport) {
    diagnostics.push({
      id: 'ws:no-transport',
      severity: 'info',
      message: `${endpointNames.length} WebSocket endpoint(s) configured without a cross-instance transport. Messages are delivered to local clients only.`,
      suggestion:
        'Add ws.transport using createRedisTransport() before scaling to multiple instances.',
    });
  }

  // Rule 2: Presence without transport
  if (!hasTransport) {
    const presenceEndpoints = Object.entries(ws.endpoints)
      .filter(([, endpoint]) => endpoint.presence != null && endpoint.presence !== false)
      .map(([name]) => name);

    if (presenceEndpoints.length > 0) {
      diagnostics.push({
        id: 'ws:presence-no-transport',
        severity: 'info',
        message: `Presence is enabled on ${presenceEndpoints.join(', ')} but no transport is configured. Presence data is instance-local — users on different instances won't see each other.`,
        suggestion:
          'Add ws.transport using createRedisTransport() for cross-instance presence visibility.',
      });
    }
  }

  // Rule 3: Memory cache with multi-instance intent (transport configured)
  if (hasTransport && config.db?.cache === 'memory') {
    diagnostics.push({
      id: 'ws:memory-cache-multi-instance',
      severity: 'warning',
      message:
        'Cache is set to "memory" but a WebSocket transport is configured, suggesting multiple instances. Each instance will have its own cache, leading to inconsistent responses.',
      suggestion: 'Switch cache to "redis" for shared caching across instances.',
    });
  }

  // Rule 4: Memory sessions with multi-instance intent (transport configured)
  if (hasTransport && config.db?.sessions === 'memory') {
    diagnostics.push({
      id: 'ws:memory-sessions-multi-instance',
      severity: 'warning',
      message:
        'Sessions are set to "memory" but a WebSocket transport is configured, suggesting multiple instances. Users will lose sessions when requests hit a different instance.',
      suggestion: 'Switch sessions to "redis" for shared sessions across instances.',
    });
  }

  return deepFreeze({ diagnostics });
}
