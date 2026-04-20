export interface AuthLoggerConfig {
  verbose?: boolean;
  authTrace?: boolean;
}

export interface AuthLogger {
  log: (...args: unknown[]) => void;
  authTrace: (...args: unknown[]) => void;
}

/**
 * Returns whether verbose (non-production) logging is enabled.
 *
 * Falls back to `LOGGING_VERBOSE` / non-production mode when no per-app config
 * is provided.
 */
function isVerbose(config?: AuthLoggerConfig): boolean {
  if (config?.verbose !== undefined) return config.verbose;
  const v = process.env.LOGGING_VERBOSE;
  return v !== undefined ? v === 'true' : process.env.NODE_ENV !== 'production';
}

/**
 * Returns whether auth trace logging is enabled.
 *
 * Falls back to `LOGGING_AUTH_TRACE === "true"` when no per-app config is
 * provided. Trace logs are also suppressed when verbose logging is disabled.
 */
function isAuthTrace(config?: AuthLoggerConfig): boolean {
  if (!isVerbose(config)) return false;
  if (config?.authTrace !== undefined) return config.authTrace;
  return process.env.LOGGING_AUTH_TRACE === 'true';
}

/**
 * Build an instance-scoped auth logger.
 *
 * Plugins pass the resolved framework logging policy here so auth logging
 * follows app config instead of relying solely on process-wide env vars.
 */
export function createAuthLogger(config: AuthLoggerConfig = {}): AuthLogger {
  return {
    log(...args: unknown[]) {
      if (isVerbose(config)) console.log(...args);
    },
    authTrace(...args: unknown[]) {
      if (isAuthTrace(config)) console.log(...args);
    },
  };
}
