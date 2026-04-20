import type { LogLevel, RequestLogEntry } from '@framework/middleware/requestLogger';

export interface LoggingConfig {
  /** Enable structured request logging. Default: true. When false, no logger is registered at all. */
  enabled?: boolean;
  /**
   * Enable non-request diagnostic console logging from framework and plugin helpers.
   *
   * Defaults to `false` when `enabled` is `false`; otherwise falls back to
   * `LOGGING_VERBOSE` or `NODE_ENV !== "production"`.
   */
  verbose?: boolean;
  /**
   * Enable auth trace lines that may include user or session identifiers.
   *
   * Defaults to `false` when verbose logging is disabled; otherwise falls back
   * to `LOGGING_AUTH_TRACE === "true"`.
   */
  authTrace?: boolean;
  /**
   * Emit non-fatal audit-log provider warnings such as in-memory store caveats.
   *
   * Defaults to the resolved `verbose` setting.
   */
  auditWarnings?: boolean;
  /** Custom log handler. Default: `console.log(JSON.stringify(entry))`. */
  onLog?: (entry: RequestLogEntry) => void | Promise<void>;
  /** Minimum log level to emit. Entries below this level are dropped. */
  level?: LogLevel;
  /**
   * Paths to exclude from logging. Strings use **prefix matching**.
   * Default: `["/health", "/docs", "/openapi.json"]`.
   */
  excludePaths?: (string | RegExp)[];
  /** HTTP methods to exclude from logging (e.g. `["OPTIONS"]`). */
  excludeMethods?: string[];
}

export interface ResolvedLoggingConfig {
  /** Whether the HTTP request logger middleware should be mounted. */
  enabled: boolean;
  /** Whether non-request diagnostic logging is enabled. */
  verbose: boolean;
  /** Whether auth trace logging is enabled. */
  authTrace: boolean;
  /** Whether audit-log provider warnings are emitted. */
  auditWarnings: boolean;
}

function envVerboseEnabled(): boolean {
  const value = process.env.LOGGING_VERBOSE;
  return value !== undefined ? value === 'true' : process.env.NODE_ENV !== 'production';
}

function envAuthTraceEnabled(): boolean {
  return process.env.LOGGING_AUTH_TRACE === 'true';
}

export function resolveLoggingConfig(config?: LoggingConfig): ResolvedLoggingConfig {
  const enabled = config?.enabled !== false;
  const verbose = config?.verbose ?? (enabled ? envVerboseEnabled() : false);
  const authTrace = config?.authTrace ?? (verbose && envAuthTraceEnabled());
  const auditWarnings = config?.auditWarnings ?? verbose;

  return {
    enabled,
    verbose,
    authTrace,
    auditWarnings,
  };
}
