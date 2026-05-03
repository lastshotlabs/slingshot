/**
 * Minimal structured logger for the orchestration package.
 *
 * This package is framework-agnostic and must not depend on slingshot-core.
 * A small in-tree logger covers the fallback paths where structured output
 * is needed without pulling in the full framework.
 */

export interface OrchestrationLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function formatLine(level: string, msg: string, fields?: Record<string, unknown>): string {
  return JSON.stringify({
    level,
    timestamp: new Date().toISOString(),
    component: 'slingshot-orchestration',
    msg,
    ...(fields ?? {}),
  });
}

export function createOrchestrationLogger(): OrchestrationLogger {
  return {
    warn(msg, fields) {
      console.warn(formatLine('warn', msg, fields));
    },
    error(msg, fields) {
      console.error(formatLine('error', msg, fields));
    },
  };
}

/** Shared singleton for use across the package. */
export const logger: OrchestrationLogger = createOrchestrationLogger();
